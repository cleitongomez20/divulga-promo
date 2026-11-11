import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import {
  CAMERA_MOVEMENTS, VIDEO_TOOLS, buildHiggsfieldBody, buildVideoPrompt, estimateVideoMicros, judgeVideoAnswer, parseVideoJob, videoCaption, videoOutputSchema, type VideoOutput,
} from '@/lib/video-brain';
import { BrainError } from '@/lib/content-brain.server';
import { startVideoDraft } from '@/lib/video-brain.server';
import { advanceVideoJobs, isSafeVideoUrl, looksLikeMp4 } from '@/lib/video-jobs.server';
import { connectClaudeKey } from '@/lib/claude.server';
import { connectHiggsfieldKey, monthMediaSpentMicros } from '@/lib/higgsfield.server';
import type { ProductCandidate } from '@/lib/content-brain';

const NOW = Date.parse('2026-11-09T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const CLAUDE_KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_ID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const KEY_SECRET = 'S3cr3t_VALUE-abcdefghijklmnopqrstuvwxyz012345';
const IMG = 'https://down-br.img.susercontent.com/file/br-11134207-abc';
const VIDEO_URL = 'https://cdn.higgs.test/out/video.mp4';
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const good: VideoOutput = {
  chosen_product_id: 'prod-1', reason: 'Item de impulso com ótima avaliação e muita saída.', angle: 'Praticidade no dia a dia', hook: 'Achei o jeito mais fácil de organizar a bancada',
  caption: 'Achei o jeito mais fácil de organizar a bancada\nSabe quando tudo vira bagunça em dois dias? Esse organizador resolve sem complicar.\nMuita gente já levou e eu entendi o motivo.',
  hashtags: ['#organizacao', '#achadinhos', '#casa', '#shopee', '#utilidades'], tool: 'kling_2_6', duration: 5, sound: true, camera_movement: null,
  video_prompt: 'Slow smooth push-in on the organizer sitting on a tidy kitchen counter, soft daylight, the whole product stays centered and unchanged.',
};
const ids = new Set(['prod-1']);
const answer = (extra: Partial<VideoOutput> = {}) => JSON.stringify({ ...good, ...extra });
const verdictProblems = (format: 'reel' | 'story', extra: Partial<VideoOutput>) => { const result = judgeVideoAnswer(answer(extra), format, ids); return result.ok ? '' : result.problems.join(' | '); };

describe('video catalog', () => {
  it('uses the endpoints and durations of the Higgsfield documentation', () => {
    expect(VIDEO_TOOLS.kling_2_6).toMatchObject({ endpoint: 'kling-video/v2.6/pro/image-to-video', durations: [5, 10], camera: false });
    expect(VIDEO_TOOLS.ltx_2_5).toMatchObject({ endpoint: 'lightricks/ltx-2.5/image-to-video/pro', durations: [6, 8, 10], camera: true });
    expect(CAMERA_MOVEMENTS).toHaveLength(8);
  });
  it('estimates the cost from seconds, on the cautious side', () => {
    expect(estimateVideoMicros(VIDEO_TOOLS.kling_2_6, 5)).toBe(500_000);
    expect(estimateVideoMicros(VIDEO_TOOLS.kling_2_6, 10)).toBe(1_000_000);
    expect(estimateVideoMicros(VIDEO_TOOLS.ltx_2_5, 6)).toBe(1_020_000);
  });
});

describe('request sent to Higgsfield', () => {
  it('Kling gets exactly the documented fields', () => {
    expect(buildHiggsfieldBody(good, 'https://files.test/f.jpg')).toEqual({ prompt: good.video_prompt, image_url: 'https://files.test/f.jpg', duration: 5, aspect_ratio: '9:16', sound: 'on' });
    expect(buildHiggsfieldBody({ ...good, sound: false }, 'u')).toMatchObject({ sound: 'off' });
  });
  it('LTX gets resolution, audio and, only when chosen, the camera movement', () => {
    const ltx = { ...good, tool: 'ltx_2_5' as const, duration: 6 };
    expect(buildHiggsfieldBody(ltx, 'u')).toEqual({ prompt: good.video_prompt, image_url: 'u', duration: 6, aspect_ratio: '9:16', resolution: '720p', generate_audio: true });
    expect(buildHiggsfieldBody({ ...ltx, camera_movement: 'dolly_in' }, 'u')).toMatchObject({ camera_movement: 'dolly_in' });
  });
  it('always asks for a vertical video', () => {
    for (const tool of ['kling_2_6', 'ltx_2_5'] as const) expect(buildHiggsfieldBody({ ...good, tool, duration: tool === 'kling_2_6' ? 5 : 6 }, 'u')['aspect_ratio']).toBe('9:16');
  });
});

describe('director prompt', () => {
  const candidate: ProductCandidate = { id: 'prod-1', externalId: '1', title: 'Organizador de Bancada', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, imageUrl: IMG, url: 'https://shopee.com.br/p-i.1.1', collectedAt: daysAgo(1) };
  it('lists the tools with their durations and costs and states the rules', () => {
    const { system, user } = buildVideoPrompt('reel', [candidate]);
    for (const text of ['kling_2_6', 'ltx_2_5', 'Durações permitidas: 5, 10', 'Durações permitidas: 6, 8, 10', 'por segundo', 'Nunca escreva preço', 'INTEIRO', 'SOMENTE com um objeto JSON', 'Reels']) expect(system).toContain(text);
    expect(user).toContain('prod-1'); expect(user).not.toContain('susercontent'); expect(user).not.toContain('shopee.com.br');
  });
  it('tells the AI that a Story has no caption', () => {
    const { system } = buildVideoPrompt('story', [candidate]);
    expect(system).toContain('Story não tem legenda'); expect(system).toContain('Story');
  });
});

describe('checking the answer', () => {
  it('accepts a good Reels and a good Story', () => {
    expect(judgeVideoAnswer(answer(), 'reel', ids).ok).toBe(true);
    const story = judgeVideoAnswer(answer({ caption: '', hashtags: [] }), 'story', ids);
    expect(story.ok).toBe(true);
  });
  it('a Story never keeps a caption, even if the AI wrote one', () => {
    const result = judgeVideoAnswer(answer(), 'story', ids);
    expect(result.ok && result.output.caption).toBe('');
  });
  it('refuses a tool with a duration it does not offer', () => {
    expect(verdictProblems('reel', { tool: 'kling_2_6', duration: 6 })).toMatch(/duração 6 não é permitida/);
    expect(verdictProblems('reel', { tool: 'ltx_2_5', duration: 5 })).toMatch(/duração 5 não é permitida/);
    expect(verdictProblems('reel', { tool: 'ltx_2_5', duration: 8 })).toBe('');
  });
  it('refuses an unknown tool, an unknown product and a camera movement that does not exist', () => {
    expect(judgeVideoAnswer(answer({ tool: 'sora' as never }), 'reel', ids).ok).toBe(false);
    expect(verdictProblems('reel', { chosen_product_id: 'outro' })).toMatch(/id da lista/);
    expect(judgeVideoAnswer(answer({ camera_movement: 'spin' as never }), 'reel', ids).ok).toBe(false);
  });
  it('drops a camera movement chosen for a tool that has none', () => {
    const result = judgeVideoAnswer(answer({ camera_movement: 'dolly_in' }), 'reel', ids);
    expect(result.ok && result.output.camera_movement).toBeNull();
  });
  it('refuses film orders that mention price, links or on-screen text', () => {
    expect(verdictProblems('reel', { video_prompt: 'Close-up of the product with a big text overlay saying 50% off today only' })).toMatch(/preço, desconto ou promoção/);
    expect(verdictProblems('reel', { video_prompt: 'Close-up of the product with on-screen text that says buy now at the store' })).toMatch(/texto, legenda ou logotipo/);
    expect(verdictProblems('reel', { video_prompt: 'Product on a table, see https://shopee.com.br/x for details of this product' })).toMatch(/link ou hashtag/);
    expect(verdictProblems('reel', { video_prompt: 'short' })).toMatch(/video_prompt/);
  });
  it('applies the caption safety rules to a Reels and to the hook of a Story', () => {
    expect(verdictProblems('reel', { caption: `${good.caption}\nSó R$ 20 hoje, últimas unidades` })).toMatch(/preço/);
    expect(verdictProblems('reel', { caption: 'curta' })).toMatch(/pelo menos 40/);
    expect(verdictProblems('reel', { hashtags: ['#a'] })).toMatch(/hashtags/);
    expect(verdictProblems('story', { caption: '', hashtags: [], hook: 'Corre que é só hoje, acaba hoje' })).toMatch(/urgência/);
  });
  it('builds the final Reels caption and no Story caption', () => {
    const reel = videoCaption('reel', videoOutputSchema.parse(good));
    expect(reel).toContain('Comenta EU QUERO'); expect(reel).toContain('#publi · Link de afiliado');
    expect(videoCaption('story', videoOutputSchema.parse(good))).toBeNull();
  });
  it('reads a saved job back and refuses a damaged one', () => {
    const job = { requestId: 'r1', tool: 'ltx_2_5', endpoint: 'lightricks/ltx-2.5/image-to-video/pro', duration: 6, framePath: 'u/f.jpg', estimatedMicros: 1_020_000, startedAt: NOW };
    expect(parseVideoJob(job)).toEqual(job);
    expect(parseVideoJob({ ...job, requestId: null })?.requestId).toBeNull();
    expect(parseVideoJob({ ...job, tool: 'x' })).toBeNull(); expect(parseVideoJob(null)).toBeNull(); expect(parseVideoJob({ tool: 'kling_2_6' })).toBeNull();
  });
});

describe('addresses and files from Higgsfield', () => {
  it('accepts only plain https addresses of a real host', () => {
    expect(isSafeVideoUrl(VIDEO_URL)).toBe(true);
    for (const bad of ['http://cdn.higgs.test/a.mp4', 'https://127.0.0.1/a.mp4', 'https://10.0.0.5/a.mp4', 'https://localhost/a.mp4', 'https://[::1]/a.mp4', 'https://intranet.local/a.mp4', 'file:///etc/passwd', 'não é endereço']) expect(isSafeVideoUrl(bad)).toBe(false);
  });
  it('recognizes an MP4 by its header', () => {
    const mp4 = new Uint8Array(100); mp4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    expect(looksLikeMp4(mp4)).toBe(true); expect(looksLikeMp4(new Uint8Array(100).fill(7))).toBe(false); expect(looksLikeMp4(new Uint8Array(5))).toBe(false);
  });
});

// ---------- the whole flow, with the database, Claude, Higgsfield and the storage replaced by stand-ins ----------
const JPEG = new Uint8Array(6000).fill(7); JPEG[0] = 0xff; JPEG[1] = 0xd8; JPEG[2] = 0xff;
const MP4 = new Uint8Array(20_000).fill(9); MP4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
type Reply = { status?: number; json?: unknown };
type World = {
  tables: Record<string, Rows>; db: unknown; fetcher: typeof fetch; uploads: { path: string; size: number; contentType: string }[]; removed: string[];
  claudeBodies: Record<string, unknown>[]; hf: { method: string; path: string; headers: Record<string, string>; body: unknown }[]; statusReplies: Reply[]; submitReplies: Reply[];
  download: { status: number; bytes: Uint8Array }; uploadFails: { value: boolean };
};
async function world(options: { answers?: string[]; products?: Rows; posts?: Rows; hfConnected?: boolean; capCents?: number; usage?: Rows } = {}): Promise<World> {
  const answers = [...(options.answers ?? [answer()])];
  const claudeBodies: World['claudeBodies'] = []; const hf: World['hf'] = []; const statusReplies: Reply[] = []; const submitReplies: Reply[] = [{ json: { status: 'queued', request_id: 'req-1' } }];
  const download = { status: 200, bytes: MP4 }; const uploadFails = { value: false };
  let live = false;
  const json = (reply: Reply) => new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  const fetcher = (async (url: string, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith('https://api.anthropic.com')) {
      claudeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const text = live ? (answers.shift() ?? answer()) : 'ok';
      return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: 'end_turn' }));
    }
    if (address.startsWith('https://api.higgsfield.ai')) {
      const path = new URL(address).pathname; const method = init?.method ?? 'GET';
      hf.push({ method, path, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (!live) return json({ status: 404, json: { detail: 'not found' } });
      if (method === 'GET' && path.endsWith('/status')) return json(statusReplies.shift() ?? { json: { status: 'queued' } });
      if (method === 'POST' && path.endsWith('/cancel')) return json({ json: {} });
      return json(submitReplies.shift() ?? { json: { status: 'queued', request_id: 'req-x' } });
    }
    if (address.includes('127.0.0.1')) return new Response(MP4 as unknown as BodyInit); // a valid MP4 behind an address that must never be fetched
    if (address.startsWith('https://cdn.higgs.test/')) return new Response(download.status === 200 ? (download.bytes as unknown as BodyInit) : 'x', { status: download.status });
    return new Response(JPEG as unknown as BodyInit);
  }) as unknown as typeof fetch;
  const product = { id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images: [IMG], url: 'https://shopee.com.br/produto-i.1.1', collected_at: daysAgo(2) };
  const built = memoryDb({
    instagram_accounts: [{ id: 'acc', user_id: U, status: 'connected', created_at: daysAgo(10) }], settings: [], products: options.products ?? [product], posts: options.posts ?? [],
    connector_secrets: [], ai_connections: [], ai_usage: [], media_connections: [], media_usage: options.usage ?? [], video_assets: [], post_media: [], activity_log: [],
  });
  await connectClaudeKey(built.db as never, { userId: U, masterKey: MASTER, apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5', capCents: 1000, fetcher, now: () => NOW });
  if (options.hfConnected !== false) await connectHiggsfieldKey(built.db as never, { userId: U, masterKey: MASTER, keyId: KEY_ID, keySecret: KEY_SECRET, capCents: options.capCents ?? 1000, fetcher, now: () => NOW });
  built.tables['ai_usage']!.length = 0; built.tables['media_usage']!.splice(0, built.tables['media_usage']!.length, ...(options.usage ?? []));
  claudeBodies.length = 0; hf.length = 0; live = true;
  const uploads: World['uploads'] = []; const removed: string[] = [];
  const storage = { from: () => ({
    upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => { if (uploadFails.value) return { error: { message: 'x' } }; uploads.push({ path, size: bytes.length, contentType: opts.contentType }); return { error: null }; },
    remove: async (paths: string[]) => { removed.push(...paths); return { error: null }; },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }),
  }) };
  return { tables: built.tables, db: { ...built.db, storage }, fetcher, uploads, removed, claudeBodies, hf, statusReplies, submitReplies, download, uploadFails };
}
const order = (w: World, format: 'reel' | 'story' = 'reel', makeLink?: (url: string, subIds: string[]) => Promise<string | null>) =>
  startVideoDraft(w.db as never, { userId: U, masterKey: MASTER, format, fetcher: w.fetcher, now: () => NOW, ...(makeLink ? { makeLink } : {}) });

describe('ordering a video', () => {
  it('plans with Claude, orders at Higgsfield and creates a post that shows as generating', async () => {
    const w = await world(); const linkCalls: string[][] = [];
    const result = await order(w, 'reel', async (_url, subIds) => { linkCalls.push(subIds); return 'https://shope.ee/abc'; });
    const row = w.tables['posts']?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({ postId: row['id'], tool: 'Kling 2.6 Pro', duration: 5, estimatedMicros: 500_000, costMicros: 7000, linkMissing: false });
    expect(row).toMatchObject({ user_id: U, instagram_account_id: 'acc', product_id: 'prod-1', format: 'reel', status: 'rendering', source: 'ai', trigger_word: 'EU QUERO', affiliate_link: 'https://shope.ee/abc' });
    expect(String(row['caption'])).toContain('Comenta EU QUERO');
    expect(row['video_job']).toMatchObject({ requestId: 'req-1', tool: 'kling_2_6', endpoint: 'kling-video/v2.6/pro/image-to-video', duration: 5, estimatedMicros: 500_000, startedAt: NOW });
    expect(linkCalls[0]?.[1]).toBe('ia');
    // the order sent to Higgsfield
    const sent = w.hf.find(call => call.method === 'POST');
    expect(sent?.path).toBe('/kling-video/v2.6/pro/image-to-video');
    expect(sent?.headers).toMatchObject({ authorization: `Key ${KEY_ID}:${KEY_SECRET}`, 'idempotency-key': row['id'] });
    expect(sent?.body).toEqual({ prompt: good.video_prompt, image_url: `https://files.test/${w.uploads[0]?.path}`, duration: 5, aspect_ratio: '9:16', sound: 'on' });
    expect(w.uploads).toHaveLength(1); expect(w.uploads[0]).toMatchObject({ contentType: 'image/jpeg' });
    // money: Claude cost and the video estimate, reserved right away
    expect(w.tables['ai_usage']?.[0]).toMatchObject({ purpose: 'video', cost_micros: 7000 });
    expect(w.tables['media_usage']?.[0]).toMatchObject({ purpose: 'video', model: 'kling-video/v2.6/pro/image-to-video', cost_micros: 500_000 });
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Vídeo pedido ao Higgsfield')).toBe(true);
  });
  it('a Story has no caption and no call to comment', async () => {
    const w = await world({ answers: [answer({ caption: '', hashtags: [] })] });
    await order(w, 'story');
    expect(w.tables['posts']?.[0]).toMatchObject({ format: 'story', caption: null, trigger_word: null, status: 'rendering' });
  });
  it('sends the camera movement when LTX is chosen', async () => {
    const w = await world({ answers: [answer({ tool: 'ltx_2_5', duration: 6, camera_movement: 'dolly_in' })] });
    const result = await order(w);
    expect(result).toMatchObject({ tool: 'LTX 2.5 Pro', duration: 6, estimatedMicros: 1_020_000 });
    expect(w.hf.find(call => call.method === 'POST')?.path).toBe('/lightricks/ltx-2.5/image-to-video/pro');
    expect(w.hf.find(call => call.method === 'POST')?.body).toMatchObject({ camera_movement: 'dolly_in', resolution: '720p', generate_audio: true, duration: 6 });
  });
  it('asks Claude once more, with the problems as feedback, when the plan breaks a rule', async () => {
    const w = await world({ answers: [answer({ video_prompt: 'Product on a table with a text overlay saying 30% off, quite a long prompt here' }), answer()] });
    const result = await order(w);
    expect(w.claudeBodies).toHaveLength(2);
    const second = w.claudeBodies[1]?.['messages'] as { role: string; content: string }[];
    expect(second[2]?.content).toMatch(/desconto/); expect(result.costMicros).toBe(14_000);
    expect(w.tables['posts']).toHaveLength(1);
  });
  it('gives up after one correction and spends nothing at Higgsfield', async () => {
    const bad = answer({ tool: 'kling_2_6', duration: 7 });
    const w = await world({ answers: [bad, bad] });
    await expect(order(w)).rejects.toBeInstanceOf(BrainError);
    expect(w.tables['posts']).toHaveLength(0); expect(w.hf).toHaveLength(0); expect(w.uploads).toHaveLength(0); expect(w.tables['media_usage']).toHaveLength(0);
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Vídeo recusado pelas regras')).toBe(true);
  });
  it('asks to connect Higgsfield before calling Claude', async () => {
    const w = await world({ hfConnected: false });
    await expect(order(w)).rejects.toMatchObject({ kind: 'not_connected' });
    expect(w.claudeBodies).toHaveLength(0);
  });
  it('refuses an order that would pass the monthly cap, before any photo is stored', async () => {
    const w = await world({ capCents: 100, usage: [{ id: 'u', user_id: U, purpose: 'video', model: 'm', cost_micros: 700_000, created_at: daysAgo(1) }] }); // US$ 1.00 cap, 0.70 used, 0.50 needed
    await expect(order(w)).rejects.toMatchObject({ kind: 'cap' });
    expect(w.uploads).toHaveLength(0); expect(w.tables['posts']).toHaveLength(0); expect(w.hf).toHaveLength(0);
  });
  it('limits how many videos are in progress at once', async () => {
    const rendering = (id: string) => ({ id, user_id: U, status: 'rendering', created_at: daysAgo(0) });
    const w = await world({ posts: [rendering('a'), rendering('b')] });
    await expect(order(w)).rejects.toThrow(/2 vídeos sendo gerados/);
    expect(w.claudeBodies).toHaveLength(0);
  });
  it('removes the post and the photo when Higgsfield refuses the order, without reserving money', async () => {
    const w = await world(); w.submitReplies[0] = { status: 422, json: { detail: 'invalid image_url' } };
    await expect(order(w)).rejects.toMatchObject({ kind: 'invalid' });
    expect(w.tables['posts']).toHaveLength(0); expect(w.removed).toEqual([w.uploads[0]?.path]); expect(w.tables['media_usage']).toHaveLength(0);
  });
  it('marks the key as invalid when Higgsfield rejects it, and cleans up', async () => {
    const w = await world(); w.submitReplies[0] = { status: 401, json: { detail: 'bad key' } };
    await expect(order(w)).rejects.toMatchObject({ kind: 'auth' });
    expect(w.tables['media_connections']?.[0]).toMatchObject({ status: 'invalid' }); expect(w.tables['posts']).toHaveLength(0);
  });
  it('explains when Higgsfield is busy or out of balance, and cleans up', async () => {
    for (const [status, kind] of [[429, 'busy'], [403, 'balance'], [500, 'server']] as const) {
      const w = await world(); w.submitReplies[0] = { status, json: {} };
      await expect(order(w)).rejects.toMatchObject({ kind });
      expect(w.tables['posts']).toHaveLength(0); expect(w.removed).toHaveLength(1);
    }
  });
  it('treats an answer without a request id as a failure', async () => {
    const w = await world(); w.submitReplies[0] = { json: { status: 'queued' } };
    await expect(order(w)).rejects.toMatchObject({ kind: 'server' });
    expect(w.tables['posts']).toHaveLength(0);
  });
  it('still creates the post, marked as without link, when the affiliate link cannot be made', async () => {
    const w = await world();
    const result = await order(w, 'reel', async () => { throw new Error('shopee down'); });
    expect(result.linkMissing).toBe(true); expect(w.tables['posts']?.[0]).toMatchObject({ affiliate_link: null });
  });
});

describe('following the video until it is ready', () => {
  const rendering = (extra: Record<string, unknown> = {}, jobExtra: Record<string, unknown> = {}) => ({
    id: 'p1', user_id: U, instagram_account_id: 'acc', format: 'reel', status: 'rendering', created_at: new Date(NOW - 120_000).toISOString(), error: null,
    video_job: { requestId: 'req-1', tool: 'kling_2_6', endpoint: 'kling-video/v2.6/pro/image-to-video', duration: 5, framePath: `${U}/frame.jpg`, estimatedMicros: 500_000, startedAt: NOW - 120_000, ...jobExtra }, ...extra,
  });
  const tick = (w: World, at = NOW, maxCompletions?: number) => advanceVideoJobs(w.db as never, { masterKey: MASTER, fetcher: w.fetcher, now: () => at, ...(maxCompletions ? { maxCompletions } : {}) });
  const row = (w: World, id = 'p1') => w.tables['posts']?.find(r => r['id'] === id) as Record<string, unknown>;
  const reserved = (w: World) => w.tables['media_usage']!.push({ id: `r${Math.random()}`, user_id: U, purpose: 'video', model: 'kling-video/v2.6/pro/image-to-video', cost_micros: 500_000, created_at: new Date(NOW - 120_000).toISOString() });

  it('waits while Higgsfield is still working', async () => {
    const w = await world({ posts: [rendering()] }); w.statusReplies.push({ json: { status: 'in_progress' } });
    const result = await tick(w);
    expect(result).toMatchObject({ checked: 1, completed: 0, failed: 0, waiting: 1 }); expect(row(w)['status']).toBe('rendering');
    expect(w.hf.some(call => call.method === 'GET' && call.path === '/requests/req-1/status')).toBe(true);
  });
  it('downloads the finished video, stores it and turns the post into a draft', async () => {
    const w = await world({ posts: [rendering()] }); w.statusReplies.push({ json: { status: 'completed', request_id: 'req-1', video: { url: VIDEO_URL } } });
    const result = await tick(w);
    expect(result.completed).toBe(1);
    expect(w.uploads).toHaveLength(1); expect(w.uploads[0]).toMatchObject({ contentType: 'video/mp4', size: 20_000 }); expect(w.uploads[0]?.path.startsWith(`${U}/`)).toBe(true);
    const asset = w.tables['video_assets']?.[0] as Record<string, unknown>;
    expect(asset).toMatchObject({ user_id: U, instagram_account_id: 'acc', storage_path: w.uploads[0]?.path, media_type: 'video', mime_type: 'video/mp4', source: 'higgsfield', provider_job_id: 'req-1', template: 'kling_2_6', duration_seconds: 5 });
    expect(w.tables['post_media']?.[0]).toMatchObject({ post_id: 'p1', asset_id: asset['id'], position: 0 });
    expect(row(w)).toMatchObject({ status: 'draft', video_asset_id: asset['id'], video_job: null, error: null });
    expect(w.removed).toEqual([`${U}/frame.jpg`]);
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Vídeo pronto')).toBe(true);
  });
  it('fails and returns the reserved estimate when Higgsfield could not make the video', async () => {
    for (const [state, message] of [['failed', /não conseguiu gerar/], ['nsfw', /bloqueou/], ['canceled', /cancelado/]] as const) {
      const w = await world({ posts: [rendering()] }); reserved(w); w.statusReplies.push({ json: { status: state } });
      const result = await tick(w);
      expect(result.failed).toBe(1); expect(row(w)).toMatchObject({ status: 'failed', video_job: null }); expect(String(row(w)['error'])).toMatch(message);
      expect(await monthMediaSpentMicros(w.db as never, U, NOW)).toBe(0); // the estimate was returned
      expect(w.removed).toEqual([`${U}/frame.jpg`]);
    }
  });
  it('fails on an unsafe address or a file that is not an MP4, and returns the estimate', async () => {
    const unsafe = await world({ posts: [rendering()] }); reserved(unsafe); unsafe.statusReplies.push({ json: { status: 'completed', video: { url: 'https://127.0.0.1/x.mp4' } } });
    await tick(unsafe); expect(row(unsafe)['status']).toBe('failed'); expect(String(row(unsafe)['error'])).toMatch(/endereço de vídeo inválido/); expect(unsafe.uploads).toHaveLength(0);
    const notMp4 = await world({ posts: [rendering()] }); reserved(notMp4); notMp4.download.bytes = JPEG; notMp4.statusReplies.push({ json: { status: 'completed', video: { url: VIDEO_URL } } });
    await tick(notMp4); expect(row(notMp4)['status']).toBe('failed'); expect(String(row(notMp4)['error'])).toMatch(/MP4/); expect(notMp4.uploads).toHaveLength(0);
    expect(await monthMediaSpentMicros(notMp4.db as never, U, NOW)).toBe(0);
  });
  it('tries again on the next visit when the download or the storage fails for a moment', async () => {
    const down = await world({ posts: [rendering()] }); down.download.status = 503; down.statusReplies.push({ json: { status: 'completed', video: { url: VIDEO_URL } } });
    expect((await tick(down)).waiting).toBe(1); expect(row(down)['status']).toBe('rendering');
    const full = await world({ posts: [rendering()] }); full.uploadFails.value = true; full.statusReplies.push({ json: { status: 'completed', video: { url: VIDEO_URL } } });
    expect((await tick(full)).waiting).toBe(1); expect(row(full)['status']).toBe('rendering'); expect(full.tables['video_assets']).toHaveLength(0);
  });
  it('completes at most the allowed number of videos per visit', async () => {
    const w = await world({ posts: [rendering(), rendering({ id: 'p2', created_at: new Date(NOW - 100_000).toISOString() })] });
    w.statusReplies.push({ json: { status: 'completed', video: { url: VIDEO_URL } } }, { json: { status: 'completed', video: { url: VIDEO_URL } } });
    const result = await tick(w, NOW, 1);
    expect(result).toMatchObject({ completed: 1, waiting: 1 }); expect(row(w, 'p1')['status']).toBe('draft'); expect(row(w, 'p2')['status']).toBe('rendering');
  });
  it('fails when Higgsfield does not know the request', async () => {
    const w = await world({ posts: [rendering()] }); reserved(w); w.statusReplies.push({ status: 404, json: {} });
    await tick(w); expect(row(w)['status']).toBe('failed'); expect(String(row(w)['error'])).toMatch(/não encontrou/);
  });
  it('marks the key as invalid and waits when Higgsfield rejects it', async () => {
    const w = await world({ posts: [rendering()] }); w.statusReplies.push({ status: 401, json: {} });
    const result = await tick(w);
    expect(result.waiting).toBe(1); expect(row(w)['status']).toBe('rendering'); expect(w.tables['media_connections']?.[0]).toMatchObject({ status: 'invalid' }); expect(String(row(w)['error'])).toMatch(/recusou a chave/);
  });
  it('waits through temporary errors, and gives up only after the time limit', async () => {
    const w = await world({ posts: [rendering()] }); w.statusReplies.push({ status: 503, json: {} });
    expect((await tick(w)).waiting).toBe(1); expect(row(w)['status']).toBe('rendering');
    const late = await world({ posts: [rendering({}, { startedAt: NOW - 26 * 60_000 })] }); reserved(late); late.statusReplies.push({ status: 503, json: {} });
    await tick(late); expect(row(late)['status']).toBe('failed');
  });
  it('cancels and gives up on a video that stays in the queue too long, returning the estimate', async () => {
    const w = await world({ posts: [rendering({}, { startedAt: NOW - 26 * 60_000 })] }); reserved(w); w.statusReplies.push({ json: { status: 'queued' } });
    await tick(w);
    expect(w.hf.some(call => call.method === 'POST' && call.path === '/requests/req-1/cancel')).toBe(true);
    expect(row(w)['status']).toBe('failed'); expect(String(row(w)['error'])).toMatch(/demorou/); expect(await monthMediaSpentMicros(w.db as never, U, NOW)).toBe(0);
  });
  it('gives up on an order Higgsfield never confirmed, but only after a few minutes', async () => {
    const young = await world({ posts: [rendering({}, { requestId: null, startedAt: NOW - 60_000 })] });
    expect((await tick(young)).waiting).toBe(1); expect(row(young)['status']).toBe('rendering');
    const old = await world({ posts: [rendering({}, { requestId: null, startedAt: NOW - 11 * 60_000 })] });
    await tick(old); expect(row(old)['status']).toBe('failed'); expect(old.hf).toHaveLength(0);
  });
  it('waits, with a note, when Higgsfield was disconnected', async () => {
    const w = await world({ posts: [rendering()], hfConnected: false });
    const result = await tick(w);
    expect(result.waiting).toBe(1); expect(String(row(w)['error'])).toMatch(/Conecte o Higgsfield/); expect(w.hf).toHaveLength(0);
  });
  it('ignores posts that are not being rendered', async () => {
    const w = await world({ posts: [rendering({ status: 'draft' }), rendering({ id: 'p9', status: 'scheduled' })] });
    expect((await tick(w)).checked).toBe(0); expect(w.hf).toHaveLength(0);
  });
});
