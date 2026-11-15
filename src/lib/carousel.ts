import { z } from 'zod';
import { checkCaption, extractJson } from './content-brain';
import { SCENE_COUNT, TESTIMONIAL } from './storyboard';

/** The carousel slides are square, the Instagram feed format. */
export const CAROUSEL_IMAGE_SIZE = '1024x1024';

const optionalText = (max: number) => z.preprocess(value => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable());
const slideSchema = z.object({
  title: z.string().trim().min(1).max(60),
  shot: z.string().trim().min(10).max(400),
  headline: optionalText(45),
  subheadline: optionalText(60),
  badge: optionalText(24),
  callouts: z.array(z.string().trim().min(2).max(28)).max(3).default([]),
  cta: optionalText(30),
});
export const carouselPlanSchema = z.object({
  concept: z.string().trim().min(5).max(250),
  theme: z.string().trim().min(5).max(200),
  slides: z.array(slideSchema).length(SCENE_COUNT),
});
export type CarouselPlan = z.infer<typeof carouselPlanSchema>;
export type CarouselSlide = CarouselPlan['slides'][number];

/** What the AI is told to plan the carousel: six square slides whose text is part of the image, like a designed ad. */
export function buildCarouselPlanPrompt(product: { title: string }): { system: string; user: string } {
  const system = [
    `Você planeja um carrossel de Instagram com exatamente ${SCENE_COUNT} slides quadrados (1:1) para um produto da Shopee divulgado por link de afiliado.`,
    'Cada slide é uma imagem de anúncio já com os textos escritos DENTRO da imagem, como uma arte profissional: título grande, subtítulo, um selo arredondado e textos curtos de destaque ligados por setas finas às partes do produto.',
    'Ordem: slide 1 é a capa (gancho: título grande, subtítulo e, se couber, um selo); slides 2 a 5 mostram detalhes e benefícios do produto, cada um com 1 a 3 textos de destaque; o slide 6 é a chamada final, com "Comente EU QUERO" ou "Link na bio".',
    'Use somente o que está no nome do produto e o que a foto de referência mostrar (por exemplo material e medida, quando aparecem no nome). Não invente característica, material, medida, função, resultado, preço ou número.',
    'Nunca escreva nas imagens: preço, desconto, porcentagem, comissão, nota, número de vendas, urgência ou escassez ("últimas unidades", "só hoje"), promessa de resultado, nem depoimento ("comprei", "usei", "amei").',
    'Os textos ficam em português do Brasil, com grafia perfeita, curtos e fáceis de ler no celular. Sem abreviações estranhas, sem emojis dentro da imagem.',
    '"theme" é o clima visual do carrossel inteiro, em uma frase: cenário, cores e luz, escolhidos para combinar com o produto e a época (por exemplo "clima aconchegante de Natal, tons de vermelho e branco, luz quente"). Todos os slides seguem o mesmo tema.',
    '"shot" descreve só a cena da imagem (enquadramento, cenário, o produto em destaque, mãos ou pessoas se houver), sem os textos. O produto aparece exatamente como na foto: mesmo formato, cor e rótulos.',
    'Campos de texto de cada slide: headline (até 45 caracteres), subheadline (até 60), badge (até 24, o selo), callouts (de 0 a 3 textos de até 28 caracteres cada) e cta (até 30, só no último slide). Use null ou lista vazia quando um campo não existir.',
    'Responda somente com um JSON, sem texto antes ou depois, neste formato:',
    '{"concept": "a ideia do carrossel em uma frase", "theme": "o clima visual", "slides": [{"title": "nome interno do slide", "shot": "...", "headline": "... ou null", "subheadline": "... ou null", "badge": "... ou null", "callouts": ["..."], "cta": "... ou null"}, ... (6 slides)]}',
  ].join('\n');
  return { system, user: `Produto: ${product.title.slice(0, 300)}\nMonte o carrossel.` };
}

export type CarouselVerdict = { ok: true; plan: CarouselPlan } | { ok: false; problems: string[] };
export const slideTexts = (slide: CarouselSlide): string[] => [slide.headline, slide.subheadline, slide.badge, ...slide.callouts, slide.cta].filter((text): text is string => Boolean(text));

/** Reads the AI's carousel and checks it: shape, the text each slide needs, and the same rules the captions follow, applied to every word that will be written on an image. */
export function judgeCarouselPlan(text: string): CarouselVerdict {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, problems: ['a resposta não é um JSON válido'] };
  const parsed = carouselPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'resposta'}: ${issue.message}`) };
  const plan = parsed.data; const problems: string[] = [];
  plan.slides.forEach((slide, index) => {
    const number = index + 1;
    if (index === 0 && !slide.headline) problems.push('o slide 1 precisa de um título (headline)');
    if (index === SCENE_COUNT - 1 && !slide.cta) problems.push(`o slide ${SCENE_COUNT} precisa da chamada final (cta)`);
    if (index > 0 && index < SCENE_COUNT - 1 && !slide.callouts.length && !slide.headline) problems.push(`o slide ${number} está sem texto`);
    for (const piece of slideTexts(slide)) {
      for (const message of checkCaption(piece)) problems.push(`slide ${number}, "${piece}": ${message.replace(/^a legenda /, '')}`);
      if (TESTIMONIAL.test(piece)) problems.push(`slide ${number}, "${piece}": afirma uso pessoal ou depoimento`);
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, plan };
}
export const carouselFeedback = (problems: readonly string[]) =>
  `Seu carrossel foi recusado pelas regras: ${problems.join('; ')}. Corrija somente isso e responda de novo com o JSON completo, no mesmo formato.`;

const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;
/** The text sent to the image model for one slide. The texts are given word for word, because the image model writes them into the picture. */
export function buildCarouselImagePrompt(plan: Pick<CarouselPlan, 'theme'>, slide: CarouselSlide, index: number): string {
  const lines = [
    `Imagem quadrada 1:1 de slide de carrossel de Instagram, slide ${index + 1} de ${SCENE_COUNT}: ${slide.title}.`,
    `Cena: ${slide.shot}`,
    `Clima visual de todo o carrossel: ${plan.theme}.`,
    'O produto da imagem de referência deve aparecer idêntico ao da foto: mesmo formato, cor, embalagem e rótulos. Não invente nem altere o produto.',
    'Escreva na imagem EXATAMENTE os textos abaixo, em português do Brasil, letra por letra, com grafia perfeita, letras grandes, nítidas e fáceis de ler no celular:',
  ];
  if (slide.headline) lines.push(`- Título grande: ${quote(slide.headline)}`);
  if (slide.subheadline) lines.push(`- Subtítulo logo abaixo do título: ${quote(slide.subheadline)}`);
  if (slide.badge) lines.push(`- Selo arredondado com ícone: ${quote(slide.badge)}`);
  slide.callouts.forEach(callout => lines.push(`- Texto de destaque com uma seta fina e curva apontando para a parte do produto a que ele se refere: ${quote(callout)}`));
  if (slide.cta) lines.push(`- Chamada final em um botão ou faixa arredondada: ${quote(slide.cta)}`);
  lines.push(
    'Não escreva nenhum outro texto, número, preço, logotipo ou marca d\'água, além destes e do que já está impresso no produto.',
    'Estilo: arte publicitária profissional e realista, tipografia arredondada em negrito (branca ou na cor de destaque do tema, com leve sombra para dar contraste), selo e faixas com cantos arredondados, setas finas e elegantes, fundo de ambiente desfocado que combina com o tema.',
    'Composição quadrada: título no terço superior, produto grande e nítido no centro, textos de destaque ao redor sem cobrir o produto, margens de segurança nas bordas.',
  );
  return lines.join('\n');
}
