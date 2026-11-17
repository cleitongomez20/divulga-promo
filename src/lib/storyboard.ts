import { z } from 'zod';
import { TRIGGER_WORD, checkCaption, extractJson } from './content-brain';

export const SCENE_COUNT = 6;
/** A scene stuck in "generating" for longer than this is taken as abandoned and may be generated again. */
export const SCENE_STALE_MS = 5 * 60_000;
/** The call to action of every post: the same words the caption ends with. Nothing else ("link na bio" and the like) is accepted. */
export const CTA_TEXT = `Comenta ${TRIGGER_WORD}`;

/** The camera angles a scene can use. Each scene of a storyboard uses a different one, so the images tell a story instead of repeating a picture. */
export const SHOT_TYPES = ['close_up', 'macro', 'top_down', 'wide', 'low_angle', 'side', 'pov', 'three_quarter'] as const;
export type ShotType = (typeof SHOT_TYPES)[number];
export const SHOT_LABELS: Record<ShotType, string> = {
  close_up: 'plano fechado (close) no produto',
  macro: 'macro, detalhe extremo de textura ou material',
  top_down: 'vista de cima, câmera apontada para baixo (plano zenital)',
  wide: 'plano aberto, mostrando o ambiente inteiro',
  low_angle: 'câmera baixa, olhando de baixo para cima',
  side: 'plano lateral, de perfil',
  pov: 'primeira pessoa (POV), como se fossem os olhos de quem usa',
  three_quarter: 'ângulo de três quartos, câmera um pouco acima e de lado',
};
export const SHOT_LABELS_EN: Record<ShotType, string> = {
  close_up: 'close-up on the product', macro: 'macro shot of a texture or material detail', top_down: 'top-down shot, camera pointing straight down', wide: 'wide shot showing the whole setting',
  low_angle: 'low-angle shot looking up', side: 'side profile shot', pov: 'first-person POV shot', three_quarter: 'three-quarter angle, slightly above and to the side',
};

/** An empty text from the AI means "none". */
const optionalText = (max: number) => z.preprocess(value => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable());
const sceneSchema = z.object({
  title: z.string().trim().min(1).max(60),
  camera: z.enum(SHOT_TYPES),
  action: z.string().trim().min(5).max(160),
  shot: z.string().trim().min(10).max(400),
  motion: z.string().trim().min(5).max(250),
  speech: optionalText(200),
  on_screen_text: optionalText(40),
});
export const planSchema = z.object({
  concept: z.string().trim().min(5).max(250),
  presenter: optionalText(250),
  scenes: z.array(sceneSchema).length(SCENE_COUNT),
});
export type StoryboardPlan = z.infer<typeof planSchema>;
export type StoryboardScenePlan = StoryboardPlan['scenes'][number];

export type PlanProduct = { title: string };

/** The rules about the story and the camera, shared by the video storyboard and the carousel. */
export const STORY_RULES = [
  'As cenas contam UMA HISTÓRIA de uso do produto, em ordem cronológica: 1) apresentar o produto, que é o gancho; 2) abrir, desembalar ou preparar; 3) começar a usar ou aplicar; 4) o uso em andamento, em detalhe; 5) o resultado final; 6) a chamada final. Adapte a sequência ao produto (por exemplo, um painel ripado: apresentar o painel, tirar da embalagem, encaixar na parede, mostrar a parede pronta).',
  `Cada cena tem uma AÇÃO diferente e um ÂNGULO de câmera diferente. Em "camera" use um destes valores e não repita nenhum nas ${SCENE_COUNT} cenas: ${SHOT_TYPES.join(', ')}. Nunca repita o enquadramento, a pose nem o cenário de outra cena: se duas imagens ficarem parecidas, a história não funciona.`,
];

/** What the AI is told. The code, not the AI, decides what is allowed: everything it answers is checked afterwards. */
export function buildPlanPrompt(product: PlanProduct, options: { withSpeech: boolean; maxSpeechWords?: number }): { system: string; user: string } {
  const maxWords = options.maxSpeechWords ?? 12;
  const format = options.withSpeech
    ? [
      'Este Reels tem um personagem que fala. Descreva em "presenter" uma única pessoa fictícia e adulta (aparência, cabelo, roupa), em uma frase, para que ela seja a mesma em todas as cenas.',
      `Em cada cena, "speech" é o que o personagem diz, em português do Brasil, com no máximo ${maxWords} palavras (a cena é curta, e uma fala longa fica atropelada e ininteligível). Uma frase curta e simples por cena, de palavras comuns, dita devagar e com clareza. Tom simpático de quem indica algo, como uma amiga.`,
      'Permitido na fala: "olha o que eu encontrei", "achei super prático", "olha esse detalhe". Proibido: dizer que comprou, usou, testou ou amou o produto, contar resultado ou depoimento, citar preço, desconto, porcentagem, número de vendas, urgência ou escassez.',
    ]
    : [
      'Formato POV: a câmera é a primeira pessoa e aparecem SOMENTE AS MÃOS de uma pessoa, nunca rosto nem corpo. A dinâmica é entre as mãos e o produto.',
      'Descreva em "presenter" as mãos, uma única vez, em uma frase (tom de pele, unhas, anel ou pulseira se houver), para que sejam as mesmas em todas as cenas.',
      'O vídeo não tem fala: todos os "speech" são null.',
    ];
  const system = [
    'Você planeja o storyboard de um Reels publicitário vertical (9:16) de 30 segundos para um produto da Shopee divulgado por link de afiliado.',
    `O storyboard tem exatamente ${SCENE_COUNT} cenas de cerca de 5 segundos.`,
    ...STORY_RULES,
    'Use somente o que está no título do produto e o que a foto de referência mostrar. Não invente característica, material, medida, função, resultado, preço ou número.',
    'Cada cena deve mostrar o produto exatamente como na foto: mesmo formato, cor e rótulos. Mostrar o produto sendo usado é permitido, sem prometer resultado.',
    '"action" diz o que acontece na cena (o que as mãos fazem com o produto). "shot" descreve a imagem da cena (cenário, luz, o produto e a ação), sem texto escrito dentro da imagem. "motion" descreve como a câmera ou o produto se movem no vídeo.',
    `"on_screen_text" é um texto curto (até 40 caracteres) que será colocado sobre o vídeo depois, ou null. Na última cena, "on_screen_text" é exatamente "${CTA_TEXT}". Nunca escreva "link na bio".`,
    ...format,
    'Responda somente com um JSON, sem texto antes ou depois, neste formato:',
    `{"concept": "a ideia do vídeo em uma frase", "presenter": "descrição da pessoa ou das mãos", "scenes": [{"title": "...", "camera": "<${SHOT_TYPES.join('|')}>", "action": "...", "shot": "...", "motion": "...", "speech": "... ou null", "on_screen_text": "... ou null"}, ... (6 cenas)]}`,
  ].join('\n');
  const user = `Produto: ${product.title.slice(0, 300)}\nMonte o storyboard.`;
  return { system, user };
}

/** Personal use, result or testimonial claims are forbidden in anything written or said (the same rule as the captions). */
export const TESTIMONIAL = /\b(comprei|usei|uso\s+(todo|toda|há|faz)|testei|amei|adorei|resolveu\s+(o\s+)?meu|mudou\s+(a\s+)?minha|na\s+minha\s+(casa|rotina))\b/i;
/** The only call to action is the comment word: sending people to the bio is not accepted. */
export const BIO_CALL = /\bbio\b/i;

const wordsOf = (text: string) => new Set(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(word => word.length > 3));
/** How much two descriptions share, from 0 to 1. Two scenes that share most words describe almost the same picture. */
export function similarity(a: string, b: string): number {
  const first = wordsOf(a); const second = wordsOf(b);
  if (!first.size || !second.size) return 0;
  let common = 0; for (const word of first) if (second.has(word)) common++;
  return common / (first.size + second.size - common);
}
const TOO_SIMILAR = 0.6;

/** Problems with the story itself: a camera angle used twice, or two scenes that describe almost the same picture. */
export function storyProblems(scenes: readonly { camera: string; shot: string }[], noun: string): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  scenes.forEach((scene, index) => {
    const first = seen.get(scene.camera);
    if (first !== undefined) problems.push(`${noun} ${first + 1} e ${index + 1} usam o mesmo ângulo de câmera (${scene.camera}); use um ângulo diferente em cada um`);
    else seen.set(scene.camera, index);
  });
  for (let i = 0; i < scenes.length; i++) for (let j = i + 1; j < scenes.length; j++) {
    if (similarity((scenes[i] as { shot: string }).shot, (scenes[j] as { shot: string }).shot) >= TOO_SIMILAR) problems.push(`${noun} ${i + 1} e ${j + 1} descrevem quase a mesma imagem; mude a ação, o cenário e o enquadramento`);
  }
  return problems;
}

export type PlanVerdict = { ok: true; plan: StoryboardPlan } | { ok: false; problems: string[] };
export function judgePlan(text: string, options: { withSpeech: boolean; maxSpeechWords?: number }): PlanVerdict {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, problems: ['a resposta não é um JSON válido'] };
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'resposta'}: ${issue.message}`) };
  }
  const plan = parsed.data; const problems: string[] = [];
  if (options.withSpeech) {
    if (!plan.presenter) problems.push('falta descrever o personagem em "presenter"');
    plan.scenes.forEach((scene, index) => {
      if (!scene.speech) { problems.push(`a cena ${index + 1} está sem fala`); return; }
      const words = scene.speech.trim().split(/\s+/).length;
      if (options.maxSpeechWords !== undefined && words > options.maxSpeechWords) problems.push(`a fala da cena ${index + 1} tem ${words} palavras, e o máximo é ${options.maxSpeechWords}`);
    });
  } else {
    // POV: only the hands appear, and nobody speaks.
    if (!plan.presenter) problems.push('falta descrever as mãos em "presenter"');
    plan.scenes.forEach((scene, index) => { if (scene.speech) problems.push(`a cena ${index + 1} tem fala, mas o vídeo POV não tem fala`); });
  }
  // The call to action is always the comment word, set by the code: the AI is told, but the result does not depend on it.
  const last = plan.scenes[SCENE_COUNT - 1] as StoryboardScenePlan;
  last.on_screen_text = CTA_TEXT;
  problems.push(...storyProblems(plan.scenes, 'as cenas'));
  const texts: { where: string; value: string | null }[] = [{ where: 'o conceito', value: plan.concept }];
  plan.scenes.forEach((scene, index) => {
    texts.push({ where: `a fala da cena ${index + 1}`, value: scene.speech }, { where: `o texto na tela da cena ${index + 1}`, value: scene.on_screen_text });
  });
  for (const { where, value } of texts) {
    if (!value) continue;
    for (const message of checkCaption(value)) problems.push(`${where}: ${message.replace(/^a legenda /, '')}`);
    if (BIO_CALL.test(value)) problems.push(`${where}: não mande ninguém para a bio; a chamada é só "${CTA_TEXT}"`);
  }
  plan.scenes.forEach((scene, index) => { if (scene.speech && TESTIMONIAL.test(scene.speech)) problems.push(`a fala da cena ${index + 1} afirma uso pessoal ou depoimento`); });
  return problems.length ? { ok: false, problems } : { ok: true, plan };
}
export const planFeedback = (problems: readonly string[]) =>
  `Seu storyboard foi recusado pelas regras: ${problems.join('; ')}. Corrija somente isso e responda de novo com o JSON completo, no mesmo formato.`;

/** What the image model is told about a scene. The camera and the action are optional only for storyboards saved before they existed. */
export type ScenePromptInput = { title: string; shot: string; camera?: ShotType | undefined; action?: string | undefined };
/** Said in every image prompt: the reference photo is for the look of the product only, never for the picture. */
export const REFERENCE_RULE = 'A primeira imagem de referência serve SÓ para reproduzir o produto fielmente (formato, cor, embalagem e rótulos). NÃO copie o enquadramento, o fundo, a pose nem a composição dela: crie uma cena nova, com o enquadramento pedido.';

/** The text sent to the image model for one scene. */
export function buildScenePrompt(plan: Pick<StoryboardPlan, 'presenter'>, scene: ScenePromptInput, index: number, options: { samePersonReference: boolean; pov?: boolean }): string {
  const lines = [
    `Imagem vertical de anúncio para Reels, cena ${index + 1} de ${SCENE_COUNT}: ${scene.title}.`,
    ...(scene.action ? [`Ação: ${scene.action}.`] : []),
    ...(scene.camera ? [`Enquadramento (obrigatório; cada cena usa um diferente): ${SHOT_LABELS[scene.camera]}.`] : []),
    `Mostre: ${scene.shot}`,
    'O produto deve aparecer idêntico ao da foto: mesmo formato, cor, embalagem e rótulos. Não invente nem altere o produto.',
    REFERENCE_RULE,
  ];
  if (plan.presenter) {
    if (options.pov) lines.push(`Perspectiva em primeira pessoa: aparecem SOMENTE as mãos de uma pessoa, nunca rosto nem corpo. Mãos: ${plan.presenter}`);
    else {
      lines.push(`Pessoa na cena: ${plan.presenter}`);
      if (options.samePersonReference) lines.push('A segunda imagem de referência é a cena anterior, só para manter exatamente a mesma pessoa (rosto, cabelo e roupa). NÃO copie o enquadramento, a pose nem o cenário dela.');
    }
  }
  lines.push(
    'Estilo: fotografia publicitária realista, luz natural suave, composição vertical com o assunto no centro e espaço livre em cima e embaixo para textos.',
    'Sem texto escrito na imagem, sem marca d\'água e sem logotipos, além dos que já estão impressos no produto.',
  );
  return lines.join('\n');
}
