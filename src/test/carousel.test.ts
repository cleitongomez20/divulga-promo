import { describe, expect, it } from 'vitest';
import { CAROUSEL_IMAGE_SIZE, buildCarouselImagePrompt, buildCarouselPlanPrompt, carouselPlanSchema, judgeCarouselPlan, slideTexts, type CarouselPlan } from '@/lib/carousel';

type Slide = CarouselPlan['slides'][number];
const slide = (n: number, extra: Partial<Slide> = {}): Slide => ({ title: `Slide ${n}`, shot: `O produto em destaque sobre a mesa, slide ${n}`, headline: null, subheadline: null, badge: null, callouts: [`Detalhe ${n}`], cta: null, ...extra });
const plan = (edit: (slides: Slide[]) => void = () => undefined) => {
  const slides = [slide(1, { headline: 'seu café em clima de NATAL', subheadline: 'Um encanto em cada detalhe', badge: 'Modo Natal Ativado', callouts: [] }), slide(2, { callouts: ['Papai Noel em relevo', 'Cerâmica • 330 ml'] }), slide(3), slide(4), slide(5), slide(6, { headline: 'Quer a sua?', callouts: [], cta: 'Comente EU QUERO' })];
  edit(slides);
  return JSON.stringify({ concept: 'Mostrar a caneca como presente de Natal', theme: 'sala aconchegante de Natal, vermelho e branco, luz quente', slides });
};

describe('the carousel plan', () => {
  it('has exactly six slides and treats empty text as none', () => {
    expect(carouselPlanSchema.safeParse(JSON.parse(plan())).success).toBe(true);
    expect(carouselPlanSchema.safeParse({ concept: 'uma ideia boa', theme: 'um clima visual', slides: [slide(1)] }).success).toBe(false);
    const parsed = carouselPlanSchema.parse(JSON.parse(plan(slides => { slides[2] = { ...slide(3), badge: '', subheadline: '  ' } as Slide; })));
    expect(parsed.slides[2]).toMatchObject({ badge: null, subheadline: null });
  });
  it('the prompt asks for text inside the image, square slides, and forbids prices and testimonials', () => {
    const { system, user } = buildCarouselPlanPrompt({ title: 'Caneca de Cerâmica Natalina' });
    expect(system).toMatch(/1:1/); expect(system).toMatch(/DENTRO da imagem/); expect(system).toMatch(/selo arredondado/); expect(system).toMatch(/setas finas/);
    expect(system).toMatch(/Comente EU QUERO/); expect(system).toMatch(/Nunca escreva nas imagens: preço, desconto/); expect(system).toMatch(/depoimento/);
    expect(user).toContain('Caneca de Cerâmica Natalina');
  });
  it('lists every piece of text of a slide', () => {
    expect(slideTexts(slide(1, { headline: 'A', subheadline: 'B', badge: 'C', callouts: ['D', 'E'], cta: 'F' }))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(slideTexts(slide(2, { callouts: [] }))).toEqual([]);
  });
});

describe('judging the carousel plan', () => {
  it('accepts the plan of the example ad, even inside a code block', () => {
    expect(judgeCarouselPlan(plan()).ok).toBe(true);
    expect(judgeCarouselPlan('```json\n' + plan() + '\n```').ok).toBe(true);
  });
  it('refuses an answer that is not JSON or not a carousel', () => {
    expect(judgeCarouselPlan('oi')).toMatchObject({ ok: false, problems: ['a resposta não é um JSON válido'] });
    expect(judgeCarouselPlan(JSON.stringify({ concept: 'uma ideia boa', theme: 'clima visual', slides: [] })).ok).toBe(false);
  });
  it('needs a title on the cover, the final call on the last slide and some text on every slide', () => {
    const verdict = (edit: (slides: Slide[]) => void) => judgeCarouselPlan(plan(edit));
    expect(verdict(slides => { slides[0] = slide(1, { callouts: [] }); }).ok).toBe(false);
    expect(verdict(slides => { slides[5] = slide(6, { headline: 'Quer a sua?', callouts: [] }); }).ok).toBe(false);
    expect(verdict(slides => { slides[3] = slide(4, { callouts: [] }); }).ok).toBe(false);
  });
  it('applies the caption rules to every word written on an image', () => {
    const bad = (extra: Partial<Slide>) => judgeCarouselPlan(plan(slides => { slides[2] = slide(3, extra); }));
    expect(bad({ callouts: ['Só R$ 34,90'] }).ok).toBe(false);
    expect(bad({ callouts: ['30% de desconto'] }).ok).toBe(false);
    expect(bad({ callouts: ['Últimas unidades'] }).ok).toBe(false);
    expect(bad({ headline: 'www.loja.com' }).ok).toBe(false);
    const testimonial = bad({ callouts: ['Eu comprei e amei'] });
    expect(testimonial.ok).toBe(false); expect(testimonial.ok ? '' : testimonial.problems.join(' ')).toMatch(/slide 3/);
  });
  it('a callout is at most three and short', () => {
    expect(carouselPlanSchema.safeParse(JSON.parse(plan(slides => { slides[1] = slide(2, { callouts: ['a1', 'b2', 'c3', 'd4'] }); }))).success).toBe(false);
    expect(carouselPlanSchema.safeParse(JSON.parse(plan(slides => { slides[1] = slide(2, { callouts: ['Um texto de destaque comprido demais para a imagem'] }); }))).success).toBe(false);
  });
});

describe('the image prompt of a slide', () => {
  const parsed = judgeCarouselPlan(plan());
  const data = parsed.ok ? parsed.plan : (null as never);
  it('gives every text word for word and asks for the layout of the example', () => {
    const cover = buildCarouselImagePrompt(data, data.slides[0] as Slide, 0);
    expect(cover).toMatch(/1:1/); expect(cover).toMatch(/slide 1 de 6/); expect(cover).toContain('sala aconchegante de Natal');
    expect(cover).toContain('Título grande: "seu café em clima de NATAL"'); expect(cover).toContain('Subtítulo logo abaixo do título: "Um encanto em cada detalhe"'); expect(cover).toContain('Selo arredondado com ícone: "Modo Natal Ativado"');
    expect(cover).toMatch(/EXATAMENTE os textos abaixo/); expect(cover).toMatch(/idêntico ao da foto/); expect(cover).toMatch(/Não escreva nenhum outro texto, número, preço/);
    expect(cover).toMatch(/tipografia arredondada em negrito/);
    const detail = buildCarouselImagePrompt(data, data.slides[1] as Slide, 1);
    expect(detail).toContain('seta fina e curva'); expect(detail).toContain('"Papai Noel em relevo"'); expect(detail).toContain('"Cerâmica • 330 ml"'); expect(detail).not.toContain('Título grande');
    const last = buildCarouselImagePrompt(data, data.slides[5] as Slide, 5);
    expect(last).toContain('Chamada final em um botão ou faixa arredondada: "Comente EU QUERO"');
  });
  it('quotes are never broken by the texts', () => {
    const prompt = buildCarouselImagePrompt(data, slide(2, { callouts: ['Texto "entre aspas"'] }), 1);
    expect(prompt).toContain('"Texto \'entre aspas\'"');
  });
  it('the slides are square', () => { expect(CAROUSEL_IMAGE_SIZE).toBe('1024x1024'); });
});
