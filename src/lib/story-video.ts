import { z } from 'zod';
import { checkCaption, extractJson, normalizeHashtags, type ProductCandidate } from './content-brain';
import { VIDEO_TOOLS, type VideoFormat, type VideoToolId } from './video-brain';

/**
 * The storyboard flow: the AI picks the product and the video tool, the storyboard images are drawn, and then ONE video is ordered at Higgsfield
 * with all the images as references (up to 30 seconds), or, for the short-clip tool, with the first image as the first frame.
 */
export const STORY_TOOL_IDS = ['seedance_2_5', 'wan_3_0', 'cinema_studio_4', 'ltx_2_5'] as const satisfies readonly VideoToolId[];
export type StoryToolId = (typeof STORY_TOOL_IDS)[number];
export const STORY_SECONDS: Record<VideoFormat, number> = { reel: 30, story: 15 };
/** While the images are being drawn. Nothing was ordered at Higgsfield yet, so giving up costs only the images already made. */
export const STORYBOARD_STUCK_MS = 30 * 60_000;
/** A 30-second video takes longer than a short clip. */
export const STORY_VIDEO_STUCK_MS = 45 * 60_000;
/** A scene that failed this many times ends the post. */
export const MAX_SCENE_TRIES = 3;
/** The first scene is drawn alone (the next ones copy its person), then up to this many at once, so one visit of the scheduler stays short. */
export const MAX_SCENES_PER_VISIT = 3;

export const storyDirectionSchema = z.object({
  chosen_product_id: z.string().min(1),
  reason: z.string().trim().min(10).max(500),
  angle: z.string().trim().min(2).max(120),
  hook: z.string().trim().min(5).max(140),
  caption: z.string().trim().max(1200).default(''),
  hashtags: z.array(z.string()).max(20).default([]),
  tool: z.enum(STORY_TOOL_IDS),
  duration: z.number().int(),
});
export type StoryDirection = z.infer<typeof storyDirectionSchema>;

const durationText = (id: StoryToolId) => {
  const tool = VIDEO_TOOLS[id]; const first = tool.durations[0] as number; const last = tool.durations[tool.durations.length - 1] as number;
  return tool.mode === 'reference' ? `de ${first} a ${last} segundos` : tool.durations.join(', ') + ' segundos';
};

/** What the AI is told when it picks the product and the tool. The storyboard (scenes, person, speech) is planned right after, for the product it picked. */
export function buildStoryDirectionPrompt(format: VideoFormat, candidates: readonly ProductCandidate[], options: { withSpeech: boolean }): { system: string; user: string } {
  const catalog = STORY_TOOL_IDS.map(id => {
    const tool = VIDEO_TOOLS[id];
    return `- ${id} (${tool.label}): ${tool.strengths}. Duração: ${durationText(id)}. ${tool.mode === 'reference' ? 'Usa as 6 imagens do storyboard como referência de um único vídeo.' : 'Usa só a primeira imagem do storyboard como primeiro quadro de um clipe curto.'}`;
  }).join('\n');
  const system = [
    'Você é o diretor de conteúdo de uma conta brasileira de Instagram que indica produtos da Shopee como afiliada.',
    `Sua tarefa: escolher UM produto da lista, escolher a ferramenta de vídeo e escrever a legenda de ${format === 'reel' ? 'um Reels' : 'um Story'} vertical (9:16).`,
    `O vídeo é montado a partir de um storyboard de 6 cenas com imagens feitas a partir da foto real do produto. ${options.withSpeech ? 'Um personagem fala nas cenas.' : 'O vídeo não tem fala.'}`,
    '',
    'Ferramentas de vídeo disponíveis:',
    catalog,
    '',
    `Como escolher: não há ferramenta preferida. Escolha a que melhor combina com o produto e com o objetivo. Duração: ${format === 'reel' ? `${STORY_SECONDS.reel} segundos para um Reels, nas ferramentas que aceitam` : `cerca de ${STORY_SECONDS.story} segundos para um Story (no máximo 10 na LTX 2.5 Pro)`}.`,
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
    `{"chosen_product_id":"<id exato da lista>","reason":"<por que este produto e esta ferramenta, em 1 ou 2 frases>","angle":"<o ângulo em poucas palavras>","hook":"<o gancho>","caption":"<a legenda completa ou vazia>","hashtags":["#..."],"tool":"<${STORY_TOOL_IDS.join('|')}>","duration":<segundos, inteiro>}`,
    format === 'reel' ? 'Use de 5 a 10 hashtags em português, relevantes ao produto.' : 'Em Story, hashtags pode ser uma lista vazia [].',
  ].join('\n');
  const list = candidates.map(item => ({ id: item.id, nome: item.title, preco_reais: item.price, comissao_percentual: item.commission === null ? null : Math.round(item.commission * 1000) / 10, vendas: item.sales, nota: item.rating }));
  return { system, user: `Produtos disponíveis (escolha um):\n${JSON.stringify(list, null, 1)}` };
}

export type StoryVerdict = { ok: true; output: StoryDirection } | { ok: false; problems: string[] };
/** Reads the AI's answer and checks every rule, the same ones as the original flow. The problems are written so they can be sent back to the AI. */
export function judgeStoryDirection(text: string, format: VideoFormat, candidateIds: ReadonlySet<string>): StoryVerdict {
  const json = extractJson(text);
  if (!json) return { ok: false, problems: ['a resposta não é um objeto JSON válido'] };
  const parsed = storyDirectionSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issue => `campo ${issue.path.join('.') || 'resposta'}: ${issue.message}`).slice(0, 5) };
  const output = parsed.data; const tool = VIDEO_TOOLS[output.tool];
  const problems: string[] = [];
  if (!candidateIds.has(output.chosen_product_id)) problems.push('o chosen_product_id não é um id da lista');
  if (!tool.durations.includes(output.duration)) problems.push(`a duração ${output.duration} não é permitida para ${output.tool} (permitida: ${durationText(output.tool)})`);
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

export type StoryScene = { shot: string; motion: string; speech: string | null };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const imageRef = (tool: StoryToolId, index: number) => (tool === 'cinema_studio_4' ? `<<<image_${index}>>>` : `Image ${index}`);

/**
 * The instructions for the video, in English, scene by scene, pointing at each reference image. The speech lines stay in Brazilian Portuguese.
 * Without speech the video is silent, and the prompt says so.
 */
export function buildStoryVideoPrompt(tool: StoryToolId, p: { scenes: readonly StoryScene[]; presenter: string | null; seconds: number; withSpeech: boolean }): string {
  if (VIDEO_TOOLS[tool].mode === 'frame') {
    const first = p.scenes[0];
    return clip([
      `Vertical advertising shot that starts from the given image. ${first ? `${first.shot}. ${first.motion}.` : ''}`,
      'Keep the product exactly as in the image: same shape, color and labels. Smooth, natural motion. No text, captions, logos or watermarks.',
      p.withSpeech && first?.speech ? `The presenter says in Brazilian Portuguese, in a natural friendly voice: "${first.speech}"` : 'No speech.',
    ].join(' '), 1500);
  }
  const each = Math.max(1, Math.round(p.seconds / Math.max(1, p.scenes.length)));
  const lines = p.scenes.map((scene, index) => {
    const speech = p.withSpeech && scene.speech ? ` The presenter says in Brazilian Portuguese, in a natural friendly voice: "${scene.speech}"` : '';
    return `Scene ${index + 1} (${imageRef(tool, index + 1)}, about ${each} seconds): ${clip(scene.shot, 220)} Camera and motion: ${clip(scene.motion, 140)}.${speech}`;
  });
  return [
    `Vertical 9:16 advertising video of about ${p.seconds} seconds, in ${p.scenes.length} scenes, one for each reference image, in order.`,
    'Keep the product exactly as shown in the images: same shape, color and labels. Natural, realistic motion and smooth cuts between scenes.',
    p.presenter && p.withSpeech ? `The same presenter appears in the scenes: ${clip(p.presenter, 200)}.` : '',
    ...lines,
    `No text, captions, logos or watermarks in the video.${p.withSpeech ? '' : ' No speech.'}`,
  ].filter(Boolean).join('\n');
}

/** The request body for the chosen tool, exactly as the Higgsfield documentation lists the parameters. Always 9:16, 720p. */
export function buildStoryBody(tool: StoryToolId, p: { prompt: string; imageUrls: readonly string[]; duration: number; withSpeech: boolean }): Record<string, unknown> {
  const common = { prompt: p.prompt, duration: p.duration, aspect_ratio: '9:16', resolution: '720p', generate_audio: p.withSpeech };
  if (tool === 'ltx_2_5') return { ...common, image_url: p.imageUrls[0] };
  // Wan 3.0 takes up to 10 reference images; Seedance 2.5 and Cinema Studio 4.0 take up to 30. The storyboard has 6.
  return { ...common, image_urls: p.imageUrls.slice(0, 10) };
}
