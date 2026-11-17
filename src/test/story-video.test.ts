import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import { OPENAI_IMAGE_EDITS_URL, OPENAI_URL, connectOpenAiKey } from '@/lib/openai.server';
import { switchProvider } from '@/lib/ai.server';
import { sealJson } from '@/lib/secret-box.server';
import {
  STORY_SECONDS, STORY_TOOL_IDS, maxSpeechWords, buildStoryBody, buildStoryDirectionPrompt, buildStoryVideoPrompt, judgeStoryDirection, type StoryScene,
} from '@/lib/story-video';
import { startStoryContent } from '@/lib/story-video.server';
import { startVideoDraft } from '@/lib/video-brain.server';
import { advanceVideoJobs } from '@/lib/video-jobs.server';
import { SCENE_COUNT, type ShotType } from '@/lib/storyboard';
import type { ProductCandidate } from '@/lib/content-brain';
import { VIDEO_TOOLS } from '@/lib/video-brain';

const NOW = Date.parse('2026-11-14T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const KEY = 'sk-proj-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const PRODUCT_URL = 'https://down-br.img.susercontent.com/file/abc123.jpg';
const HF = 'https://api.higgsfield.ai';
const VIDEO_URL = 'https://cdn.higgsfield.test/out.mp4';
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const candidate: ProductCandidate = { id: 'prod-1', externalId: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, imageUrl: PRODUCT_URL, url: 'https://shopee.com.br/p', collectedAt: daysAgo(2) };
const direction = (extra: Record<string, unknown> = {}) => JSON.stringify({
  chosen_product_id: 'prod-1', reason: 'Boa nota e muitas vendas, combina com o tema', angle: 'organização do dia a dia', hook: 'Olha o que eu encontrei para a sua bancada',
  caption: 'Achei um jeitinho de deixar a bancada organizada.\nCabe tudo e ainda fica bonito, olha esse detalhe.', hashtags: ['#organizacao', '#casa', '#bancada', '#achadinhos', '#shopee'], tool: 'seedance_2_5', duration: 30, ...extra,
});
const CAMERAS: ShotType[] = ['close_up', 'wide', 'top_down', 'macro', 'low_angle', 'side'];
const SHOTS = [
  'Mãos apresentam o organizador fechado diante da câmera sobre uma mesa de madeira clara',
  'Mãos abrem a caixa de papelão e retiram o organizador com cuidado, embalagem aberta ao lado',
  'Mãos posicionam o suporte na parede e apertam as presilhas laterais com uma chave pequena',
  'Detalhe das presilhas metálicas encaixadas e da textura do acabamento em foco',
  'Parede inteira com tudo instalado, utensílios pendurados em ordem e luz da janela',
  'Mãos apontam para o conjunto pronto, cozinha organizada ao fundo, final da história',
];
const sceneList = (speech: boolean): StoryScene[] => Array.from({ length: SCENE_COUNT }, (_, i) => ({ shot: SHOTS[i] as string, motion: 'câmera se aproxima devagar', speech: speech ? `Olha esse detalhe ${i + 1}` : null, camera: CAMERAS[i] as ShotType, action: `Ação ${i + 1}` }));

describe('the storyboard video tools', () => {
  it('offers the four chosen tools, with the endpoints of the Higgsfield documentation', () => {
    expect([...STORY_TOOL_IDS]).toEqual(['seedance_2_5', 'wan_3_0', 'cinema_studio_4', 'ltx_2_5']);
    expect(VIDEO_TOOLS.seedance_2_5).toMatchObject({ endpoint: 'bytedance/seedance-2.5/reference-to-video', mode: 'reference' });
    expect(VIDEO_TOOLS.wan_3_0).toMatchObject({ endpoint: 'alibaba/wan-3.0/reference-to-video', mode: 'reference' });
    expect(VIDEO_TOOLS.cinema_studio_4).toMatchObject({ endpoint: 'higgsfield/cinema-studio/4.0', mode: 'reference' });
    expect(VIDEO_TOOLS.ltx_2_5).toMatchObject({ endpoint: 'lightricks/ltx-2.5/image-to-video/pro', mode: 'frame' });
  });
  it('reference tools take up to 30 seconds and the short-clip tool only 6, 8 or 10', () => {
    expect(VIDEO_TOOLS.seedance_2_5.durations).toContain(30); expect(VIDEO_TOOLS.wan_3_0.durations).toContain(30); expect(VIDEO_TOOLS.cinema_studio_4.durations).toContain(30);
    expect(VIDEO_TOOLS.seedance_2_5.durations).not.toContain(3); expect(VIDEO_TOOLS.ltx_2_5.durations).toEqual([6, 8, 10]);
  });
  it('the prompt lists the four tools with their durations and the rules, and tells whether there is speech', () => {
    const withSpeech = buildStoryDirectionPrompt('reel', [candidate], { withSpeech: true });
    for (const id of STORY_TOOL_IDS) expect(withSpeech.system).toContain(id);
    expect(withSpeech.system).toMatch(/de 4 a 30 segundos/); expect(withSpeech.system).toMatch(/Um personagem fala/); expect(withSpeech.system).not.toContain('kling');
    expect(withSpeech.system).toMatch(/Nunca escreva preço/); expect(withSpeech.user).toContain('prod-1');
    expect(buildStoryDirectionPrompt('story', [candidate], { withSpeech: false }).system).toMatch(/formato POV: só as mãos aparecem, sem rosto e sem fala/);
  });
});

describe('judging the AI direction', () => {
  const ids = new Set(['prod-1']);
  it('accepts a good Reels direction', () => {
    const verdict = judgeStoryDirection(direction(), 'reel', ids);
    expect(verdict.ok).toBe(true); expect(verdict.ok && verdict.output).toMatchObject({ tool: 'seedance_2_5', duration: 30 });
    expect(STORY_SECONDS).toEqual({ reel: 30, story: 15 });
  });
  it('refuses a tool that is not in the list, a duration the tool does not accept and an unknown product', () => {
    expect(judgeStoryDirection(direction({ tool: 'kling_2_6' }), 'reel', ids).ok).toBe(false);
    const long = judgeStoryDirection(direction({ tool: 'ltx_2_5', duration: 30 }), 'reel', ids);
    expect(long.ok).toBe(false); expect(long.ok ? '' : long.problems.join(' ')).toMatch(/duração 30 não é permitida para ltx_2_5/);
    expect(judgeStoryDirection(direction({ tool: 'ltx_2_5', duration: 10 }), 'story', ids).ok).toBe(true);
    expect(judgeStoryDirection(direction({ chosen_product_id: 'outro' }), 'reel', ids).ok).toBe(false);
    expect(judgeStoryDirection('não é json', 'reel', ids)).toMatchObject({ ok: false });
  });
  it('applies the caption rules: size, hashtags, prices and false urgency', () => {
    expect(judgeStoryDirection(direction({ caption: 'curta' }), 'reel', ids).ok).toBe(false);
    expect(judgeStoryDirection(direction({ hashtags: ['#um'] }), 'reel', ids).ok).toBe(false);
    expect(judgeStoryDirection(direction({ caption: 'Achei por apenas R$ 29,90 aproveite agora mesmo antes que acabe' }), 'reel', ids).ok).toBe(false);
    expect(judgeStoryDirection(direction({ caption: 'Últimas unidades, corre para garantir o seu organizador de bancada' }), 'reel', ids).ok).toBe(false);
  });
  it('a Story has no caption and no hashtags needed', () => {
    const verdict = judgeStoryDirection(direction({ caption: 'texto que será descartado no story', hashtags: [] }), 'story', ids);
    expect(verdict.ok && verdict.output.caption).toBe('');
  });
});

describe('the video prompt and the request body', () => {
  it('points each scene at its reference image, with the speech in Portuguese', () => {
    const prompt = buildStoryVideoPrompt('seedance_2_5', { scenes: sceneList(true), presenter: 'Mulher de 30 anos, camiseta branca', seconds: 30, withSpeech: true });
    for (let i = 1; i <= SCENE_COUNT; i++) expect(prompt).toContain(`Scene ${i} (Image ${i}`);
    expect(prompt).toMatch(/about 5 seconds/); expect(prompt).toContain('Brazilian Portuguese'); expect(prompt).toContain('"Olha esse detalhe 1"'); expect(prompt).toContain('same presenter');
    expect(prompt).toMatch(/Keep the product exactly/); expect(prompt).toMatch(/No text, captions, logos or watermarks/);
  });
  it('Cinema Studio refers to the images with its own tokens', () => {
    const prompt = buildStoryVideoPrompt('cinema_studio_4', { scenes: sceneList(true), presenter: null, seconds: 30, withSpeech: true });
    expect(prompt).toContain('<<<image_1>>>'); expect(prompt).toContain('<<<image_6>>>'); expect(prompt).not.toContain('Image 1');
  });
  it('without speech the video is silent and no line is said', () => {
    const prompt = buildStoryVideoPrompt('wan_3_0', { scenes: sceneList(false), presenter: null, seconds: 30, withSpeech: false });
    expect(prompt).toContain('No speech.'); expect(prompt).not.toContain('Brazilian Portuguese'); expect(prompt).not.toContain('presenter');
    const spoken = buildStoryVideoPrompt('wan_3_0', { scenes: sceneList(true), presenter: 'Pessoa', seconds: 30, withSpeech: false });
    expect(spoken).not.toContain('Olha esse detalhe');
  });
  it('POV: the camera is the viewer, only the hands appear, and every scene is a different moment with its own camera', () => {
    const prompt = buildStoryVideoPrompt('seedance_2_5', { scenes: sceneList(false), presenter: 'Mãos de mulher adulta, pele clara', seconds: 30, withSpeech: false });
    expect(prompt).toContain('First-person POV video'); expect(prompt).toContain('ONLY the hands'); expect(prompt).toContain('never a face or body'); expect(prompt).toContain('Mãos de mulher adulta, pele clara');
    expect(prompt).toContain('Ação 1.'); expect(prompt).toContain('Shot: close-up on the product'); expect(prompt).toContain('Shot: macro shot of a texture or material detail'); expect(prompt).toContain('different moment of one story');
    expect(prompt).toContain('No speech.'); expect(prompt).not.toContain('The same presenter');
    expect(buildStoryVideoPrompt('seedance_2_5', { scenes: sceneList(true), presenter: 'Mulher de 30 anos', seconds: 30, withSpeech: true })).not.toContain('POV');
  });
  it('the short-clip tool uses only the first scene', () => {
    const prompt = buildStoryVideoPrompt('ltx_2_5', { scenes: sceneList(true), presenter: 'Pessoa', seconds: 10, withSpeech: true });
    expect(prompt).toContain(SHOTS[0] as string); expect(prompt).not.toContain(SHOTS[1] as string); expect(prompt).not.toContain('Scene 1');
  });
  it('builds the body of each tool as the documentation lists it', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://files.test/${i + 1}.jpg`);
    expect(buildStoryBody('seedance_2_5', { prompt: 'p', imageUrls: urls.slice(0, 6), duration: 30, withSpeech: true })).toEqual({ prompt: 'p', duration: 30, aspect_ratio: '9:16', resolution: '720p', generate_audio: true, image_urls: urls.slice(0, 6) });
    expect(buildStoryBody('cinema_studio_4', { prompt: 'p', imageUrls: urls.slice(0, 6), duration: 30, withSpeech: false })).toMatchObject({ generate_audio: false, aspect_ratio: '9:16', resolution: '720p' });
    expect((buildStoryBody('wan_3_0', { prompt: 'p', imageUrls: urls, duration: 30, withSpeech: true })['image_urls'] as string[]).length).toBe(10);
    expect(buildStoryBody('ltx_2_5', { prompt: 'p', imageUrls: urls, duration: 10, withSpeech: false })).toEqual({ prompt: 'p', duration: 10, aspect_ratio: '9:16', resolution: '720p', generate_audio: false, image_url: urls[0] });
  });
});

// ---------- the whole process in the background ----------
const IMAGE_B64 = Buffer.from(new Uint8Array(2000).fill(7)).toString('base64');
const imageOk = () => ({ data: [{ b64_json: IMAGE_B64 }], usage: { input_tokens: 800, input_tokens_details: { text_tokens: 300, image_tokens: 500 }, output_tokens: 1056 } });
const textReply = (text: string) => ({ json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 400, output_tokens: 900 } } });
const planJson = (speech: boolean) => JSON.stringify({
  concept: 'Mostrar o organizador no dia a dia', presenter: speech ? 'Mulher de 30 anos, cabelo castanho preso, camiseta branca' : 'Mãos de mulher adulta, pele clara, unhas curtas com esmalte nude',
  scenes: Array.from({ length: SCENE_COUNT }, (_, i) => ({ title: `Cena ${i + 1}`, camera: CAMERAS[i], action: `Ação ${i + 1}: as mãos fazem algo diferente`, shot: SHOTS[i], motion: 'câmera se aproxima devagar', speech: speech ? `Olha esse detalhe ${i + 1}` : null, on_screen_text: null })),
});
const carouselPlanJson = () => JSON.stringify({
  concept: 'Mostrar como o organizador deixa a bancada em ordem', theme: 'cozinha clara e aconchegante, tons de madeira e branco, luz natural',
  slides: [
    { title: 'Capa', camera: CAMERAS[0], shot: SHOTS[0], headline: 'Já viu um organizador assim?', subheadline: 'Um jeito prático de organizar', badge: 'Modo organização', callouts: [], cta: null },
    ...[2, 3, 4, 5].map(n => ({ title: `Detalhe ${n}`, camera: CAMERAS[n - 1], shot: SHOTS[n - 1], headline: null, subheadline: null, badge: null, callouts: [`Detalhe ${n} do produto`, 'Cabe tudo'], cta: null })),
    { title: 'Chamada final', camera: CAMERAS[5], shot: SHOTS[5], headline: 'Quer o seu?', subheadline: null, badge: null, callouts: [], cta: 'Comenta EU QUERO' },
  ],
});
const photoBytes = () => { const bytes = new Uint8Array(6000).fill(9); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; return bytes; };
const mp4Bytes = () => { const bytes = new Uint8Array(4000).fill(1); bytes.set([0x66, 0x74, 0x79, 0x70], 4); return bytes; };

type Call = { url: string; init: RequestInit };
type Reply = { status?: number; json?: unknown; bytes?: Uint8Array };
function router(handlers: Record<string, (call: Call, index: number) => Reply>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }; calls.push(call);
    const handler = Object.entries(handlers).find(([prefix]) => call.url.startsWith(prefix))?.[1];
    if (!handler) return new Response('not found', { status: 404 });
    const reply = handler(call, calls.filter(item => item.url.startsWith(call.url)).length - 1);
    if (reply.bytes) return new Response(reply.bytes as BodyInit, { status: reply.status ?? 200 });
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls, to: (prefix: string) => calls.filter(call => call.url.startsWith(prefix)) };
}

async function world(options: { speech?: boolean | 'default'; hfConnected?: boolean; images?: (index: number) => Reply; order?: (index: number) => Reply; status?: () => Reply; texts?: string[] } = {}) {
  const files = new Map<string, Uint8Array>();
  const hfSecret = await sealJson({ keyId: 'a1b2c3d4-e5f6-4789-abcd-0123456789ab', keySecret: 'S3cr3t_VALUE-abcdefghijklmnopqrstuvwxyz012345' }, MASTER, U, 'higgsfield');
  const built = memoryDb({
    settings: [], connector_secrets: options.hfConnected === false ? [] : [{ id: 'sec-hf', user_id: U, ciphertext: hfSecret, key_version: 1 }],
    openai_connections: [], openai_usage: [], ai_connections: [], ai_settings: [], activity_log: [], automation_settings: options.speech === 'default' ? [] : [{ user_id: U, storyboard_speech: options.speech !== false }],
    media_connections: options.hfConnected === false ? [] : [{ id: 'm1', user_id: U, provider: 'higgsfield', credential_id: 'sec-hf', status: 'connected', monthly_cap_cents: null, last_tested_at: null, last_error: null }],
    media_usage: [], instagram_accounts: [{ id: 'ig1', user_id: U, created_at: '2026-10-01T00:00:00.000Z' }],
    products: [{ id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: candidate.title, price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images: [PRODUCT_URL], url: candidate.url, collected_at: daysAgo(2) }],
    posts: [], post_media: [], video_assets: [], storyboards: [], storyboard_scenes: [],
  } as Record<string, Rows>);
  const storage = { from: () => ({
    upload: async (path: string, bytes: Uint8Array) => { files.set(path, bytes); return { error: null }; },
    download: async (path: string) => { const bytes = files.get(path); return bytes ? { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null } : { data: null, error: { message: 'missing' } }; },
    remove: async (paths: string[]) => { paths.forEach(path => files.delete(path)); return { error: null }; },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }),
  }) };
  const db = { ...built.db, storage } as never;
  const texts = options.texts ?? [direction(), planJson(options.speech !== false && options.speech !== 'default')];
  const r = router({
    [OPENAI_URL]: (_call, index) => textReply(texts[Math.min(index, texts.length - 1)] as string),
    [PRODUCT_URL]: () => ({ bytes: photoBytes() }),
    [OPENAI_IMAGE_EDITS_URL]: (_call, index) => (options.images ? options.images(index) : { json: imageOk() }),
    [`${HF}/requests/`]: () => (options.status ? options.status() : { json: { status: 'completed', video: { url: VIDEO_URL } } }),
    [VIDEO_URL]: () => ({ bytes: mp4Bytes() }),
    [HF]: (_call, index) => (options.order ? options.order(index) : { json: { status: 'queued', request_id: `req-${index + 1}` } }),
  });
  await connectOpenAiKey(db, { userId: U, masterKey: MASTER, apiKey: KEY, model: 'gpt-6.1-terra', capCents: null, fetcher: router({ [OPENAI_URL]: () => textReply('ok') }).fetcher, now: () => NOW });
  await switchProvider(db, U, 'openai');
  built.tables['openai_usage']!.length = 0;
  return { ...built, db, files, r };
}
type World = Awaited<ReturnType<typeof world>>;
const start = (w: World, format: 'reel' | 'story' | 'carousel', extra: Record<string, unknown> = {}) =>
  startStoryContent(w.db, { userId: U, masterKey: MASTER, format, fetcher: w.r.fetcher, now: () => NOW, makeLink: async () => 'https://shope.ee/abc', ...extra });
const tick = (w: World, at = NOW) => advanceVideoJobs(w.db, { masterKey: MASTER, fetcher: w.r.fetcher, now: () => at });
const post = (w: World) => w.tables['posts']?.[0] as Record<string, unknown>;
const scenesDone = (w: World) => (w.tables['storyboard_scenes'] as Record<string, unknown>[]).filter(row => row['status'] === 'done').length;
const orders = (w: World) => w.r.calls.filter(call => call.url.startsWith(HF) && !call.url.startsWith(`${HF}/requests/`) && call.init.method === 'POST');

describe('starting a Reels with the storyboard', () => {
  it('picks the product and the tool, plans the storyboard and waits for the images, ordering nothing yet', async () => {
    const w = await world();
    const result = await start(w, 'reel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true } });
    expect(result).toMatchObject({ productTitle: candidate.title, tool: 'Seedance 2.5', duration: 30, estimatedMicros: Math.round(0.12 * 30 * 1_000_000), linkMissing: false });
    expect(post(w)).toMatchObject({ format: 'reel', status: 'rendering', source: 'ai', affiliate_link: 'https://shope.ee/abc', product_id: 'prod-1' });
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard', requestId: null, tool: 'seedance_2_5', duration: 30, withSpeech: true, endpoint: 'bytedance/seedance-2.5/reference-to-video' });
    expect(post(w)['ai_plan']).toMatchObject({ pipeline: 'storyboard', autoMode: 'auto', withSpeech: true, tool: 'seedance_2_5' });
    expect(String(post(w)['caption'])).toContain('#organizacao');
    expect(w.tables['storyboards']).toHaveLength(1); expect(w.tables['storyboard_scenes']).toHaveLength(SCENE_COUNT); expect(scenesDone(w)).toBe(0);
    expect(w.r.to(OPENAI_IMAGE_EDITS_URL)).toHaveLength(0); expect(orders(w)).toHaveLength(0);
    expect(w.r.to(OPENAI_URL)).toHaveLength(2); // the direction and the storyboard plan
  });
  it('the automation marks the post as its own', async () => {
    const w = await world();
    await start(w, 'reel', { auto: { mode: 'approval', scheduledAt: new Date(NOW).toISOString() } });
    expect(post(w)).toMatchObject({ source: 'auto' });
  });
  it('without the speech option the video is POV: only hands, no speech and no audio', async () => {
    for (const speech of [false, 'default'] as const) {
      const w = await world({ speech });
      await start(w, 'reel');
      expect(post(w)['video_job']).toMatchObject({ withSpeech: false });
      expect(String((w.tables['storyboards']?.[0] as Record<string, unknown>)['presenter'])).toContain('Mãos');
      expect((w.tables['storyboards']?.[0] as Record<string, unknown>)['with_speech']).toBe(false);
    }
  });
  it('the scenes tell a story with a different camera each, and the last one carries the comment call', async () => {
    const w = await world({ speech: false });
    await start(w, 'reel');
    const plan = (w.tables['storyboards']?.[0] as Record<string, unknown>)['plan'] as { scenes: { camera: string; on_screen_text: string | null }[] };
    expect(new Set(plan.scenes.map(scene => scene.camera)).size).toBe(6); expect(plan.scenes[5]?.on_screen_text).toBe('Comenta EU QUERO');
    expect((w.tables['storyboard_scenes'] as Record<string, unknown>[]).find(row => row['position'] === 5)).toMatchObject({ on_screen_text: 'Comenta EU QUERO' });
  });
  it('startVideoDraft uses this flow whenever OpenAI is connected', async () => {
    const w = await world();
    const result = await startVideoDraft(w.db, { userId: U, masterKey: MASTER, format: 'reel', fetcher: w.r.fetcher, now: () => NOW, makeLink: async () => 'https://shope.ee/abc' });
    expect(result.tool).toBe('Seedance 2.5');
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard' });
  });
  it('asks to connect Higgsfield before spending anything', async () => {
    const w = await world({ hfConnected: false });
    await expect(start(w, 'reel')).rejects.toBeDefined();
    expect(w.r.calls.filter(call => call.url === OPENAI_URL)).toHaveLength(0); expect(w.tables['posts']).toHaveLength(0);
  });
  it('gives up after two refused directions and creates nothing', async () => {
    const w = await world({ texts: [direction({ tool: 'kling_2_6' })] });
    await expect(start(w, 'reel')).rejects.toThrow(/dentro das regras/);
    expect(w.tables['posts']).toHaveLength(0); expect(w.tables['storyboards']).toHaveLength(0);
  });
});

describe('the background steps', () => {
  it('draws the first scene alone, then three at a time, then orders ONE video with all six images', async () => {
    const w = await world();
    await start(w, 'reel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true } });
    expect(await tick(w)).toMatchObject({ checked: 1, waiting: 1 }); expect(scenesDone(w)).toBe(1);
    expect(String(post(w)['error'])).toMatch(/1 de 6/);
    await tick(w); expect(scenesDone(w)).toBe(4);
    expect(orders(w)).toHaveLength(0);
    await tick(w); expect(scenesDone(w)).toBe(6);
    // the same visit that finished the last images ordered the video
    expect(orders(w)).toHaveLength(1);
    const order = orders(w)[0]!; const body = JSON.parse(String(order.init.body)) as Record<string, unknown>;
    expect(order.url).toBe(`${HF}/bytedance/seedance-2.5/reference-to-video`);
    expect(body).toMatchObject({ duration: 30, aspect_ratio: '9:16', resolution: '720p', generate_audio: true });
    expect((body['image_urls'] as string[])).toHaveLength(6); expect((body['image_urls'] as string[]).every(url => url.startsWith('https://files.test/'))).toBe(true);
    expect(String(body['prompt'])).toContain('Scene 6 (Image 6');
    expect((order.init.headers as Record<string, string>)['Idempotency-Key'] ?? (order.init.headers as Record<string, string>)['idempotency-key']).toBe(`${String(post(w)['id'])}:seedance_2_5`);
    expect(post(w)['video_job']).toMatchObject({ stage: 'video', requestId: 'req-1', tool: 'seedance_2_5', duration: 30 });
    expect(w.tables['media_usage']?.[0]).toMatchObject({ purpose: 'video', cost_micros: 3_600_000 });
    expect(w.r.to(OPENAI_IMAGE_EDITS_URL)).toHaveLength(6);
  });
  it('then follows the video like any other and schedules the finished post by itself', async () => {
    const w = await world();
    await start(w, 'reel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true } });
    await tick(w); await tick(w); await tick(w);
    expect(await tick(w)).toMatchObject({ completed: 1 });
    expect(post(w)).toMatchObject({ status: 'scheduled', scheduled_at: new Date(NOW + 2 * 60_000).toISOString(), video_job: null });
    expect(w.tables['video_assets']?.some(asset => asset['source'] === 'higgsfield' && asset['template'] === 'seedance_2_5' && asset['duration_seconds'] === 30)).toBe(true);
    expect(w.tables['post_media']).toHaveLength(1);
  });
  it('without a link the finished video waits as a draft', async () => {
    const w = await world();
    await start(w, 'reel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true }, makeLink: async () => null });
    await tick(w); await tick(w); await tick(w); await tick(w);
    expect(post(w)).toMatchObject({ status: 'draft', scheduled_at: null });
  });
  it('a repeated order is idempotent: it carries the post and the tool as its key', async () => {
    const w = await world({ order: () => ({ status: 503, json: { detail: 'busy' } }) });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w);
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard', requestId: null }); // not lost: it tries again on the next visit
    const first = orders(w)[0]!;
    await tick(w);
    expect(orders(w).length).toBeGreaterThan(1);
    const keys = new Set(orders(w).map(call => (call.init.headers as Record<string, string>)['Idempotency-Key'] ?? (call.init.headers as Record<string, string>)['idempotency-key']));
    expect(keys.size).toBe(1); expect([...keys][0]).toBe(`${String(post(w)['id'])}:seedance_2_5`); void first;
  });
  it('a refused order (invalid) fails the post with a reason and reserves nothing', async () => {
    const w = await world({ order: () => ({ status: 422, json: { detail: 'bad field' } }) });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/não aceitou/i);
    expect(w.tables['media_usage']).toHaveLength(0);
  });
  it('a scene that keeps failing ends the post, with the reason', async () => {
    const w = await world({ images: () => ({ status: 400, json: { error: { code: 'moderation_blocked', message: 'rejected by the safety system' } } }) });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w); await tick(w);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/política de segurança/);
    expect(orders(w)).toHaveLength(0);
  });
  it('gives up when the images take too long', async () => {
    const w = await world({ images: () => ({ status: 503, json: { error: { message: 'overloaded' } } }) });
    await start(w, 'reel');
    await tick(w, NOW + 31 * 60_000);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/demoraram demais/);
  });
  it('only one post at a time is moved forward in a visit', async () => {
    const w = await world({ texts: [direction(), planJson(true), direction({ duration: 15 }), planJson(true)] });
    await start(w, 'reel'); await start(w, 'story');
    expect(w.tables['posts']).toHaveLength(2);
    const result = await tick(w);
    expect(result).toMatchObject({ checked: 2, waiting: 2 }); expect(scenesDone(w)).toBe(1);
  });
});

describe('when the video fails at Higgsfield', () => {
  const failed = (json: Record<string, unknown> = { status: 'failed' }) => ({ json });
  const ordered = (w: World) => orders(w).map(call => call.url.replace(`${HF}/`, ''));
  it('makes it again with another tool from the same images, and keeps what Higgsfield answered', async () => {
    const w = await world({ status: () => failed({ status: 'failed', detail: 'generation error 17' }) });
    await start(w, 'reel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true } });
    await tick(w); await tick(w); await tick(w);
    expect(ordered(w)).toEqual(['bytedance/seedance-2.5/reference-to-video']);
    await tick(w); // Seedance failed
    expect(post(w)).toMatchObject({ status: 'rendering' });
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard', requestId: null, tool: 'wan_3_0', endpoint: 'alibaba/wan-3.0/reference-to-video', triedTools: ['seedance_2_5'] });
    expect(String(post(w)['error'])).toMatch(/Seedance 2\.5.*Tentando com Wan 3\.0/);
    const entry = w.tables['activity_log']?.find(item => item['action'] === 'Vídeo refeito com outra ferramenta') as Record<string, unknown>;
    expect(entry['details']).toMatchObject({ failed_tool: 'seedance_2_5', next_tool: 'wan_3_0' }); expect(String((entry['details'] as Record<string, unknown>)['higgsfield_status'])).toContain('generation error 17');
    expect(w.tables['media_usage']?.some(item => item['purpose'] === 'video-estorno' && item['cost_micros'] === -3_600_000)).toBe(true);
    await tick(w); // the same images are sent to Wan: nothing is drawn again
    expect(ordered(w)).toEqual(['bytedance/seedance-2.5/reference-to-video', 'alibaba/wan-3.0/reference-to-video']);
    expect(w.r.to(OPENAI_IMAGE_EDITS_URL)).toHaveLength(6);
    const keys = orders(w).map(call => (call.init.headers as Record<string, string>)['Idempotency-Key'] ?? (call.init.headers as Record<string, string>)['idempotency-key']);
    expect(keys).toEqual([`${String(post(w)['id'])}:seedance_2_5`, `${String(post(w)['id'])}:wan_3_0`]);
  });
  it('after trying every tool it fails with the reason and the answer kept in the history', async () => {
    const w = await world({ status: () => failed({ status: 'failed', detail: 'boom' }) });
    await start(w, 'reel');
    for (let i = 0; i < 8; i++) await tick(w);
    expect(ordered(w)).toEqual(['bytedance/seedance-2.5/reference-to-video', 'alibaba/wan-3.0/reference-to-video', 'higgsfield/cinema-studio/4.0']);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/não conseguiu gerar o vídeo com Cinema Studio 4\.0/);
    const entry = w.tables['activity_log']?.find(item => item['action'] === 'Vídeo não foi gerado') as Record<string, unknown>;
    expect(entry['details']).toMatchObject({ tool: 'cinema_studio_4' }); expect(String((entry['details'] as Record<string, unknown>)['higgsfield_status'])).toContain('boom');
  });
  it('a video blocked for content is not remade with another tool', async () => {
    const w = await world({ status: () => failed({ status: 'nsfw' }) });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w); await tick(w);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/bloqueou este vídeo por conteúdo \(Seedance 2\.5\)/);
    expect(orders(w)).toHaveLength(1);
  });
});

describe('credits and waiting at Higgsfield', () => {
  const urls = (w: World) => orders(w).map(call => call.url.replace(`${HF}/`, ''));
  it('says on the post that it is waiting for Higgsfield, with the tool', async () => {
    const w = await world();
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w);
    expect(String(post(w)['error'])).toBe('Esperando o Higgsfield criar o vídeo com Seedance 2.5 (leva de 10 a 20 minutos).');
  });
  it('an order refused for lack of credits is tried with another tool from the same images, without waiting', async () => {
    let n = 0;
    const w = await world({ order: () => (n++ === 0 ? { status: 403, json: { detail: 'insufficient credits' } } : { json: { status: 'queued', request_id: 'req-2' } }) });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w); // the third visit finishes the images and the order is refused
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard', requestId: null, tool: 'wan_3_0', triedTools: ['seedance_2_5'] });
    expect(String(post(w)['error'])).toMatch(/Seedance 2\.5.*saldo insuficiente.*Wan 3\.0/);
    expect(w.tables['media_usage']).toHaveLength(0);
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Vídeo refeito com outra ferramenta' && (entry['details'] as Record<string, unknown>)['reason'] === 'saldo insuficiente')).toBe(true);
    await tick(w);
    expect(urls(w)).toEqual(['bytedance/seedance-2.5/reference-to-video', 'alibaba/wan-3.0/reference-to-video']);
    expect(post(w)['video_job']).toMatchObject({ stage: 'video', tool: 'wan_3_0', requestId: 'req-2' });
    expect(w.tables['media_usage']).toHaveLength(1); expect(w.r.to(OPENAI_IMAGE_EDITS_URL)).toHaveLength(6);
  });
  it('when no tool fits the balance the post fails at once, with the reason, instead of waiting', async () => {
    const w = await world({ order: () => ({ status: 403, json: { detail: 'insufficient credits' } }) });
    await start(w, 'reel');
    for (let i = 0; i < 5; i++) await tick(w);
    expect(urls(w)).toEqual(['bytedance/seedance-2.5/reference-to-video', 'alibaba/wan-3.0/reference-to-video', 'higgsfield/cinema-studio/4.0']);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/sem saldo de créditos para este vídeo \(Cinema Studio 4\.0\).*Console do Higgsfield/);
  });
  it('a video that fails for lack of credits ends with the same clear message', async () => {
    const w = await world({ status: () => ({ json: { status: 'failed', error: 'Your credit balance is too low to complete this request. Please top up your balance and try again.' } }) });
    await start(w, 'reel');
    for (let i = 0; i < 8; i++) await tick(w);
    expect(post(w)).toMatchObject({ status: 'failed' }); expect(String(post(w)['error'])).toMatch(/sem saldo de créditos para este vídeo \(Cinema Studio 4\.0\)/);
    const entry = w.tables['activity_log']?.find(item => item['action'] === 'Vídeo não foi gerado') as Record<string, unknown>;
    expect(String((entry['details'] as Record<string, unknown>)['higgsfield_status'])).toContain('credit balance is too low');
  });
  it('a post that only waits for Higgsfield never holds back another post that has images to draw', async () => {
    const w = await world({ order: () => ({ status: 503, json: { detail: 'unavailable' } }), texts: [direction(), planJson(true), direction(), planJson(true)] });
    await start(w, 'reel');
    await tick(w); await tick(w); await tick(w);
    expect(scenesDone(w)).toBe(6); expect(String(post(w)['error'])).toMatch(/Higgsfield/);
    await start(w, 'reel');
    await tick(w);
    expect(scenesDone(w)).toBe(7); // the second post drew its first image although the first one is still waiting
  });
});

describe('the speech of each scene follows the length of the video', () => {
  it('allows about two words a second, spread over the six scenes', () => {
    expect(maxSpeechWords('seedance_2_5', 30)).toBe(11); expect(maxSpeechWords('wan_3_0', 15)).toBe(5); expect(maxSpeechWords('cinema_studio_4', 6)).toBe(3);
    expect(maxSpeechWords('ltx_2_5', 10)).toBe(20);
  });
  it('tells the AI the limit for this video, and sends it back when a line is too long', async () => {
    const long = JSON.parse(planJson(true)) as { scenes: { speech: string }[] };
    long.scenes[2]!.speech = 'Olha esse detalhe incrível que organiza tudo na sua bancada';
    const w = await world({ texts: [direction({ tool: 'wan_3_0', duration: 15 }), JSON.stringify(long), planJson(true)] });
    await start(w, 'story');
    const body = JSON.parse(String(w.r.to(OPENAI_URL)[1]?.init.body)) as { instructions: string };
    expect(body.instructions).toContain('no máximo 5 palavras');
    const retry = JSON.parse(String(w.r.to(OPENAI_URL)[2]?.init.body)) as { input: { content: string }[] };
    expect(retry.input.at(-1)?.content).toMatch(/a fala da cena 3 tem 10 palavras, e o máximo é 5/);
  });
  it('the video prompt asks for slow and clear speech', () => {
    expect(buildStoryVideoPrompt('wan_3_0', { scenes: sceneList(true), presenter: 'Pessoa', seconds: 15, withSpeech: true })).toContain('slowly and very clearly');
  });
});

describe('a carousel from the storyboard images', () => {
  const carouselTexts = () => [JSON.stringify({ chosen_product_id: 'prod-1', reason: 'Boa nota e muitas vendas, combina com o tema', angle: 'organização', hook: 'Olha o que eu encontrei para a sua bancada', caption: 'Achei um jeitinho de deixar a bancada organizada.\nCabe tudo e ainda fica bonito, olha esse detalhe.', hashtags: ['#organizacao', '#casa', '#bancada', '#achadinhos'] }), carouselPlanJson()];
  it('is made of the six images, without a video and without a person, and schedules itself', async () => {
    const w = await world({ texts: carouselTexts() });
    const result = await start(w, 'carousel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true } });
    expect(result).toMatchObject({ tool: 'imagens da IA', estimatedMicros: 0 });
    expect(post(w)).toMatchObject({ format: 'carousel', status: 'rendering', source: 'ai' });
    expect(post(w)['video_job']).toMatchObject({ stage: 'storyboard', carousel: true, withSpeech: false });
    await tick(w); await tick(w);
    expect(await tick(w)).toMatchObject({ completed: 1 });
    expect(orders(w)).toHaveLength(0);
    expect(post(w)).toMatchObject({ status: 'scheduled', scheduled_at: new Date(NOW + 2 * 60_000).toISOString(), video_job: null });
    const media = w.tables['post_media'] as Record<string, unknown>[];
    expect(media.map(item => item['position'])).toEqual([0, 1, 2, 3, 4, 5]); expect(media[0]?.['asset_id']).toBe(post(w)['video_asset_id']);
    expect(w.tables['video_assets']?.filter(asset => asset['source'] === 'ai_image')).toHaveLength(6);
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Carrossel pronto e agendado')).toBe(true);
  });
  it('draws square slides with the text of each slide written word for word in the prompt', async () => {
    const w = await world({ texts: carouselTexts() });
    await start(w, 'carousel');
    await tick(w); await tick(w); await tick(w);
    const forms = w.r.to(OPENAI_IMAGE_EDITS_URL).map(call => call.init.body as FormData);
    expect(forms).toHaveLength(6);
    expect(forms.every(form => form.get('size') === '1024x1024')).toBe(true);
    expect(forms.every(form => form.getAll('image[]').length === 1)).toBe(true); // only the product photo: no person to copy
    const prompts = forms.map(form => String(form.get('prompt')));
    expect(prompts[0]).toContain('"Já viu um organizador assim?"'); expect(prompts[0]).toContain('"Um jeito prático de organizar"'); expect(prompts[0]).toContain('"Modo organização"');
    expect(prompts[1]).toContain('"Detalhe 2 do produto"'); expect(prompts[1]).toContain('seta fina e curva');
    expect(prompts[5]).toContain('"Comenta EU QUERO"'); expect(prompts[5]).toContain('slide 6 de 6');
    expect(new Set(prompts.map(prompt => prompt.split('\n').find(line => line.startsWith('Enquadramento')))).size).toBe(6);
    expect(w.tables['storyboards']?.[0]).toMatchObject({ presenter: null, with_speech: false, plan: expect.objectContaining({ kind: 'carousel' }) });
    expect((w.tables['storyboard_scenes'] as Record<string, unknown>[])[0]).toMatchObject({ on_screen_text: 'Já viu um organizador assim?', speech: null });
  });
  it('does not need Higgsfield', async () => {
    const w = await world({ texts: carouselTexts(), hfConnected: false });
    await expect(start(w, 'carousel')).resolves.toMatchObject({ tool: 'imagens da IA' });
  });
  it('without a link it waits as a draft', async () => {
    const w = await world({ texts: carouselTexts() });
    await start(w, 'carousel', { auto: { mode: 'auto', scheduledAt: new Date(NOW).toISOString(), manual: true }, makeLink: async () => null });
    await tick(w); await tick(w); await tick(w);
    expect(post(w)).toMatchObject({ status: 'draft', scheduled_at: null });
  });
});
