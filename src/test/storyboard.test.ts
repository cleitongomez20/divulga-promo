import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import { estimateOpenAiImageCostMicros } from '@/lib/openai';
import { OPENAI_IMAGE_EDITS_URL, OPENAI_IMAGE_GENERATIONS_URL, OPENAI_URL, OpenAiError, askOpenAiImage, callOpenAiImage, connectOpenAiKey } from '@/lib/openai.server';
import { switchProvider } from '@/lib/ai.server';
import { CTA_TEXT, SCENE_COUNT, SHOT_TYPES, buildPlanPrompt, buildScenePrompt, judgePlan, planSchema, similarity, type StoryboardPlan } from '@/lib/storyboard';
import { discardStoryboard, generateScene, listStoryboardProducts, listStoryboards, loadStoryboard, planStoryboard } from '@/lib/storyboard.server';

const NOW = Date.parse('2026-11-13T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const KEY = 'sk-proj-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const PRODUCT_URL = 'https://down-br.img.susercontent.com/file/abc123.jpg';

const CAMERAS = ['close_up', 'wide', 'top_down', 'macro', 'low_angle', 'side'];
const SHOTS = [
  'Mãos apresentam o organizador fechado diante da câmera sobre uma mesa de madeira clara',
  'Mãos abrem a caixa de papelão e retiram o organizador com cuidado, embalagem aberta ao lado',
  'Mãos posicionam o suporte na parede e apertam as presilhas laterais com uma chave pequena',
  'Detalhe das presilhas metálicas encaixadas e da textura do acabamento em foco',
  'Parede inteira com tudo instalado, utensílios pendurados em ordem e luz da janela',
  'Mãos apontam para o conjunto pronto, cozinha organizada ao fundo, final da história',
];
const HANDS = 'Mãos de mulher adulta, pele clara, unhas curtas com esmalte nude';
const scene = (n: number, extra: Record<string, unknown> = {}) => ({ title: `Cena ${n}`, camera: CAMERAS[n - 1], action: `Ação ${n}: as mãos fazem algo diferente`, shot: SHOTS[n - 1], motion: 'câmera se aproxima devagar', speech: `Olha esse detalhe ${n}`, on_screen_text: null, ...extra });
/** A good POV narration line (10 words): between the shortest and the longest a 5-second scene may have. */
const NARRATION = (n: number) => `Olha esse detalhe que deixa tudo mais organizado, cena ${n}`;
const NARRATION_SCENE = (n: number) => ({ speech: NARRATION(n) });
const planJson = (overrides: Record<string, unknown> = {}, perScene: (n: number) => Record<string, unknown> = () => ({})) => JSON.stringify({
  concept: 'Mostrar o fone no dia a dia', presenter: 'Mulher de 30 anos, cabelo castanho preso, camiseta branca',
  scenes: Array.from({ length: SCENE_COUNT }, (_, i) => scene(i + 1, perScene(i + 1))), ...overrides,
});

describe('storyboard plan rules', () => {
  it('needs exactly six scenes and reads an empty text as none', () => {
    expect(planSchema.safeParse(JSON.parse(planJson())).success).toBe(true);
    expect(planSchema.safeParse(JSON.parse(planJson({ scenes: [scene(1)] }))).success).toBe(false);
    const parsed = planSchema.parse(JSON.parse(planJson({ presenter: '' }, () => ({ speech: '', on_screen_text: '  ' }))));
    expect(parsed.presenter).toBeNull(); expect(parsed.scenes[0]).toMatchObject({ speech: null, on_screen_text: null });
  });
  it('the prompt carries the rules of each mode', () => {
    const withSpeech = buildPlanPrompt({ title: 'Fone Bluetooth' }, { withSpeech: true });
    expect(withSpeech.system).toMatch(/personagem que fala/); expect(withSpeech.system).toMatch(/Proibido: dizer que comprou, usou/);
    expect(withSpeech.user).toContain('Fone Bluetooth');
    const silent = buildPlanPrompt({ title: 'Fone' }, { withSpeech: false });
    expect(silent.system).toMatch(/narração em off/); expect(silent.system).toMatch(/todo vídeo tem narração/); expect(silent.system).not.toMatch(/personagem que fala/); expect(silent.system).not.toMatch(/não tem fala/);
    expect(silent.system).toMatch(/de 7 a 12 palavras/); expect(silent.system).toMatch(/Olha esse…/); expect(silent.system).toMatch(/a chamada é só o texto na tela/);
    expect(buildPlanPrompt({ title: 'Fone' }, { withSpeech: false, maxSpeechWords: 6 }).system).toMatch(/de 3 a 6 palavras/);
    expect(silent.system).toMatch(/exatamente 6 cenas/);
  });
  it('accepts a good plan, even wrapped in a code block', () => {
    const verdict = judgePlan('```json\n' + planJson() + '\n```', { withSpeech: true });
    expect(verdict.ok).toBe(true);
  });
  it('refuses an answer that is not JSON or not six scenes', () => {
    expect(judgePlan('oi, tudo bem?', { withSpeech: true })).toMatchObject({ ok: false, problems: ['a resposta não é um JSON válido'] });
    expect(judgePlan(planJson({ scenes: [scene(1), scene(2)] }), { withSpeech: true }).ok).toBe(false);
  });
  it('refuses prices, discounts, urgency and links in the speech and on-screen text', () => {
    const bad = (extra: Record<string, unknown>) => judgePlan(planJson({}, n => (n === 2 ? extra : {})), { withSpeech: true });
    expect(bad({ speech: 'Por apenas R$ 49 você leva' }).ok).toBe(false);
    expect(bad({ speech: 'Olha esse desconto de 30%' }).ok).toBe(false);
    expect(bad({ on_screen_text: 'Últimas unidades' }).ok).toBe(false);
    expect(bad({ on_screen_text: 'www.loja.com' }).ok).toBe(false);
  });
  it('refuses personal use, results and testimonials in the speech', () => {
    for (const speech of ['Eu comprei e amei', 'Já usei e resolveu o meu problema', 'Testei esse fone ontem']) {
      const verdict = judgePlan(planJson({}, n => (n === 3 ? { speech } : {})), { withSpeech: true });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.problems.join(' ')).toMatch(/cena 3/);
    }
    expect(judgePlan(planJson({}, () => ({ speech: 'Olha o que eu encontrei' })), { withSpeech: true }).ok).toBe(true);
  });
  it('needs a presenter and speech in every scene, in both modes: the POV video is always narrated', () => {
    expect(judgePlan(planJson({ presenter: null }), { withSpeech: true }).ok).toBe(false);
    expect(judgePlan(planJson({}, n => (n === 4 ? { speech: null } : {})), { withSpeech: true }).ok).toBe(false);
    expect(judgePlan(planJson({ presenter: HANDS }, NARRATION_SCENE), { withSpeech: false }).ok).toBe(true);
    expect(judgePlan(planJson({ presenter: HANDS }, () => ({ speech: null })), { withSpeech: false }).ok).toBe(false); // POV is never silent
    expect(judgePlan(planJson({ presenter: null }, NARRATION_SCENE), { withSpeech: false }).ok).toBe(false); // the hands must be described
  });
  it('checks the length of the POV narration: not too long, not too short, and the last scene may be short', () => {
    const verdict = (perScene: (n: number) => Record<string, unknown>, options: { maxSpeechWords?: number } = {}) => judgePlan(planJson({ presenter: HANDS }, perScene), { withSpeech: false, ...options });
    expect(verdict(NARRATION_SCENE).ok).toBe(true);
    const tooLong = verdict(n => ({ speech: n === 3 ? 'Olha esse detalhe incrível que organiza tudo na sua bancada de um jeito lindo' : NARRATION(n) }));
    expect(tooLong.ok).toBe(false); if (!tooLong.ok) expect(tooLong.problems.join(' ')).toMatch(/narração da cena 3 tem 14 palavras, e o máximo é 12/);
    const tooShort = verdict(n => ({ speech: n === 2 ? 'Olha esse detalhe' : NARRATION(n) }));
    expect(tooShort.ok).toBe(false); if (!tooShort.ok) expect(tooShort.problems.join(' ')).toMatch(/narração da cena 2 tem só 3 palavras, e o mínimo é 7/);
    expect(verdict(n => ({ speech: n === 6 ? 'Muita praticidade!' : NARRATION(n) })).ok).toBe(true); // the closing line is short
    expect(verdict(n => ({ speech: n === 6 ? 'Lindo' : NARRATION(n) })).ok).toBe(false);
    expect(verdict(NARRATION_SCENE, { maxSpeechWords: 8 }).ok).toBe(false); // 10 words, and the video allows 8
  });
  it('keeps the rules of the captions in the narration: no testimonial, price, urgency, bio or call to comment', () => {
    const verdict = (speech: string) => judgePlan(planJson({ presenter: HANDS }, n => ({ speech: n === 4 ? speech : NARRATION(n) })), { withSpeech: false });
    expect(verdict('Olha esse detalhe que deixa tudo mais organizado').ok).toBe(true);
    expect(verdict('Eu comprei e amei esse organizador para a minha casa').ok).toBe(false);
    expect(verdict('Olha esse preço, só hoje por apenas dez reais agora').ok).toBe(false);
    expect(verdict('Corre e comenta eu quero para receber o link do produto').ok).toBe(false);
    expect(verdict('Clica no link da bio para conferir esse organizador lindo').ok).toBe(false);
  });
  it('the scene prompt keeps the real product and asks for the same person only when a second reference exists', () => {
    const plan = JSON.parse(planJson()) as StoryboardPlan;
    const first = buildScenePrompt(plan, plan.scenes[0]!, 0, { samePersonReference: false });
    expect(first).toMatch(/cena 1 de 6/); expect(first).toMatch(/idêntico ao da foto/); expect(first).toContain('Mulher de 30 anos'); expect(first).not.toMatch(/mesma pessoa/);
    expect(buildScenePrompt(plan, plan.scenes[1]!, 1, { samePersonReference: true })).toMatch(/mesma pessoa/);
    const silentPlan = { ...plan, presenter: null };
    expect(buildScenePrompt(silentPlan, plan.scenes[0]!, 0, { samePersonReference: false })).not.toMatch(/Pessoa na cena/);
  });
});

describe('image cost', () => {
  it('prices text input, image input and image output by token', () => {
    expect(estimateOpenAiImageCostMicros({ inputTokens: 800, textInputTokens: 300, imageInputTokens: 500, outputTokens: 1056 })).toBe(300 * 5 + 500 * 8 + 1056 * 30);
  });
  it('prices all the input as image input when the API does not split it', () => {
    expect(estimateOpenAiImageCostMicros({ inputTokens: 1000, textInputTokens: null, imageInputTokens: null, outputTokens: 1000 })).toBe(1000 * 8 + 1000 * 30);
  });
});

const IMAGE_BYTES = new Uint8Array(2000).fill(7);
const IMAGE_B64 = Buffer.from(IMAGE_BYTES).toString('base64');
const imageOk = (extra: Record<string, unknown> = {}) => ({ data: [{ b64_json: IMAGE_B64 }], usage: { input_tokens: 800, input_tokens_details: { text_tokens: 300, image_tokens: 500 }, output_tokens: 1056 }, ...extra });
const IMAGE_COST = 300 * 5 + 500 * 8 + 1056 * 30;

type Call = { url: string; init: RequestInit };
function router(handlers: Record<string, (call: Call, index: number) => { status?: number; json?: unknown; bytes?: Uint8Array }>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }; calls.push(call);
    const handler = Object.entries(handlers).find(([prefix]) => call.url.startsWith(prefix))?.[1];
    if (!handler) return new Response('not found', { status: 404 });
    const reply = handler(call, calls.filter(item => item.url === call.url).length - 1);
    if (reply.bytes) return new Response(reply.bytes as BodyInit, { status: reply.status ?? 200 });
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls, count: (prefix: string) => calls.filter(call => call.url.startsWith(prefix)).length };
}

describe('callOpenAiImage', () => {
  it('uses the edits endpoint with the reference photos and asks for a JPEG', async () => {
    const r = router({ [OPENAI_IMAGE_EDITS_URL]: () => ({ json: imageOk() }) });
    const result = await callOpenAiImage(r.fetcher, { apiKey: KEY, model: 'gpt-image-2.6-flare', prompt: 'Cena', references: [new Uint8Array(10), new Uint8Array(20)], safetyId: 'abc' });
    expect(result.bytes.length).toBe(2000); expect(result).toMatchObject({ inputTokens: 800, outputTokens: 1056, textInputTokens: 300, imageInputTokens: 500 });
    const call = r.calls[0]!; const form = call.init.body as FormData;
    expect(call.url).toBe(OPENAI_IMAGE_EDITS_URL);
    expect((call.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
    expect(form.get('model')).toBe('gpt-image-2.6-flare'); expect(form.get('output_format')).toBe('jpeg'); expect(form.get('size')).toBe('1024x1536'); expect(form.get('quality')).toBe('medium');
    expect(form.get('safety_identifier')).toBe('abc'); expect(form.getAll('image[]')).toHaveLength(2);
  });
  it('uses the generations endpoint when there is no reference', async () => {
    const r = router({ [OPENAI_IMAGE_GENERATIONS_URL]: () => ({ json: imageOk() }) });
    await callOpenAiImage(r.fetcher, { apiKey: KEY, model: 'gpt-image-2.6-flare', prompt: 'Cena', references: [] });
    expect(r.calls[0]?.url).toBe(OPENAI_IMAGE_GENERATIONS_URL);
    expect(JSON.parse(String(r.calls[0]?.init.body))).toMatchObject({ model: 'gpt-image-2.6-flare', prompt: 'Cena', output_format: 'jpeg', n: 1 });
  });
  it('explains the refusals and the empty answers', async () => {
    const kind = async (reply: { status?: number; json?: unknown }) => {
      const r = router({ [OPENAI_IMAGE_GENERATIONS_URL]: () => reply });
      try { await callOpenAiImage(r.fetcher, { apiKey: KEY, model: 'm', prompt: 'p', references: [] }); return 'none'; } catch (error) { return error instanceof OpenAiError ? error.kind : 'other'; }
    };
    expect(await kind({ status: 400, json: { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } } })).toBe('moderation');
    expect(await kind({ status: 403, json: { error: { message: 'Your organization must be verified to use the model.' } } })).toBe('permission');
    expect(await kind({ status: 401, json: { error: { code: 'invalid_api_key' } } })).toBe('auth');
    expect(await kind({ json: { data: [] } })).toBe('server');
    expect(await kind({ json: { data: [{ b64_json: Buffer.from('curto').toString('base64') }] } })).toBe('server');
  });
});

const seed = (extra: Record<string, Rows> = {}): Record<string, Rows> => ({
  settings: [], connector_secrets: [], openai_connections: [], openai_usage: [], ai_connections: [], ai_settings: [], activity_log: [],
  instagram_accounts: [{ id: 'ig1', user_id: U, created_at: '2026-10-01T00:00:00.000Z' }],
  products: [{ id: 'p1', user_id: U, marketplace: 'shopee', title: 'Fone de ouvido Bluetooth', images: [PRODUCT_URL], collected_at: '2026-11-10T00:00:00.000Z' },
    { id: 'p2', user_id: U, marketplace: 'shopee', title: 'Sem foto válida', images: ['https://evil.example/x.jpg'], collected_at: '2026-11-09T00:00:00.000Z' },
    { id: 'p3', user_id: 'other', marketplace: 'shopee', title: 'De outra pessoa', images: [PRODUCT_URL], collected_at: '2026-11-08T00:00:00.000Z' }],
  video_assets: [], storyboards: [], storyboard_scenes: [], ...extra,
});
function withStorage(built: ReturnType<typeof memoryDb>) {
  const files = new Map<string, Uint8Array>();
  const storage = { from: () => ({
    upload: async (path: string, bytes: Uint8Array) => { files.set(path, bytes); return { error: null }; },
    download: async (path: string) => { const bytes = files.get(path); return bytes ? { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null } : { data: null, error: { message: 'missing' } }; },
    remove: async (paths: string[]) => { paths.forEach(path => files.delete(path)); return { error: null }; },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}?t=1` }, error: null }),
  }) };
  return { ...built, db: { ...built.db, storage } as never, files };
}
const photoBytes = () => { const bytes = new Uint8Array(6000).fill(9); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; return bytes; };
const textReply = (text: string) => ({ json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 400, output_tokens: 900 } } });

async function ready(options: { planText?: string; images?: (call: Call, index: number) => { status?: number; json?: unknown } } = {}) {
  const env = withStorage(memoryDb(seed()));
  const connectFetch = router({ [OPENAI_URL]: () => textReply('ok') });
  await connectOpenAiKey(env.db, { userId: U, masterKey: MASTER, apiKey: KEY, model: 'gpt-6.1-terra', capCents: null, fetcher: connectFetch.fetcher, now: () => NOW });
  expect(await switchProvider(env.db, U, 'openai')).toMatchObject({ ok: true });
  env.tables['openai_usage']!.length = 0;
  const r = router({
    [OPENAI_URL]: () => textReply(options.planText ?? planJson()),
    [PRODUCT_URL]: () => ({ bytes: photoBytes() }),
    [OPENAI_IMAGE_EDITS_URL]: options.images ?? (() => ({ json: imageOk() })),
  });
  return { ...env, r };
}
const planIt = (env: Awaited<ReturnType<typeof ready>>, withSpeech = true) => planStoryboard(env.db, { userId: U, masterKey: MASTER, productId: 'p1', withSpeech, fetcher: env.r.fetcher, now: () => NOW });
const draw = (env: Awaited<ReturnType<typeof ready>>, sceneId: string, at = NOW) => generateScene(env.db, { userId: U, masterKey: MASTER, sceneId, fetcher: env.r.fetcher, now: () => at });
const sceneIds = (env: Awaited<ReturnType<typeof ready>>) => (env.tables['storyboard_scenes'] as Record<string, unknown>[]).sort((a, b) => Number(a['position']) - Number(b['position'])).map(row => String(row['id']));

describe('products for a storyboard', () => {
  it('lists only the user\'s Shopee products with a photo from a Shopee host', async () => {
    const { db } = memoryDb(seed());
    expect(await listStoryboardProducts(db as never, U)).toEqual([{ id: 'p1', title: 'Fone de ouvido Bluetooth' }]);
  });
});

describe('planning a storyboard', () => {
  it('plans six scenes with the active AI, saves the real photo and creates the scenes waiting', async () => {
    const env = await ready();
    const { storyboardId, costMicros } = await planIt(env);
    expect(costMicros).toBe(400 * 1 + 900 * 5);
    expect(env.tables['storyboards']?.[0]).toMatchObject({ id: storyboardId, user_id: U, product_id: 'p1', product_title: 'Fone de ouvido Bluetooth', status: 'planned', with_speech: true, instagram_account_id: 'ig1', cost_micros: costMicros });
    const scenes = env.tables['storyboard_scenes'] as Record<string, unknown>[];
    expect(scenes).toHaveLength(SCENE_COUNT); expect(scenes.map(row => row['position'])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(scenes.every(row => row['status'] === 'pending' && row['storyboard_id'] === storyboardId)).toBe(true);
    expect(env.tables['video_assets']?.[0]).toMatchObject({ source: 'product', media_type: 'image', instagram_account_id: 'ig1' });
    expect(env.files.size).toBe(1);
    expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(0); // planning draws nothing
    expect(env.tables['openai_usage']).toHaveLength(1); expect(env.tables['openai_usage']?.[0]).toMatchObject({ purpose: 'storyboard' });
  });
  it('sends the problems back once and accepts the corrected plan', async () => {
    const answers = [planJson({}, n => (n === 1 ? { speech: 'Eu comprei e amei' } : {})), planJson()];
    const env = await ready();
    let index = 0; const r = router({ [OPENAI_URL]: () => textReply(answers[index++] ?? planJson()), [PRODUCT_URL]: () => ({ bytes: photoBytes() }) });
    const planned = await planStoryboard(env.db, { userId: U, masterKey: MASTER, productId: 'p1', withSpeech: true, fetcher: r.fetcher, now: () => NOW });
    expect(planned.costMicros).toBe(2 * (400 + 4500));
    expect(String((JSON.parse(String(r.calls[1]?.init.body)) as { input: { content: string }[] }).input.at(-1)?.content)).toMatch(/recusado pelas regras/);
  });
  it('gives up after two refused answers and creates nothing', async () => {
    const env = await ready({ planText: 'não é json' });
    await expect(planIt(env)).rejects.toThrow(/dentro das regras/);
    expect(env.tables['storyboards']).toHaveLength(0); expect(env.tables['video_assets']).toHaveLength(0); expect(env.files.size).toBe(0);
    expect(env.tables['activity_log']?.at(-1)).toMatchObject({ action: 'Storyboard recusado pelas regras' });
  });
  it('asks to connect OpenAI before spending anything on text', async () => {
    const env = withStorage(memoryDb(seed()));
    const r = router({ [OPENAI_URL]: () => textReply(planJson()) });
    await expect(planStoryboard(env.db, { userId: U, masterKey: MASTER, productId: 'p1', withSpeech: true, fetcher: r.fetcher, now: () => NOW })).rejects.toThrow(/conecte a OpenAI/);
    expect(r.calls).toHaveLength(0);
  });
  it('refuses a product that is not the user\'s or has no usable photo', async () => {
    const env = await ready();
    for (const productId of ['p2', 'p3', 'missing']) {
      await expect(planStoryboard(env.db, { userId: U, masterKey: MASTER, productId, withSpeech: true, fetcher: env.r.fetcher, now: () => NOW })).rejects.toThrow(/Não encontrei esse produto/);
    }
    expect(env.r.calls.filter(call => call.url === OPENAI_URL)).toHaveLength(0);
  });
  it('saves nothing when the product photo cannot be downloaded', async () => {
    const env = await ready();
    const r = router({ [OPENAI_URL]: () => textReply(planJson()), [PRODUCT_URL]: () => ({ status: 500, json: {} }) });
    await expect(planStoryboard(env.db, { userId: U, masterKey: MASTER, productId: 'p1', withSpeech: true, fetcher: r.fetcher, now: () => NOW })).rejects.toThrow(/foto utilizável/);
    expect(env.tables['storyboards']).toHaveLength(0);
  });
});

describe('drawing the scenes', () => {
  it('draws the first scene from the product photo alone, stores it and records the cost', async () => {
    const env = await ready(); const { storyboardId } = await planIt(env); const [first] = sceneIds(env);
    env.tables['openai_usage']!.length = 0;
    const result = await draw(env, first!);
    expect(result).toMatchObject({ sceneId: first, costMicros: IMAGE_COST, storyboardStatus: 'generating', skipped: null });
    const call = env.r.calls.find(item => item.url === OPENAI_IMAGE_EDITS_URL)!; const form = call.init.body as FormData;
    expect(form.getAll('image[]')).toHaveLength(1);
    expect(String(form.get('prompt'))).toMatch(/cena 1 de 6/); expect(form.get('model')).toBe('gpt-image-2.6-flare');
    const row = (env.tables['storyboard_scenes'] as Record<string, unknown>[]).find(item => item['id'] === first)!;
    expect(row).toMatchObject({ status: 'done', cost_micros: IMAGE_COST, last_error: null, attempts: 1 });
    expect(env.tables['video_assets']?.find(asset => asset['id'] === row['asset_id'])).toMatchObject({ source: 'ai_image', mime_type: 'image/jpeg', media_type: 'image', size_bytes: 2000, instagram_account_id: 'ig1' });
    expect(env.tables['openai_usage']).toHaveLength(1); expect(env.tables['openai_usage']?.[0]).toMatchObject({ purpose: 'imagem', model: 'gpt-image-2.6-flare', cost_micros: IMAGE_COST });
    expect((env.tables['storyboards']?.find(board => board['id'] === storyboardId) as Record<string, unknown>)['cost_micros']).toBe(4900 + IMAGE_COST);
  });
  it('uses the first finished scene as a second reference to keep the same person', async () => {
    const env = await ready(); await planIt(env); const ids = sceneIds(env);
    await draw(env, ids[0]!); await draw(env, ids[1]!);
    const forms = env.r.calls.filter(call => call.url === OPENAI_IMAGE_EDITS_URL).map(call => call.init.body as FormData);
    expect(forms[0]?.getAll('image[]')).toHaveLength(1); expect(forms[1]?.getAll('image[]')).toHaveLength(2);
    expect(String(forms[1]?.get('prompt'))).toMatch(/mesma pessoa/);
  });
  it('does not ask for a second reference when the video has no person', async () => {
    const env = await ready({ planText: planJson({ presenter: HANDS }, NARRATION_SCENE) }); await planIt(env, false); const ids = sceneIds(env);
    await draw(env, ids[0]!); await draw(env, ids[1]!);
    const forms = env.r.calls.filter(call => call.url === OPENAI_IMAGE_EDITS_URL).map(call => call.init.body as FormData);
    expect(forms[1]?.getAll('image[]')).toHaveLength(1); expect(String(forms[1]?.get('prompt'))).not.toMatch(/mesma pessoa/);
  });
  it('marks the storyboard ready when the sixth scene is drawn, with the cost of everything', async () => {
    const env = await ready(); const { storyboardId } = await planIt(env);
    let last;
    for (const id of sceneIds(env)) last = await draw(env, id);
    expect(last).toMatchObject({ storyboardStatus: 'ready' });
    const board = env.tables['storyboards']?.find(item => item['id'] === storyboardId) as Record<string, unknown>;
    expect(board).toMatchObject({ status: 'ready', cost_micros: 4900 + SCENE_COUNT * IMAGE_COST });
    expect(env.tables['video_assets']).toHaveLength(1 + SCENE_COUNT);
  });
  it('never draws (or pays for) the same scene twice', async () => {
    const env = await ready(); await planIt(env); const [first] = sceneIds(env);
    await draw(env, first!);
    expect(await draw(env, first!)).toMatchObject({ skipped: 'done', costMicros: 0 });
    expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(1);
  });
  it('skips a scene another request is drawing, but takes over one abandoned for minutes', async () => {
    const env = await ready(); await planIt(env); const [first] = sceneIds(env);
    const row = (env.tables['storyboard_scenes'] as Record<string, unknown>[]).find(item => item['id'] === first)!;
    Object.assign(row, { status: 'generating', updated_at: new Date(NOW - 30_000).toISOString() });
    expect(await draw(env, first!)).toMatchObject({ skipped: 'busy' }); expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(0);
    Object.assign(row, { updated_at: new Date(NOW - 10 * 60_000).toISOString() });
    expect(await draw(env, first!)).toMatchObject({ skipped: null }); expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(1);
  });
  it('marks the scene failed with a readable reason, and a retry works', async () => {
    let fail = true;
    const env = await ready({ images: () => (fail ? { status: 400, json: { error: { code: 'moderation_blocked', message: 'rejected by the safety system' } } } : { json: imageOk() }) });
    await planIt(env); const [first] = sceneIds(env);
    await expect(draw(env, first!)).rejects.toThrow(/política de segurança/);
    const row = () => (env.tables['storyboard_scenes'] as Record<string, unknown>[]).find(item => item['id'] === first)!;
    expect(row()).toMatchObject({ status: 'failed' }); expect(String(row()['last_error'])).toMatch(/política de segurança/);
    expect(env.tables['video_assets']).toHaveLength(1); expect(env.tables['openai_usage']?.filter(usage => usage['purpose'] === 'imagem')).toHaveLength(0);
    fail = false;
    await expect(draw(env, first!)).resolves.toMatchObject({ skipped: null });
    expect(row()).toMatchObject({ status: 'done', attempts: 2, last_error: null });
  });
  it('stops at the monthly cap when the user set one', async () => {
    const env = await ready(); await planIt(env); const [first] = sceneIds(env);
    (env.tables['openai_connections']![0] as Record<string, unknown>)['monthly_cap_cents'] = 100;
    env.tables['openai_usage']!.push({ id: 'big', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 2_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    await expect(draw(env, first!)).rejects.toThrow(/teto de gasto/);
    expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(0);
  });
  it('does not touch another user\'s scene, a missing one or a discarded storyboard', async () => {
    const env = await ready(); const { storyboardId } = await planIt(env); const [first] = sceneIds(env);
    await expect(generateScene(env.db, { userId: 'someone-else', masterKey: MASTER, sceneId: first!, fetcher: env.r.fetcher, now: () => NOW })).rejects.toThrow(/Não encontrei essa cena/);
    await expect(draw(env, 'missing')).rejects.toThrow(/Não encontrei essa cena/);
    expect(await discardStoryboard(env.db, U, storyboardId)).toBe(true);
    await expect(draw(env, first!)).rejects.toThrow(/descartado/);
    expect(env.r.count(OPENAI_IMAGE_EDITS_URL)).toBe(0);
  });
});

describe('reading storyboards', () => {
  it('shows the scenes in order with a temporary address for each finished image', async () => {
    const env = await ready(); const { storyboardId } = await planIt(env); const ids = sceneIds(env);
    await draw(env, ids[0]!);
    const view = (await loadStoryboard(env.db, U, storyboardId))!;
    expect(view).toMatchObject({ id: storyboardId, status: 'generating', productTitle: 'Fone de ouvido Bluetooth', withSpeech: true });
    expect(view.scenes.map(item => item.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(view.scenes[0]).toMatchObject({ status: 'done', speech: 'Olha esse detalhe 1' }); expect(view.scenes[0]?.imageUrl).toMatch(/^https:\/\/signed\.test\//);
    expect(view.scenes[1]).toMatchObject({ status: 'pending', imageUrl: null });
    expect(await loadStoryboard(env.db, 'someone-else', storyboardId)).toBeNull();
  });
  it('lists the latest storyboards with the images done, and leaves out the discarded ones', async () => {
    const env = await ready(); const first = await planIt(env); const ids = sceneIds(env);
    await draw(env, ids[0]!); await draw(env, ids[1]!);
    const second = await planIt(env);
    expect(await listStoryboards(env.db, U)).toHaveLength(2);
    expect((await listStoryboards(env.db, U)).find(item => item.id === first.storyboardId)).toMatchObject({ doneScenes: 2, totalScenes: 6, productTitle: 'Fone de ouvido Bluetooth' });
    await discardStoryboard(env.db, U, second.storyboardId);
    expect((await listStoryboards(env.db, U)).map(item => item.id)).toEqual([first.storyboardId]);
    expect(await discardStoryboard(env.db, 'someone-else', first.storyboardId)).toBe(false);
  });
});

describe('the story and the camera', () => {
  it('the prompt asks for a story of use, a different camera in every scene, POV hands and the fixed call to action', () => {
    const pov = buildPlanPrompt({ title: 'Painel ripado' }, { withSpeech: false }).system;
    expect(pov).toMatch(/UMA HISTÓRIA de uso do produto/); expect(pov).toMatch(/desembalar/); expect(pov).toMatch(/painel ripado/);
    for (const type of SHOT_TYPES) expect(pov).toContain(type);
    expect(pov).toMatch(/não repita nenhum/i); expect(pov).toMatch(/Formato POV/); expect(pov).toMatch(/SOMENTE AS MÃOS/); expect(pov).toMatch(/exatamente "Comenta EU QUERO"/); expect(pov).toMatch(/Nunca escreva "link na bio"/);
    const speaking = buildPlanPrompt({ title: 'Painel ripado' }, { withSpeech: true }).system;
    expect(speaking).toMatch(/personagem que fala/); expect(speaking).not.toMatch(/Formato POV/);
  });
  it('refuses a camera angle used twice, and says which scenes', () => {
    const verdict = judgePlan(planJson({}, n => (n === 4 ? { camera: 'close_up' } : {})), { withSpeech: true });
    expect(verdict.ok).toBe(false); expect(verdict.ok ? '' : verdict.problems.join(' ')).toMatch(/as cenas 1 e 4 usam o mesmo ângulo de câmera \(close_up\)/);
  });
  it('refuses scenes that describe almost the same picture', () => {
    const verdict = judgePlan(planJson({}, n => (n >= 2 ? { shot: SHOTS[0] as string } : {})), { withSpeech: true });
    expect(verdict.ok).toBe(false); expect(verdict.ok ? '' : verdict.problems.join(' ')).toMatch(/quase a mesma imagem/);
    expect(similarity(SHOTS[0] as string, SHOTS[1] as string)).toBeLessThan(0.3); expect(similarity(SHOTS[0] as string, SHOTS[0] as string)).toBe(1);
  });
  it('the last scene always carries the comment call, whatever the AI wrote', () => {
    for (const written of [null, 'Link na bio'.replace('bio', 'agora'), 'Comente já']) {
      const verdict = judgePlan(planJson({}, n => (n === 6 ? { on_screen_text: written } : {})), { withSpeech: true });
      expect(verdict.ok && verdict.plan.scenes[5]?.on_screen_text).toBe(CTA_TEXT);
    }
    expect(CTA_TEXT).toBe('Comenta EU QUERO');
  });
  it('refuses to send people to the bio', () => {
    const verdict = judgePlan(planJson({}, n => (n === 2 ? { on_screen_text: 'Link na bio' } : {})), { withSpeech: true });
    expect(verdict.ok).toBe(false); expect(verdict.ok ? '' : verdict.problems.join(' ')).toMatch(/não mande ninguém para a bio/);
  });
  it('the scene prompt gives the camera and the action, and says the reference photo is only for the look of the product', () => {
    const plan = JSON.parse(planJson()) as StoryboardPlan;
    const prompt = buildScenePrompt(plan, { title: 'Cena 3', shot: SHOTS[2] as string, camera: 'top_down', action: 'Mãos posicionam o suporte' }, 2, { samePersonReference: false });
    expect(prompt).toContain('vista de cima'); expect(prompt).toContain('Ação: Mãos posicionam o suporte.'); expect(prompt).toMatch(/NÃO copie o enquadramento, o fundo, a pose nem a composição/);
    expect(prompt).toMatch(/cena 3 de 6/);
  });
  it('POV describes only the hands and never asks for a second reference', () => {
    const prompt = buildScenePrompt({ presenter: HANDS }, { title: 'Cena 2', shot: SHOTS[1] as string, camera: 'wide', action: 'Mãos abrem a caixa' }, 1, { samePersonReference: true, pov: true });
    expect(prompt).toMatch(/SOMENTE as mãos/); expect(prompt).toMatch(/nunca rosto nem corpo/); expect(prompt).toContain(HANDS); expect(prompt).not.toMatch(/segunda imagem de referência/); expect(prompt).not.toMatch(/Pessoa na cena/);
    const speaking = buildScenePrompt(JSON.parse(planJson()) as StoryboardPlan, { title: 'Cena 2', shot: SHOTS[1] as string }, 1, { samePersonReference: true });
    expect(speaking).toMatch(/segunda imagem de referência/); expect(speaking).toMatch(/NÃO copie o enquadramento, a pose nem o cenário dela/);
  });
  it('a scene drawn in POV uses only the product photo and carries the camera and the action of the plan', async () => {
    const env = await ready({ planText: planJson({ presenter: HANDS }, NARRATION_SCENE) }); await planIt(env, false); const ids = sceneIds(env);
    await draw(env, ids[0]!); await draw(env, ids[2]!);
    const forms = env.r.calls.filter(call => call.url === OPENAI_IMAGE_EDITS_URL).map(call => call.init.body as FormData);
    expect(forms.every(form => form.getAll('image[]').length === 1)).toBe(true);
    expect(String(forms[1]?.get('prompt'))).toContain('vista de cima'); expect(String(forms[1]?.get('prompt'))).toContain('Ação 3: as mãos fazem algo diferente.');
    expect(String(forms[1]?.get('prompt'))).toMatch(/SOMENTE as mãos/);
  });
});
