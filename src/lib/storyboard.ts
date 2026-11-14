import { z } from 'zod';
import { checkCaption, extractJson } from './content-brain';

export const SCENE_COUNT = 6;
/** A scene stuck in "generating" for longer than this is taken as abandoned and may be generated again. */
export const SCENE_STALE_MS = 5 * 60_000;

/** An empty text from the AI means "none". */
const optionalText = (max: number) => z.preprocess(value => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable());
const sceneSchema = z.object({
  title: z.string().trim().min(1).max(60),
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

/** What the AI is told. The code, not the AI, decides what is allowed: everything it answers is checked afterwards. */
export function buildPlanPrompt(product: PlanProduct, options: { withSpeech: boolean }): { system: string; user: string } {
  const speech = options.withSpeech
    ? [
      'Este Reels tem um personagem que fala. Descreva em "presenter" uma única pessoa fictícia e adulta (aparência, cabelo, roupa), em uma frase, para que ela seja a mesma em todas as cenas.',
      'Em cada cena, "speech" é o que o personagem diz, com no máximo 12 palavras, em português do Brasil, tom simpático de quem indica algo, como uma amiga.',
      'Permitido na fala: "olha o que eu encontrei", "achei super prático", "olha esse detalhe". Proibido: dizer que comprou, usou, testou ou amou o produto, contar resultado ou depoimento, citar preço, desconto, porcentagem, número de vendas, urgência ou escassez.',
    ]
    : ['Este Reels não tem fala: "presenter" e todos os "speech" devem ser null.'];
  const system = [
    'Você planeja o storyboard de um Reels publicitário vertical (9:16) de 30 segundos para um produto da Shopee divulgado por link de afiliado.',
    `O storyboard tem exatamente ${SCENE_COUNT} cenas de cerca de 5 segundos, na ordem: gancho, produto em destaque, detalhe, o produto no dia a dia, benefício, chamada final.`,
    'Use somente o que está no título do produto e o que a foto de referência mostrar. Não invente característica, material, medida, função, resultado, preço ou número.',
    'Cada cena deve mostrar o produto exatamente como na foto: mesmo formato, cor e rótulos. Mostrar o produto sendo usado é permitido, sem prometer resultado.',
    '"shot" descreve o que aparece na imagem da cena (enquadramento, cenário, luz, o que a pessoa faz), sem texto escrito dentro da imagem. "motion" descreve como a câmera ou o produto se movem no vídeo.',
    '"on_screen_text" é um texto curto (até 40 caracteres) que será colocado sobre o vídeo depois, ou null. Na última cena, a chamada pode ser "Comente EU QUERO" ou "Link na bio".',
    ...speech,
    'Responda somente com um JSON, sem texto antes ou depois, neste formato:',
    '{"concept": "a ideia do vídeo em uma frase", "presenter": "descrição da pessoa ou null", "scenes": [{"title": "...", "shot": "...", "motion": "...", "speech": "... ou null", "on_screen_text": "... ou null"}, ... (6 cenas)]}',
  ].join('\n');
  const user = `Produto: ${product.title.slice(0, 300)}\nMonte o storyboard.`;
  return { system, user };
}

/** Personal use, result or testimonial claims are forbidden in anything the presenter says (the same rule as the captions). */
const TESTIMONIAL = /\b(comprei|usei|uso\s+(todo|toda|há|faz)|testei|amei|adorei|resolveu\s+(o\s+)?meu|mudou\s+(a\s+)?minha|na\s+minha\s+(casa|rotina))\b/i;

export type PlanVerdict = { ok: true; plan: StoryboardPlan } | { ok: false; problems: string[] };
export function judgePlan(text: string, options: { withSpeech: boolean }): PlanVerdict {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, problems: ['a resposta não é um JSON válido'] };
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'resposta'}: ${issue.message}`) };
  }
  const plan = parsed.data; const problems: string[] = [];
  if (options.withSpeech) {
    if (!plan.presenter) problems.push('falta descrever o personagem em "presenter"');
    plan.scenes.forEach((scene, index) => { if (!scene.speech) problems.push(`a cena ${index + 1} está sem fala`); });
  } else {
    if (plan.presenter) problems.push('"presenter" deve ser null, porque o vídeo não tem fala');
    plan.scenes.forEach((scene, index) => { if (scene.speech) problems.push(`a cena ${index + 1} tem fala, mas o vídeo não deve ter`); });
  }
  const texts: { where: string; value: string | null }[] = [{ where: 'o conceito', value: plan.concept }];
  plan.scenes.forEach((scene, index) => {
    texts.push({ where: `a fala da cena ${index + 1}`, value: scene.speech }, { where: `o texto na tela da cena ${index + 1}`, value: scene.on_screen_text });
  });
  for (const { where, value } of texts) {
    if (!value) continue;
    for (const message of checkCaption(value)) problems.push(`${where}: ${message.replace(/^a legenda /, '')}`);
  }
  plan.scenes.forEach((scene, index) => { if (scene.speech && TESTIMONIAL.test(scene.speech)) problems.push(`a fala da cena ${index + 1} afirma uso pessoal ou depoimento`); });
  return problems.length ? { ok: false, problems } : { ok: true, plan };
}
export const planFeedback = (problems: readonly string[]) =>
  `Seu storyboard foi recusado pelas regras: ${problems.join('; ')}. Corrija somente isso e responda de novo com o JSON completo, no mesmo formato.`;

/** The text sent to the image model for one scene. */
export function buildScenePrompt(plan: StoryboardPlan, scene: StoryboardScenePlan, index: number, options: { samePersonReference: boolean }): string {
  const lines = [
    `Imagem vertical de anúncio para Reels, cena ${index + 1} de ${SCENE_COUNT}: ${scene.title}.`,
    `Mostre: ${scene.shot}`,
    'O produto da primeira imagem de referência deve aparecer idêntico ao da foto: mesmo formato, cor, embalagem e rótulos. Não invente nem altere o produto.',
  ];
  if (plan.presenter) {
    lines.push(`Pessoa na cena: ${plan.presenter}`);
    if (options.samePersonReference) lines.push('A segunda imagem de referência é a cena anterior: mantenha exatamente a mesma pessoa (rosto, cabelo e roupa).');
  }
  lines.push(
    'Estilo: fotografia publicitária realista, luz natural suave, composição vertical com o assunto no centro e espaço livre em cima e embaixo para textos.',
    'Sem texto escrito na imagem, sem marca d\'água e sem logotipos, além dos que já estão impressos no produto.',
  );
  return lines.join('\n');
}