import { describe, expect, it } from 'vitest';
import { CAROUSEL_IMAGE_SIZE, buildCarouselImagePrompt, buildCarouselPlanPrompt, carouselPlanSchema, judgeCarouselPlan, slideTexts, type CarouselPlan } from '@/lib/carousel';
import { CTA_TEXT, SHOT_TYPES, type ShotType } from '@/lib/storyboard';

type Slide = CarouselPlan['slides'][number];
const CAMERAS: ShotType[] = ['close_up', 'wide', 'top_down', 'macro', 'low_angle', 'side'];
const SHOTS = [
  'A caneca de Natal sobre a mesa da sala, cercada de luzinhas, em destaque no centro',
  'Mãos segurando a caneca de perto, mostrando o relevo do Papai Noel em cerâmica',
  'Vista de cima da caneca ao lado de biscoitos e de um guardanapo xadrez na mesa',
  'Detalhe extremo da textura de trama em relevo e da borda vermelha esmaltada',
  'Caneca fumegante num banco baixo, olhando de baixo para cima, árvore ao fundo',
  'Perfil da caneca na bancada da cozinha com a alça vermelha virada para a câmera',
];
const slide = (n: number, extra: Partial<Slide> = {}): Slide => ({ title: `Slide ${n}`, camera: CAMERAS[n - 1] as ShotType, shot: SHOTS[n - 1] as string, headline: null, subheadline: null, badge: null, callouts: [`Detalhe ${n}`], cta: null, ...extra });
const plan = (edit: (slides: Slide[]) => void = () => undefined) => {
  const slides = [
    slide(1, { headline: 'Já viu uma caneca assim?', subheadline: 'Um encanto em cada detalhe', badge: 'Modo Natal', callouts: [] }),
    slide(2, { callouts: ['Papai Noel em relevo', 'Cerâmica • 330 ml'] }), slide(3), slide(4), slide(5),
    slide(6, { headline: 'Quer a sua?', callouts: [], cta: CTA_TEXT }),
  ];
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
  it('the prompt asks for ONE product told as a story, a different camera per slide, short text and the fixed call', () => {
    const { system, user } = buildCarouselPlanPrompt({ title: 'Caneca de Cerâmica Natalina' });
    expect(system).toMatch(/UM produto/); expect(system).toMatch(/1:1/); expect(system).toMatch(/DENTRO da imagem/); expect(system).toMatch(/selo arredondado/); expect(system).toMatch(/setas finas/);
    expect(system).toMatch(/gancho de CURIOSIDADE/); expect(system).toMatch(/BENEFÍCIOS/); expect(system).toMatch(/continua a história/); expect(system).toMatch(/parar de rolar/);
    for (const type of SHOT_TYPES) expect(system).toContain(type);
    expect(system).toMatch(/não repita nenhum/i); expect(system).toMatch(/MUITO curtos/); expect(system).toMatch(/cortados nas bordas/);
    expect(system).toContain('exatamente "Comenta EU QUERO"'); expect(system).toMatch(/nem "link na bio"/); expect(system).toMatch(/Nunca escreva nas imagens: preço, desconto/); expect(system).toMatch(/depoimento/);
    expect(user).toContain('Caneca de Cerâmica Natalina');
  });
  it('lists every piece of text of a slide', () => {
    expect(slideTexts(slide(1, { headline: 'A', subheadline: 'B', badge: 'C', callouts: ['D', 'E'], cta: 'F' }))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(slideTexts(slide(2, { callouts: [] }))).toEqual([]);
  });
});

describe('judging the carousel plan', () => {
  it('accepts a good plan, even inside a code block', () => {
    expect(judgeCarouselPlan(plan()).ok).toBe(true);
    expect(judgeCarouselPlan('```json\n' + plan() + '\n```').ok).toBe(true);
  });
  it('refuses an answer that is not JSON or not a carousel', () => {
    expect(judgeCarouselPlan('oi')).toMatchObject({ ok: false, problems: ['a resposta não é um JSON válido'] });
    expect(judgeCarouselPlan(JSON.stringify({ concept: 'uma ideia boa', theme: 'clima visual', slides: [] })).ok).toBe(false);
  });
  it('needs a hook on the cover and some text on every middle slide', () => {
    const verdict = (edit: (slides: Slide[]) => void) => judgeCarouselPlan(plan(edit));
    expect(verdict(slides => { slides[0] = slide(1, { callouts: [] }); }).ok).toBe(false);
    expect(verdict(slides => { slides[3] = slide(4, { callouts: [] }); }).ok).toBe(false);
  });
  it('the last slide always carries the comment call, whatever the AI wrote, and never the bio', () => {
    for (const written of [null, 'Comente já', 'Comenta eu quero']) {
      const verdict = judgeCarouselPlan(plan(slides => { slides[5] = slide(6, { headline: 'Quer a sua?', callouts: [], cta: written }); }));
      expect(verdict.ok && verdict.plan.slides[5]?.cta).toBe(CTA_TEXT);
    }
    const bio = judgeCarouselPlan(plan(slides => { slides[2] = slide(3, { callouts: ['Link na bio'] }); }));
    expect(bio.ok).toBe(false); expect(bio.ok ? '' : bio.problems.join(' ')).toMatch(/não mande ninguém para a bio/);
    expect(judgeCarouselPlan(plan(slides => { slides[5] = slide(6, { headline: 'Quer a sua?', callouts: [], cta: 'Link na bio' }); })).ok).toBe(true); // replaced by the fixed call
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
  it('refuses a camera angle used twice, and slides that show almost the same picture', () => {
    const twice = judgeCarouselPlan(plan(slides => { slides[4] = slide(5, { camera: 'close_up' }); }));
    expect(twice.ok).toBe(false); expect(twice.ok ? '' : twice.problems.join(' ')).toMatch(/os slides 1 e 5 usam o mesmo ângulo de câmera \(close_up\)/);
    const alike = judgeCarouselPlan(plan(slides => { for (let i = 1; i < 6; i++) slides[i] = { ...(slides[i] as Slide), shot: SHOTS[0] as string }; }));
    expect(alike.ok).toBe(false); expect(alike.ok ? '' : alike.problems.join(' ')).toMatch(/quase a mesma imagem/);
  });
  it('a callout is at most three and short, and a headline fits the image', () => {
    expect(carouselPlanSchema.safeParse(JSON.parse(plan(slides => { slides[1] = slide(2, { callouts: ['a1', 'b2', 'c3', 'd4'] }); }))).success).toBe(false);
    expect(carouselPlanSchema.safeParse(JSON.parse(plan(slides => { slides[1] = slide(2, { callouts: ['Um texto de destaque comprido demais'] }); }))).success).toBe(false);
    expect(carouselPlanSchema.safeParse(JSON.parse(plan(slides => { slides[0] = slide(1, { headline: 'Um título comprido demais para caber inteiro na imagem' }); }))).success).toBe(false);
  });
});

describe('the image prompt of a slide', () => {
  const parsed = judgeCarouselPlan(plan());
  const data = parsed.ok ? parsed.plan : (null as never);
  it('gives every text word for word, the camera, and keeps the text inside the image', () => {
    const cover = buildCarouselImagePrompt(data, data.slides[0] as Slide, 0);
    expect(cover).toMatch(/1:1/); expect(cover).toMatch(/slide 1 de 6/); expect(cover).toContain('sala aconchegante de Natal'); expect(cover).toContain('plano fechado (close)');
    expect(cover).toContain('Título: "Já viu uma caneca assim?"'); expect(cover).toContain('Subtítulo logo abaixo do título: "Um encanto em cada detalhe"'); expect(cover).toContain('Selo arredondado: "Modo Natal"');
    expect(cover).toMatch(/EXATAMENTE os textos abaixo/); expect(cover).toMatch(/idêntico ao da foto/); expect(cover).toMatch(/Não escreva nenhum outro texto, número, preço/);
    expect(cover).toMatch(/INTEIRO dentro da imagem, com margem de segurança de 10%/); expect(cover).toMatch(/no máximo 2 linhas/); expect(cover).toMatch(/NÃO copie o enquadramento, o fundo, a pose nem a composição/);
    const detail = buildCarouselImagePrompt(data, data.slides[1] as Slide, 1);
    expect(detail).toContain('seta fina e curva'); expect(detail).toContain('"Papai Noel em relevo"'); expect(detail).toContain('"Cerâmica • 330 ml"'); expect(detail).not.toContain('Título:'); expect(detail).toContain('Mãos segurando a caneca');
    const last = buildCarouselImagePrompt(data, data.slides[5] as Slide, 5);
    expect(last).toContain('Chamada final em um botão ou faixa arredondada: "Comenta EU QUERO"');
  });
  it('every slide asks for a different camera', () => {
    const labels = data.slides.map((s: Slide, i: number) => buildCarouselImagePrompt(data, s, i).split('\n').find(line => line.startsWith('Enquadramento')));
    expect(new Set(labels).size).toBe(6);
  });
  it('quotes are never broken by the texts', () => {
    const prompt = buildCarouselImagePrompt(data, slide(2, { callouts: ['Texto "entre aspas"'] }), 1);
    expect(prompt).toContain('"Texto \'entre aspas\'"');
  });
  it('the slides are square', () => { expect(CAROUSEL_IMAGE_SIZE).toBe('1024x1024'); });
});
