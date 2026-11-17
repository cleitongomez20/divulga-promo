import { z } from 'zod';
import { checkCaption, extractJson } from './content-brain';
import { BIO_CALL, CTA_TEXT, REFERENCE_RULE, SCENE_COUNT, SHOT_LABELS, SHOT_TYPES, TESTIMONIAL, storyProblems } from './storyboard';

/** The carousel slides are square, the Instagram feed format. */
export const CAROUSEL_IMAGE_SIZE = '1024x1024';

const optionalText = (max: number) => z.preprocess(value => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable());
const slideSchema = z.object({
  title: z.string().trim().min(1).max(60),
  camera: z.enum(SHOT_TYPES),
  shot: z.string().trim().min(10).max(400),
  headline: optionalText(32),
  subheadline: optionalText(40),
  badge: optionalText(22),
  callouts: z.array(z.string().trim().min(2).max(24)).max(3).default([]),
  cta: optionalText(30),
});
export const carouselPlanSchema = z.object({
  concept: z.string().trim().min(5).max(250),
  theme: z.string().trim().min(5).max(200),
  slides: z.array(slideSchema).length(SCENE_COUNT),
});
export type CarouselPlan = z.infer<typeof carouselPlanSchema>;
export type CarouselSlide = CarouselPlan['slides'][number];

/** What the AI is told to plan the carousel: ONE product, six square slides that tell a story, with the text written inside the image like a designed ad. */
export function buildCarouselPlanPrompt(product: { title: string }): { system: string; user: string } {
  const system = [
    `Você planeja um carrossel de Instagram sobre UM produto da Shopee divulgado por link de afiliado, com exatamente ${SCENE_COUNT} slides quadrados (1:1).`,
    'Cada slide é uma imagem de anúncio já com os textos escritos DENTRO da imagem, como uma arte profissional: título, subtítulo, um selo arredondado e textos curtos de destaque ligados por setas finas às partes do produto.',
    'O carrossel conta uma história que faz a pessoa deslizar até o fim, na ordem: slide 1, gancho de CURIOSIDADE sobre o produto (uma pergunta ou frase intrigante que faça a pessoa parar de rolar o feed, sem afirmar nada que não esteja no nome do produto); slide 2, os BENEFÍCIOS do produto; slide 3, continua a história, mostrando um detalhe ou diferencial que dá para ver; slide 4, como usar ou o produto no dia a dia; slide 5, o resultado ou por que vale a pena (sem prometer resultado); slide 6, a chamada final.',
    `Cada slide tem uma CENA e um ÂNGULO de câmera diferentes. Em "camera" use um destes valores e não repita nenhum nos ${SCENE_COUNT} slides: ${SHOT_TYPES.join(', ')}. Nunca repita o enquadramento, o cenário nem a composição de outro slide: se as imagens ficarem parecidas, a história não funciona.`,
    'Use somente o que está no nome do produto e o que a foto de referência mostrar (por exemplo material e medida, quando aparecem no nome). Não invente característica, material, medida, função, resultado, preço ou número.',
    'Nunca escreva nas imagens: preço, desconto, porcentagem, comissão, nota, número de vendas, urgência ou escassez ("últimas unidades", "só hoje"), promessa de resultado, depoimento ("comprei", "usei", "amei"), nem "link na bio".',
    'Os textos ficam em português do Brasil, com grafia perfeita, MUITO curtos e fáceis de ler no celular, sem abreviações estranhas e sem emojis dentro da imagem. Textos curtos cabem inteiros na imagem: textos longos são cortados nas bordas.',
    '"theme" é o clima visual do carrossel inteiro, em uma frase: cenário, cores e luz, escolhidos para combinar com o produto e a época (por exemplo "clima aconchegante de Natal, tons de vermelho e branco, luz quente"). Todos os slides seguem o mesmo tema, mas cada um mostra uma cena diferente.',
    '"shot" descreve só a cena da imagem (enquadramento, cenário, o que acontece com o produto, mãos se houver), sem os textos. O produto aparece exatamente como na foto: mesmo formato, cor e rótulos.',
    `Campos de texto de cada slide: headline (até 32 caracteres), subheadline (até 40), badge (até 22, o selo), callouts (de 0 a 3 textos de até 24 caracteres cada) e cta (só no último slide: exatamente "${CTA_TEXT}"). Use null ou lista vazia quando um campo não existir.`,
    'Responda somente com um JSON, sem texto antes ou depois, neste formato:',
    `{"concept": "a ideia do carrossel em uma frase", "theme": "o clima visual", "slides": [{"title": "nome interno do slide", "camera": "<${SHOT_TYPES.join('|')}>", "shot": "...", "headline": "... ou null", "subheadline": "... ou null", "badge": "... ou null", "callouts": ["..."], "cta": "... ou null"}, ... (6 slides)]}`,
  ].join('\n');
  return { system, user: `Produto: ${product.title.slice(0, 300)}\nMonte o carrossel.` };
}

export type CarouselVerdict = { ok: true; plan: CarouselPlan } | { ok: false; problems: string[] };
export const slideTexts = (slide: CarouselSlide): string[] => [slide.headline, slide.subheadline, slide.badge, ...slide.callouts, slide.cta].filter((text): text is string => Boolean(text));

/** Reads the AI's carousel and checks it: shape, the text each slide needs, a different camera in every slide, and the same rules the captions follow, applied to every word that will be written on an image. */
export function judgeCarouselPlan(text: string): CarouselVerdict {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, problems: ['a resposta não é um JSON válido'] };
  const parsed = carouselPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'resposta'}: ${issue.message}`) };
  const plan = parsed.data; const problems: string[] = [];
  // The final call is always the comment word, set by the code: the AI is told, but the result does not depend on it.
  (plan.slides[SCENE_COUNT - 1] as CarouselSlide).cta = CTA_TEXT;
  plan.slides.forEach((slide, index) => {
    const number = index + 1;
    if (index === 0 && !slide.headline) problems.push('o slide 1 precisa de um título (headline) com o gancho de curiosidade');
    if (index > 0 && index < SCENE_COUNT - 1 && !slide.callouts.length && !slide.headline) problems.push(`o slide ${number} está sem texto`);
    for (const piece of slideTexts(slide)) {
      for (const message of checkCaption(piece)) problems.push(`slide ${number}, "${piece}": ${message.replace(/^a legenda /, '')}`);
      if (TESTIMONIAL.test(piece)) problems.push(`slide ${number}, "${piece}": afirma uso pessoal ou depoimento`);
      if (BIO_CALL.test(piece)) problems.push(`slide ${number}, "${piece}": não mande ninguém para a bio; a chamada é só "${CTA_TEXT}"`);
    }
  });
  problems.push(...storyProblems(plan.slides, 'os slides'));
  return problems.length ? { ok: false, problems } : { ok: true, plan };
}
export const carouselFeedback = (problems: readonly string[]) =>
  `Seu carrossel foi recusado pelas regras: ${problems.join('; ')}. Corrija somente isso e responda de novo com o JSON completo, no mesmo formato.`;

const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;
/** The text sent to the image model for one slide. The texts are given word for word, because the image model writes them into the picture. */
export function buildCarouselImagePrompt(plan: Pick<CarouselPlan, 'theme'>, slide: Pick<CarouselSlide, 'title' | 'shot' | 'headline' | 'subheadline' | 'badge' | 'callouts' | 'cta'> & { camera?: CarouselSlide['camera'] | undefined }, index: number): string {
  const lines = [
    `Imagem quadrada 1:1 de slide de carrossel de Instagram, slide ${index + 1} de ${SCENE_COUNT}: ${slide.title}.`,
    ...(slide.camera ? [`Enquadramento (obrigatório; cada slide usa um diferente): ${SHOT_LABELS[slide.camera]}.`] : []),
    `Cena: ${slide.shot}`,
    `Clima visual de todo o carrossel: ${plan.theme}.`,
    'O produto deve aparecer idêntico ao da foto: mesmo formato, cor, embalagem e rótulos. Não invente nem altere o produto.',
    REFERENCE_RULE,
    'Escreva na imagem EXATAMENTE os textos abaixo, em português do Brasil, letra por letra, com grafia perfeita, letras nítidas e fáceis de ler no celular:',
  ];
  if (slide.headline) lines.push(`- Título: ${quote(slide.headline)}`);
  if (slide.subheadline) lines.push(`- Subtítulo logo abaixo do título: ${quote(slide.subheadline)}`);
  if (slide.badge) lines.push(`- Selo arredondado: ${quote(slide.badge)}`);
  slide.callouts.forEach(callout => lines.push(`- Texto de destaque com uma seta fina e curva apontando para a parte do produto a que ele se refere: ${quote(callout)}`));
  if (slide.cta) lines.push(`- Chamada final em um botão ou faixa arredondada: ${quote(slide.cta)}`);
  lines.push(
    'Não escreva nenhum outro texto, número, preço, logotipo ou marca d\'água, além destes e do que já está impresso no produto.',
    'TODO o texto deve ficar INTEIRO dentro da imagem, com margem de segurança de 10% em todas as bordas: nenhuma letra pode ser cortada nem encostar na borda. O título ocupa no máximo 2 linhas, em tamanho médio (nunca maior que um sexto da altura da imagem), e os textos de destaque são menores que o título.',
    'Estilo: arte publicitária profissional e realista, tipografia arredondada em negrito (branca ou na cor de destaque do tema, com leve sombra para dar contraste), selo e faixas com cantos arredondados, setas finas e elegantes, fundo de ambiente que combina com o tema.',
    'Composição quadrada: o produto grande e nítido, os textos ao redor sem cobrir o produto.',
  );
  return lines.join('\n');
}
