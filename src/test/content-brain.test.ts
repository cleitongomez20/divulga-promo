import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import {
  CAPTION_MAX, POOL_SIZE, assembleCaption, buildPrompt, checkCaption, extractJson, isShopeeImageUrl, judgeAnswer, normalizeHashtags, pickCandidates, subIdOf, type ProductCandidate,
} from '@/lib/content-brain';
import { BrainError, downloadJpeg, generateAiDraft } from '@/lib/content-brain.server';
import { connectClaudeKey } from '@/lib/claude.server';

const NOW = Date.parse('2026-11-08T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const IMG = 'https://down-br.img.susercontent.com/file/br-11134207-abc';
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const candidate = (extra: Partial<ProductCandidate> = {}): ProductCandidate => ({
  id: 'prod-1', externalId: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, imageUrl: IMG, url: 'https://shopee.com.br/produto-i.1.1', collectedAt: daysAgo(2), ...extra,
});

describe('candidate selection', () => {
  const pick = (items: ProductCandidate[], recent: string[] = []) => pickCandidates(items, { nowMs: NOW, recentProductIds: new Set(recent) });
  it('keeps recent, well rated products with a usable photo and link', () => {
    expect(pick([candidate()]).map(item => item.id)).toEqual(['prod-1']);
    expect(pick([candidate({ rating: null })])).toHaveLength(1);
  });
  it('leaves out old products, low ratings, used products and strange photo or link hosts', () => {
    expect(pick([candidate({ collectedAt: daysAgo(31) })])).toHaveLength(0);
    expect(pick([candidate({ rating: 3.9 })])).toHaveLength(0);
    expect(pick([candidate()], ['prod-1'])).toHaveLength(0);
    expect(pick([candidate({ imageUrl: 'https://evil.example.com/a.jpg' })])).toHaveLength(0);
    expect(pick([candidate({ imageUrl: 'http://down-br.img.susercontent.com/a' })])).toHaveLength(0);
    expect(pick([candidate({ url: 'https://example.com/p' })])).toHaveLength(0);
    expect(pick([candidate({ title: '  ' })])).toHaveLength(0);
  });
  it('puts the best sellers first and offers at most 12', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate({ id: `p${i}`, sales: i * 10 }));
    const picked = pick(many);
    expect(picked).toHaveLength(POOL_SIZE); expect(picked[0]?.id).toBe('p19'); expect(picked[1]?.id).toBe('p18');
    expect(pick([candidate({ id: 'a', sales: null }), candidate({ id: 'b', sales: 1 })]).map(item => item.id)).toEqual(['b', 'a']);
  });
  it('only accepts Shopee image hosts', () => {
    expect(isShopeeImageUrl(IMG)).toBe(true);
    expect(isShopeeImageUrl('https://cf.shopee.com.br/file/x')).toBe(true);
    expect(isShopeeImageUrl('https://evilsusercontent.com/x')).toBe(false);
    expect(isShopeeImageUrl('https://susercontent.com.evil.io/x')).toBe(false);
    expect(isShopeeImageUrl('not a url')).toBe(false);
  });
});

describe('prompt', () => {
  it('lists the products and states the rules, without exposing photo or product addresses', () => {
    const { system, user } = buildPrompt([candidate()]);
    expect(user).toContain('prod-1'); expect(user).toContain('Organizador de Bancada Multiuso');
    expect(user).not.toContain('susercontent'); expect(user).not.toContain('shopee.com.br');
    for (const rule of ['Nunca escreva preço', 'Nunca crie urgência', 'Use somente o que está no nome do produto', 'SOMENTE com um objeto JSON']) expect(system).toContain(rule);
  });
});

const good = {
  chosen_product_id: 'prod-1', reason: 'Item de impulso com ótima avaliação e muita saída.', angle: 'Praticidade no dia a dia',
  hook: 'Achei o jeito mais fácil de organizar a bancada',
  caption: 'Achei o jeito mais fácil de organizar a bancada\nSabe quando tudo vira bagunça em dois dias? Esse organizador resolve sem complicar.\nMuita gente já levou e eu entendi o motivo.',
  hashtags: ['#organizacao', 'achadinhos', '#casa', '#shopee', '#utilidades'],
};
const ids = new Set(['prod-1']);

describe('reading and checking the answer', () => {
  it('finds the JSON inside code blocks and extra sentences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Claro! Aqui está: {"a":1} Espero que goste.')).toEqual({ a: 1 });
    expect(extractJson('sem json')).toBeNull(); expect(extractJson('{quebrado')).toBeNull();
  });
  it('accepts a good answer', () => {
    const verdict = judgeAnswer(JSON.stringify(good), ids);
    expect(verdict.ok).toBe(true);
  });
  it('rejects answers that break a rule and says why', () => {
    const bad = (extra: object) => judgeAnswer(JSON.stringify({ ...good, ...extra }), ids);
    const problems = (extra: object) => { const result = bad(extra); return result.ok ? [] : result.problems.join(' | '); };
    expect(problems({ chosen_product_id: 'outro' })).toMatch(/id da lista/);
    expect(problems({ caption: `${good.caption}\nSó R$ 29,90 hoje` })).toMatch(/preço/);
    expect(problems({ caption: `${good.caption}\nÚltimas unidades no estoque` })).toMatch(/urgência/);
    expect(problems({ caption: `${good.caption}\nCom 40% de desconto` })).toMatch(/porcentagem/);
    expect(problems({ caption: `${good.caption}\nMais de 5 mil vendidos` })).toMatch(/vendas/);
    expect(problems({ caption: `${good.caption}\nResultado garantido, emagrece rápido` })).toMatch(/saúde/);
    expect(problems({ caption: `${good.caption}\nCompre em https://shopee.com.br/x` })).toMatch(/link/);
    expect(problems({ caption: `${good.caption}\n#achado` })).toMatch(/hashtag/);
    expect(problems({ hook: 'Só R$ 10 agora mesmo' })).toMatch(/preço/);
    expect(problems({ hashtags: ['#a', 'b'] })).toBeTruthy();
    expect(problems({ caption: 'curta' })).toMatch(/caption/);
    expect(judgeAnswer('texto qualquer', ids)).toEqual({ ok: false, problems: ['a resposta não é um objeto JSON válido'] });
  });
  it('lets a clean caption through the safety rules', () => {
    expect(checkCaption(good.caption)).toEqual([]);
  });
});

describe('final caption', () => {
  it('adds the call to comment, the affiliate notice and clean hashtags, in that order', () => {
    const text = assembleCaption({ caption: ` ${good.caption} `, hashtags: good.hashtags });
    const parts = text.split('\n\n');
    expect(parts[0]).toBe(good.caption);
    expect(parts[1]).toBe('👉 Comenta EU QUERO que eu te envio o link!');
    expect(parts[2]).toBe('#publi · Link de afiliado');
    expect(parts[3]).toBe('#organizacao #achadinhos #casa #shopee #utilidades');
    expect(text.length).toBeLessThanOrEqual(CAPTION_MAX);
  });
  it('cleans hashtags: no repeats, no spaces, no symbols', () => {
    expect(normalizeHashtags(['#Casa', 'casa', ' ##dica boa ', '#', '#ok!', '#a'])).toEqual(['#Casa', '#dicaboa']);
    expect(normalizeHashtags(Array.from({ length: 30 }, (_, i) => `#tag${i}`))).toHaveLength(12);
  });
  it('makes a 12-character code of letters and numbers from the publication id', () => {
    expect(subIdOf('0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d')).toBe('0a1b2c3d4e5f');
  });
});

const JPEG = new Uint8Array(6000).fill(7); JPEG[0] = 0xff; JPEG[1] = 0xd8; JPEG[2] = 0xff;
const PNG = new Uint8Array(6000).fill(7); PNG[0] = 0x89; PNG[1] = 0x50;

describe('downloading the product photo', () => {
  const respond = (fn: (url: string) => Response) => (async (url: string) => fn(String(url))) as unknown as typeof fetch;
  it('accepts a real JPEG from a Shopee host', async () => {
    expect((await downloadJpeg(respond(() => new Response(JPEG)), IMG))?.length).toBe(6000);
  });
  it('refuses other file types, tiny or missing files, and failures', async () => {
    expect(await downloadJpeg(respond(() => new Response(PNG)), IMG)).toBeNull();
    expect(await downloadJpeg(respond(() => new Response(new Uint8Array([0xff, 0xd8, 0xff]))), IMG)).toBeNull();
    expect(await downloadJpeg(respond(() => new Response('x', { status: 404 })), IMG)).toBeNull();
    expect(await downloadJpeg((async () => { throw new Error('fail'); }) as unknown as typeof fetch, IMG)).toBeNull();
    expect(await downloadJpeg(respond(() => new Response(JPEG)), 'https://evil.example.com/a.jpg')).toBeNull();
  });
  it('follows a redirect inside Shopee hosts but never to another host', async () => {
    const inside = respond(url => (url === IMG ? new Response(null, { status: 302, headers: { location: 'https://cf.shopee.com.br/file/real' } }) : new Response(JPEG)));
    expect((await downloadJpeg(inside, IMG))?.length).toBe(6000);
    const outside = respond(url => (url === IMG ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/a.jpg' } }) : new Response(JPEG)));
    expect(await downloadJpeg(outside, IMG)).toBeNull();
  });
});

type Env = { tables: Record<string, Rows>; db: unknown; uploads: { path: string; size: number; contentType: string }[]; removed: string[]; claudeBodies: Record<string, unknown>[]; fetcher: typeof fetch };
async function setup(options: { products?: Rows; recent?: Rows; account?: boolean; answers?: string[]; image?: Uint8Array; capCents?: number; usage?: Rows; failPostInsert?: boolean; failImage?: (url: string) => boolean } = {}): Promise<Env> {
  const answers = [...(options.answers ?? [JSON.stringify(good)])];
  const claudeBodies: Record<string, unknown>[] = [];
  let live = false; // the scripted answers only start after the connection test has been made
  const router = (async (url: string, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith('https://api.anthropic.com')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; claudeBodies.push(body);
      const text = live ? (answers.shift() ?? JSON.stringify(good)) : 'ok';
      return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: 'end_turn' }));
    }
    if (options.failImage?.(address)) return new Response('x', { status: 404 });
    return new Response((options.image ?? JPEG) as unknown as BodyInit);
  }) as unknown as typeof fetch;
  const product = { id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images: [IMG], url: 'https://shopee.com.br/produto-i.1.1', collected_at: daysAgo(2) };
  const built = memoryDb({
    instagram_accounts: options.account === false ? [] : [{ id: 'acc', user_id: U, status: 'connected', created_at: daysAgo(10) }],
    settings: [], products: options.products ?? [product], posts: options.recent ?? [], connector_secrets: [], ai_connections: [], ai_usage: options.usage ?? [], video_assets: [], post_media: [], activity_log: [],
  });
  await connectClaudeKey(built.db as never, { userId: U, masterKey: MASTER, apiKey: KEY, model: 'claude-sonnet-5-5', capCents: options.capCents ?? 1000, fetcher: router, now: () => NOW });
  built.tables['ai_usage']!.splice(0, built.tables['ai_usage']!.length, ...(options.usage ?? []));
  claudeBodies.length = 0; live = true;
  const uploads: Env['uploads'] = []; const removed: string[] = [];
  const storage = { from: () => ({
    upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => { uploads.push({ path, size: bytes.length, contentType: opts.contentType }); return { error: null }; },
    remove: async (paths: string[]) => { removed.push(...paths); return { error: null }; },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }),
  }) };
  const db = { ...built.db, storage, from: (name: string) => {
    const chain = built.db.from(name) as Record<string, unknown>;
    if (options.failPostInsert && name === 'posts') chain['insert'] = () => Promise.resolve({ data: null, error: { message: 'boom' } });
    return chain;
  } };
  return { tables: built.tables, db, uploads, removed, claudeBodies, fetcher: router };
}
const run = (env: Env, makeLink?: (url: string, subIds: string[]) => Promise<string | null>) =>
  generateAiDraft(env.db as never, { userId: U, masterKey: MASTER, fetcher: env.fetcher, now: () => NOW, ...(makeLink ? { makeLink } : {}) });

describe('generating a draft', () => {
  it('creates a complete draft: photo, caption, tracked link and the plan', async () => {
    const env = await setup(); const linkCalls: { url: string; subIds: string[] }[] = [];
    const result = await run(env, async (url, subIds) => { linkCalls.push({ url, subIds }); return 'https://shope.ee/abc123'; });
    const post = env.tables['posts']?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({ postId: post['id'], productTitle: 'Organizador de Bancada Multiuso', linkMissing: false });
    expect(post).toMatchObject({ user_id: U, instagram_account_id: 'acc', product_id: 'prod-1', format: 'photo', status: 'draft', source: 'ai', trigger_word: 'EU QUERO', affiliate_link: 'https://shope.ee/abc123' });
    expect(String(post['caption'])).toContain('Comenta EU QUERO'); expect(String(post['caption'])).toContain('#publi · Link de afiliado');
    expect(post['sub_id']).toBe(subIdOf(String(post['id'])));
    expect(post['ai_plan']).toMatchObject({ reason: good.reason, angle: good.angle, hook: good.hook, linkMissing: false, costMicros: 7000 });
    expect(linkCalls).toEqual([{ url: 'https://shopee.com.br/produto-i.1.1', subIds: [subIdOf(String(post['id'])), 'ia'] }]);
    expect(env.uploads).toHaveLength(1);
    expect(env.uploads[0]).toMatchObject({ contentType: 'image/jpeg', size: 6000 }); expect(env.uploads[0]?.path.startsWith(`${U}/`)).toBe(true); expect(env.uploads[0]?.path.endsWith('.jpg')).toBe(true);
    expect(env.tables['video_assets']?.[0]).toMatchObject({ user_id: U, storage_path: env.uploads[0]?.path, media_type: 'image', mime_type: 'image/jpeg', source: 'product' });
    expect(env.tables['post_media']?.[0]).toMatchObject({ post_id: post['id'], asset_id: (env.tables['video_assets']?.[0] as Record<string, unknown>)['id'], position: 0 });
    expect(env.tables['ai_usage']?.[0]).toMatchObject({ purpose: 'conteudo', cost_micros: 7000 });
    expect(env.tables['activity_log']?.some(entry => entry['action'] === 'Rascunho criado pela IA')).toBe(true);
  });
  it('offers the AI only products that are not used lately', async () => {
    const other = { id: 'prod-2', user_id: U, marketplace: 'shopee', external_id: '2', title: 'Garrafa Térmica', price: 50, commission: 0.1, sales: 100, rating: 4.7, images: [IMG], url: 'https://shopee.com.br/g-i.2.2', collected_at: daysAgo(1) };
    const base1 = { id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images: [IMG], url: 'https://shopee.com.br/produto-i.1.1', collected_at: daysAgo(2) };
    const env = await setup({ products: [base1, other], recent: [{ id: 'old', user_id: U, product_id: 'prod-1', status: 'draft', created_at: daysAgo(3) }], answers: [JSON.stringify({ ...good, chosen_product_id: 'prod-2' })] });
    const result = await run(env);
    const sent = JSON.stringify(env.claudeBodies[0]);
    expect(sent).toContain('prod-2'); expect(sent).not.toContain('prod-1');
    expect(result.productTitle).toBe('Garrafa Térmica');
  });
  it('lets a canceled or old publication free the product again', async () => {
    const env = await setup({ recent: [{ id: 'a', user_id: U, product_id: 'prod-1', status: 'canceled', created_at: daysAgo(1) }, { id: 'b', user_id: U, product_id: 'prod-1', status: 'published', created_at: daysAgo(20) }] });
    await expect(run(env)).resolves.toBeDefined();
  });
  it('asks once more, with the problems as feedback, when the first answer breaks a rule', async () => {
    const env = await setup({ answers: [JSON.stringify({ ...good, caption: `${good.caption}\nPor R$ 19,90` }), JSON.stringify(good)] });
    const result = await run(env);
    expect(env.claudeBodies).toHaveLength(2);
    const second = env.claudeBodies[1]?.['messages'] as { role: string; content: string }[];
    expect(second.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toMatch(/preço/);
    expect(result.costMicros).toBe(14_000);
    expect(env.tables['posts']).toHaveLength(1);
  });
  it('gives up after one correction and creates nothing', async () => {
    const bad = JSON.stringify({ ...good, caption: `${good.caption}\nSó hoje, últimas unidades` });
    const env = await setup({ answers: [bad, bad] });
    await expect(run(env)).rejects.toBeInstanceOf(BrainError);
    expect(env.claudeBodies).toHaveLength(2); expect(env.tables['posts']).toHaveLength(0); expect(env.uploads).toHaveLength(0);
    expect(env.tables['activity_log']?.some(entry => entry['action'] === 'Conteúdo recusado pelas regras')).toBe(true);
  });
  it('creates nothing when the photo is not a usable JPEG', async () => {
    const env = await setup({ image: PNG });
    await expect(run(env)).rejects.toThrow(/foto utilizável/);
    expect(env.tables['posts']).toHaveLength(0); expect(env.uploads).toHaveLength(0);
  });
  it('still creates the draft, marked as without link, when the affiliate link cannot be made', async () => {
    const env = await setup();
    const result = await run(env, async () => { throw new Error('shopee down'); });
    expect(result.linkMissing).toBe(true);
    expect(env.tables['posts']?.[0]).toMatchObject({ affiliate_link: null }); expect((env.tables['posts']?.[0] as Record<string, unknown>)['ai_plan']).toMatchObject({ linkMissing: true });
    expect((await run(await setup())).linkMissing).toBe(true); // no link maker at all
  });
  it('undoes everything, including the stored photo, when the draft cannot be saved', async () => {
    const env = await setup({ failPostInsert: true });
    await expect(run(env)).rejects.toBeInstanceOf(BrainError);
    expect(env.tables['video_assets']).toHaveLength(0); expect(env.tables['post_media']).toHaveLength(0);
    expect(env.removed).toEqual([env.uploads[0]?.path]);
  });
  it('explains what to do when there are no products to offer', async () => {
    const env = await setup({ products: [] });
    await expect(run(env)).rejects.toThrow(/Busque produtos na tela Produtos/);
    expect(env.claudeBodies).toHaveLength(0);
  });
  it('asks to connect Instagram first', async () => {
    const env = await setup({ account: false });
    await expect(run(env)).rejects.toThrow(/Conecte o Instagram/); expect(env.claudeBodies).toHaveLength(0);
  });
  it('stops when the monthly spending cap has been reached', async () => {
    const env = await setup({ capCents: 100, usage: [{ id: 'u', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 1_000_000, created_at: daysAgo(1) }] });
    await expect(run(env)).rejects.toMatchObject({ kind: 'cap' });
    expect(env.claudeBodies).toHaveLength(0); expect(env.tables['posts']).toHaveLength(0);
  });
});


const photos = (count: number) => Array.from({ length: count }, (_, i) => `${IMG}-${i + 1}`);
const productWith = (images: string[]) => [{ id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images, url: 'https://shopee.com.br/produto-i.1.1', collected_at: daysAgo(2) }];
const feed = (env: Env, extra: { format?: 'photo' | 'carousel'; schedule?: boolean; link?: string | null } = {}) =>
  generateAiDraft(env.db as never, { userId: U, masterKey: MASTER, fetcher: env.fetcher, now: () => NOW, ...(extra.format ? { format: extra.format } : {}), ...(extra.schedule ? { schedule: true } : {}), makeLink: async () => (extra.link === undefined ? 'https://shope.ee/abc123' : extra.link) });

describe('generating a Feed post by itself (the manual button)', () => {
  it('a photo with a link schedules itself a couple of minutes from now', async () => {
    const env = await setup();
    const result = await feed(env, { schedule: true });
    const post = env.tables['posts']?.[0] as Record<string, unknown>; const goesAt = new Date(NOW + 2 * 60_000).toISOString();
    expect(result).toMatchObject({ postId: post['id'], linkMissing: false, scheduledAt: goesAt });
    expect(post).toMatchObject({ format: 'photo', status: 'scheduled', scheduled_at: goesAt, source: 'ai', affiliate_link: 'https://shope.ee/abc123' });
    expect(env.tables['activity_log']?.some(entry => entry['action'] === 'Publicação criada e agendada pela IA')).toBe(true);
  });
  it('without a link it never schedules: it waits as a draft', async () => {
    const env = await setup();
    const result = await feed(env, { schedule: true, link: null });
    const post = env.tables['posts']?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({ linkMissing: true, scheduledAt: null });
    expect(post).toMatchObject({ status: 'draft', affiliate_link: null }); expect(post['scheduled_at']).toBeUndefined();
  });
  it('without asking to schedule, it stays a draft as before', async () => {
    const env = await setup();
    expect(await feed(env)).toMatchObject({ scheduledAt: null });
    expect(env.tables['posts']?.[0]).toMatchObject({ status: 'draft' });
  });
  it('a carousel is made of the real photos of the product, in order, and schedules itself', async () => {
    const env = await setup({ products: productWith(photos(5)) });
    const result = await feed(env, { format: 'carousel', schedule: true });
    const post = env.tables['posts']?.[0] as Record<string, unknown>;
    expect(result.scheduledAt).toBe(new Date(NOW + 2 * 60_000).toISOString());
    expect(post).toMatchObject({ format: 'carousel', status: 'scheduled', source: 'ai' });
    expect(env.uploads).toHaveLength(5); expect(env.uploads.every(item => item.contentType === 'image/jpeg')).toBe(true);
    const assets = env.tables['video_assets'] as Record<string, unknown>[];
    expect(assets).toHaveLength(5); expect(assets.every(asset => asset['source'] === 'product' && asset['media_type'] === 'image')).toBe(true);
    const media = env.tables['post_media'] as Record<string, unknown>[];
    expect(media.map(item => item['position'])).toEqual([0, 1, 2, 3, 4]); expect(media.every(item => item['post_id'] === post['id'])).toBe(true);
    expect(media[0]?.['asset_id']).toBe(post['video_asset_id']);
    expect(env.tables['activity_log']?.at(-1)).toMatchObject({ action: 'Publicação criada e agendada pela IA' });
    expect(String((env.tables['activity_log']?.at(-1) as Record<string, unknown>)['result'])).toContain('Carrossel de 5 fotos');
  });
  it('a carousel uses at most ten photos', async () => {
    const env = await setup({ products: productWith(photos(12)) });
    await feed(env, { format: 'carousel' });
    expect(env.uploads).toHaveLength(10); expect(env.tables['post_media']).toHaveLength(10);
  });
  it('a carousel only offers products with at least three photos, and does not call the AI when there is none', async () => {
    const env = await setup({ products: productWith(photos(2)) });
    await expect(feed(env, { format: 'carousel' })).rejects.toThrow(/pelo menos 3 fotos/);
    expect(env.claudeBodies).toHaveLength(0); expect(env.tables['posts']).toHaveLength(0);
  });
  it('a carousel still works when some photos cannot be downloaded, as long as three remain', async () => {
    const env = await setup({ products: productWith(photos(5)), failImage: url => url.endsWith('-2') || url.endsWith('-4') });
    await feed(env, { format: 'carousel' });
    expect(env.uploads).toHaveLength(3); expect(env.tables['post_media']).toHaveLength(3); expect(env.tables['posts']?.[0]).toMatchObject({ format: 'carousel' });
  });
  it('a carousel with fewer than three usable photos is not made, and nothing is left behind', async () => {
    const env = await setup({ products: productWith(photos(5)), failImage: url => /-(2|3|4)$/.test(url) });
    await expect(feed(env, { format: 'carousel' })).rejects.toThrow(/fotos suficientes/);
    expect(env.tables['posts']).toHaveLength(0); expect(env.tables['video_assets']).toHaveLength(0); expect(env.tables['post_media']).toHaveLength(0);
    expect(env.removed.sort()).toEqual(env.uploads.map(item => item.path).sort());
  });
});