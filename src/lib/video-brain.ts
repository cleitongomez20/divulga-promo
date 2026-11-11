import { z } from 'zod';
import { assembleCaption, checkCaption, extractJson, normalizeHashtags, type ProductCandidate } from './content-brain';

export const VIDEO_FORMATS = ['reel', 'story'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export const VIDEO_FORMAT_LABELS: Record<VideoFormat, string> = { reel: 'Reels', story: 'Story' };

export const CAMERA_MOVEMENTS = ['dolly_in', 'dolly_out', 'dolly_left', 'dolly_right', 'jib_up', 'jib_down', 'static', 'focus_shift'] as const;
export type VideoToolId = 'kling_2_6' | 'ltx_2_5';
export type VideoTool = { id: VideoToolId; endpoint: string; label: string; strengths: string; durations: readonly number[]; estimateUsdPerSecond: number; camera: boolean };

/**
 * The tools the AI may choose from. The endpoints and parameters come from the Higgsfield API documentation (image to video, 9:16, MP4 with sound).
 * `estimateUsdPerSecond` is a deliberately cautious budgeting estimate; the real charge is shown in the Higgsfield Console.
 */
export const VIDEO_TOOLS: Record<VideoToolId, VideoTool> = {
  kling_2_6: { id: 'kling_2_6', endpoint: 'kling-video/v2.6/pro/image-to-video', label: 'Kling 2.6 Pro', strengths: 'movimento natural e fluido, bom para mostrar o produto em uso; é a opção mais econômica', durations: [5, 10], estimateUsdPerSecond: 0.1, camera: false },
  ltx_2_5: { id: 'ltx_2_5', endpoint: 'lightricks/ltx-2.5/image-to-video/pro', label: 'LTX 2.5 Pro', strengths: 'controle de câmera (aproximar, afastar, subir, girar) e boa nitidez; custa mais por segundo', durations: [6, 8, 10], estimateUsdPerSecond: 0.17, camera: true },
};
export const VIDEO_TOOL_IDS = Object.keys(VIDEO_TOOLS) as [VideoToolId, ...VideoToolId[]];
export const estimateVideoMicros = (tool: VideoTool, seconds: number) => Math.round(tool.estimateUsdPerSecond * seconds * 1_000_000);

/** Videos being made at the same time for one user. */
export const MAX_CONCURRENT_VIDEOS = 2;
/** A video that is still not ready after this long is given up on. */
export const VIDEO_STUCK_MS = 25 * 60_000;
/** A post created but never confirmed by Higgsfield is given up on after this long. */
export const VIDEO_UNSENT_MS = 10 * 60_000;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // the storage limit

export function buildVideoPrompt(format: VideoFormat, candidates: readonly ProductCandidate[]): { system: string; user: string } {
  const catalog = VIDEO_TOOL_IDS.map(id => {
    const tool = VIDEO_TOOLS[id];
    return `- ${id} (${tool.label}): ${tool.strengths}. Durações permitidas: ${tool.durations.join(', ')} segundos. Custo estimado: US$ ${tool.estimateUsdPerSecond.toFixed(2)} por segundo.${tool.camera ? ` Aceita movimento de câmera: ${CAMERA_MOVEMENTS.join(', ')}.` : ''}`;
  }).join('\n');
  const system = [
    'Você é o diretor de conteúdo de uma conta brasileira de Instagram que indica produtos da Shopee como afiliada.',
    `Sua tarefa: escolher UM produto da lista e dirigir um vídeo curto vertical (9:16) para ${format === 'reel' ? 'um Reels' : 'um Story'}.`,
    'O vídeo é feito a partir da foto real do produto, usada como primeiro quadro. Você escolhe a ferramenta de vídeo, a duração e escreve a "ordem de filmagem".',
    '',
    'Ferramentas de vídeo disponíveis:',
    catalog,
    '',
    'Como escolher: prefira a ferramenta mais econômica que cumpra o objetivo e a duração mais curta que funcione (em geral 5 a 6 segundos para Story e 6 a 10 para Reels). Use a LTX só quando o movimento de câmera for o ponto principal.',
    '',
    'Como escrever a ordem de filmagem (campo video_prompt), em inglês, em 1 a 3 frases:',
    '- A foto original do produto é quadrada e o vídeo é vertical: descreva o cenário e o fundo de modo que o produto apareça INTEIRO, centralizado e sem ser alterado (mesma forma, cor e rótulo).',
    '- Descreva um movimento de câmera suave e uma ação realista e simples, que valorize o produto.',
    '- Não peça texto na tela, preços, descontos, logotipos de outras marcas, links nem hashtags.',
    '',
    'Regras que nunca podem ser quebradas, valem para o vídeo e para a legenda:',
    '- Use somente o que está no nome do produto. Não invente medidas, materiais, funções, marcas, garantias nem resultados.',
    '- Nunca escreva preço, desconto, porcentagem, número de vendas, nota ou comissão. Esses dados são só para você escolher.',
    '- Nunca crie urgência ou escassez falsa ("últimas unidades", "só hoje", "estoque acabando", "promoção relâmpago", prazos).',
    '- Nunca prometa cura, emagrecimento ou resultado garantido.',
    '- Tom da legenda: amiga indicando uma descoberta, português do Brasil, informal e leve, frases curtas, no máximo 3 emojis. Sem link, sem hashtags e sem chamada para comentar no texto: o sistema acrescenta isso.',
    format === 'reel' ? '- A legenda tem de 3 a 6 linhas curtas; a primeira é o gancho (até 90 caracteres) e a legenda começa com ele.' : '- Story não tem legenda: deixe o campo caption como texto vazio "" e escreva o gancho em hook, só para registro.',
    '',
    'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem blocos de código, neste formato:',
    `{"chosen_product_id":"<id exato da lista>","reason":"<por que este produto, em 1 ou 2 frases, só com os dados da lista>","angle":"<o ângulo em poucas palavras>","hook":"<o gancho>","caption":"<a legenda completa ou vazia>","hashtags":["#..."],"tool":"<${VIDEO_TOOL_IDS.join(' ou ')}>","duration":<segundos permitidos para a ferramenta>,"sound":<true ou false>,"camera_movement":<um movimento permitido ou null>,"video_prompt":"<a ordem de filmagem em inglês>"}`,
    format === 'reel' ? 'Use de 5 a 10 hashtags em português, relevantes ao produto.' : 'Em Story, hashtags pode ser uma lista vazia [].',
  ].join('\n');
  const list = candidates.map(item => ({ id: item.id, nome: item.title, preco_reais: item.price, comissao_percentual: item.commission === null ? null : Math.round(item.commission * 1000) / 10, vendas: item.sales, nota: item.rating }));
  return { system, user: `Produtos disponíveis (escolha um):\n${JSON.stringify(list, null, 1)}` };
}

export const videoOutputSchema = z.object({
  chosen_product_id: z.string().min(1),
  reason: z.string().trim().min(10).max(500),
  angle: z.string().trim().min(2).max(120),
  hook: z.string().trim().min(5).max(140),
  caption: z.string().trim().max(1200).default(''),
  hashtags: z.array(z.string()).max(20).default([]),
  tool: z.enum(VIDEO_TOOL_IDS),
  duration: z.number().int(),
  sound: z.boolean().default(true),
  camera_movement: z.enum(CAMERA_MOVEMENTS).nullable().default(null),
  video_prompt: z.string().trim().min(30).max(900),
});
export type VideoOutput = z.infer<typeof videoOutputSchema>;

const VIDEO_PROMPT_RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /R\$|\$\s*\d|\d\s*%|\b(sale|discount|off|promo|promotion|coupon)\b/i, message: 'a ordem de filmagem fala de preço, desconto ou promoção' },
  { pattern: /https?:\/\/|www\.|\.com\b|#\p{L}/u, message: 'a ordem de filmagem tem link ou hashtag' },
  { pattern: /\b(text overlay|on-screen text|subtitles?|captions?|watermark|logo)\b/i, message: 'a ordem de filmagem pede texto, legenda ou logotipo na tela' },
];

export type VideoVerdict = { ok: true; output: VideoOutput } | { ok: false; problems: string[] };
/** Reads the AI's answer and checks every rule. The problems are written so they can be sent back to the AI as feedback. */
export function judgeVideoAnswer(text: string, format: VideoFormat, candidateIds: ReadonlySet<string>): VideoVerdict {
  const json = extractJson(text);
  if (!json) return { ok: false, problems: ['a resposta não é um objeto JSON válido'] };
  const parsed = videoOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issue => `campo ${issue.path.join('.') || 'resposta'}: ${issue.message}`).slice(0, 5) };
  const output = parsed.data; const tool = VIDEO_TOOLS[output.tool];
  const problems: string[] = [];
  if (!candidateIds.has(output.chosen_product_id)) problems.push('o chosen_product_id não é um id da lista');
  if (!tool.durations.includes(output.duration)) problems.push(`a duração ${output.duration} não é permitida para ${output.tool} (permitidas: ${tool.durations.join(', ')})`);
  if (output.camera_movement && !tool.camera) output.camera_movement = null; // a movement for a tool that has none is simply not sent
  problems.push(...VIDEO_PROMPT_RULES.filter(rule => rule.pattern.test(output.video_prompt)).map(rule => rule.message));
  if (format === 'reel') {
    if (output.caption.length < 40) problems.push('campo caption: a legenda do Reels precisa de pelo menos 40 caracteres');
    problems.push(...checkCaption(`${output.hook}\n${output.caption}`));
    if (normalizeHashtags(output.hashtags).length < 3) problems.push('há menos de 3 hashtags válidas');
  } else {
    output.caption = ''; // Story has no caption
    problems.push(...checkCaption(output.hook));
  }
  return problems.length ? { ok: false, problems } : { ok: true, output };
}

/** The Reels caption as it will be posted (the Story has none). */
export const videoCaption = (format: VideoFormat, output: VideoOutput): string | null => (format === 'reel' ? assembleCaption(output) : null);

/** The request body for the chosen tool, exactly as the Higgsfield documentation lists the parameters. */
export function buildHiggsfieldBody(output: VideoOutput, imageUrl: string): Record<string, unknown> {
  if (output.tool === 'kling_2_6') return { prompt: output.video_prompt, image_url: imageUrl, duration: output.duration, aspect_ratio: '9:16', sound: output.sound ? 'on' : 'off' };
  return {
    prompt: output.video_prompt, image_url: imageUrl, duration: output.duration, aspect_ratio: '9:16', resolution: '720p', generate_audio: output.sound,
    ...(output.camera_movement ? { camera_movement: output.camera_movement } : {}),
  };
}

/** What is saved in posts.video_job while the video is being made. */
export type VideoJob = { requestId: string | null; tool: VideoToolId; endpoint: string; duration: number; framePath: string; estimatedMicros: number; startedAt: number };
export function parseVideoJob(value: unknown): VideoJob | null {
  if (!value || typeof value !== 'object') return null;
  const job = value as Record<string, unknown>;
  const tool = job['tool']; const endpoint = job['endpoint'];
  if (typeof tool !== 'string' || !(tool in VIDEO_TOOLS) || typeof endpoint !== 'string' || typeof job['startedAt'] !== 'number') return null;
  return {
    requestId: typeof job['requestId'] === 'string' && job['requestId'] ? job['requestId'] : null, tool: tool as VideoToolId, endpoint, duration: typeof job['duration'] === 'number' ? job['duration'] : 0,
    framePath: typeof job['framePath'] === 'string' ? job['framePath'] : '', estimatedMicros: typeof job['estimatedMicros'] === 'number' ? job['estimatedMicros'] : 0, startedAt: job['startedAt'],
  };
}
