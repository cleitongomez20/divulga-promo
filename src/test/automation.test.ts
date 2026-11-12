import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import {
  LATE_CUTOFF_MS, MIN_LEAD_MS, ORDER_LEAD_MS, DEFAULT_AUTOMATION_SETTINGS, decideOrder, reelsPerDay, seededUnit, slotTimes, storyTime, windowOfDay, automationSettingsSchema,
} from '@/lib/automation';
import { createStoriesForUser, deterministicUuid, loadAutomationView, planNextForUser, runAutomation } from '@/lib/automation.server';
import { connectClaudeKey } from '@/lib/claude.server';
import { connectHiggsfieldKey } from '@/lib/higgsfield.server';
import { dayBounds } from '@/lib/publishing';

const U = 'user-1';
const MASTER = 'master-key-for-tests';
const CLAUDE_KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_ID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const KEY_SECRET = 'S3cr3t_VALUE-abcdefghijklmnopqrstuvwxyz012345';
const IMG = 'https://down-br.img.susercontent.com/file/br-11134207-abc';
const SP = 'America/Sao_Paulo';
const NOON = Date.parse('2026-11-10T14:00:00.000Z'); // 11:00 in São Paulo
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000; const HOUR = 3_600_000;
const window = windowOfDay(NOON, SP, '08:00:00', '22:00:00');
const slots = slotTimes(window, 3, `${U}:${dayBounds(NOON, SP)?.start}`);

describe('daily target and window', () => {
  it('never plans more Reels than the daily limit allows, counting the Story that goes with each one', () => {
    expect(reelsPerDay(3, 6, true)).toBe(3); expect(reelsPerDay(3, 6, false)).toBe(3); expect(reelsPerDay(5, 6, true)).toBe(3); expect(reelsPerDay(5, 6, false)).toBe(5);
    expect(reelsPerDay(3, 2, true)).toBe(1); expect(reelsPerDay(3, 1, true)).toBe(1); expect(reelsPerDay(3, 1, false)).toBe(1);
  });
  it('finds the posting window of the local day, and falls back when the settings make no sense', () => {
    expect(window).toEqual({ startMs: Date.parse('2026-11-10T11:00:00.000Z'), endMs: Date.parse('2026-11-11T01:00:00.000Z') });
    expect(windowOfDay(NOON, SP, '22:00', '08:00')).toEqual(window); expect(windowOfDay(NOON, SP, 'abc', '')).toEqual(window);
  });
  it('gives the same number for the same text, always between 0 and 1', () => {
    expect(seededUnit('a')).toBe(seededUnit('a')); expect(seededUnit('a')).not.toBe(seededUnit('b'));
    for (const seed of ['', 'x', 'user:2026-11-10', 'ç']) { const value = seededUnit(seed); expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(1); }
  });
  it('spreads the Reels across the window, in order, the same way every time', () => {
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBeLessThan(slots[1] as number); expect(slots[1]).toBeLessThan(slots[2] as number);
    for (const slot of slots) { expect(slot).toBeGreaterThan(window.startMs); expect(slot).toBeLessThan(window.endMs); }
    expect(slotTimes(window, 3, `${U}:${dayBounds(NOON, SP)?.start}`)).toEqual(slots);
    expect(slotTimes(window, 3, 'other-seed')).not.toEqual(slots);
    expect(slotTimes(window, 1, 'x')).toHaveLength(1);
  });
});

describe('when to order the next Reels', () => {
  const decide = (extra: Partial<Parameters<typeof decideOrder>[0]> = {}) => decideOrder({ nowMs: (slots[0] as number) - 10 * MIN, made: 0, target: 3, slots, window, force: false, ...extra });
  it('orders ahead of the slot, with time for the video to be made', () => {
    expect(decide()).toMatchObject({ order: true });
    expect(decide({ nowMs: (slots[0] as number) - ORDER_LEAD_MS })).toMatchObject({ order: true });
    expect(decide({ nowMs: (slots[0] as number) - ORDER_LEAD_MS - MIN })).toEqual({ order: false, reason: 'too-early' });
  });
  it('is never planned for a moment sooner than a couple of minutes from now', () => {
    const result = decide({ nowMs: (slots[0] as number) + HOUR });
    expect(result).toMatchObject({ order: true }); expect(result.order && result.slotMs).toBe((slots[0] as number) + HOUR + MIN_LEAD_MS);
  });
  it('stops at the daily target and near the end of the window', () => {
    expect(decide({ made: 3 })).toEqual({ order: false, reason: 'done' });
    expect(decide({ made: 2, nowMs: window.endMs - LATE_CUTOFF_MS + MIN })).toEqual({ order: false, reason: 'too-late' });
  });
  it('the button that forces it ignores the clock, but never the daily target', () => {
    expect(decide({ nowMs: window.startMs - 5 * HOUR, force: true })).toMatchObject({ order: true });
    expect(decide({ nowMs: window.endMs + HOUR, force: true })).toMatchObject({ order: true });
    expect(decide({ made: 3, force: true })).toEqual({ order: false, reason: 'done' });
  });
});

describe('when the Story goes out', () => {
  const settings = { ...DEFAULT_AUTOMATION_SETTINGS, story_delay_min_hours: 1, story_delay_max_hours: 8 };
  const at = (published: string, now = published) => storyTime({ publishedMs: Date.parse(published), nowMs: Date.parse(now), settings, seed: 'reel-1' });
  it('is between the minimum and the maximum delay after the Reels, inside the window', () => {
    const published = '2026-11-10T14:00:00.000Z'; // 11:00 in São Paulo
    const when = at(published);
    expect(when).toBeGreaterThanOrEqual(Date.parse(published) + HOUR); expect(when).toBeLessThanOrEqual(Date.parse(published) + 8 * HOUR);
    expect(when).toBe(at(published)); // always the same for the same Reels
  });
  it('moves a time after the window to the start of the next day, and a time before it to the start of the window', () => {
    const late = at('2026-11-11T00:00:00.000Z'); // 21:00 in São Paulo, so 1 to 8 hours later is after 22:00
    expect(late).toBeGreaterThanOrEqual(Date.parse('2026-11-11T11:00:00.000Z')); expect(late).toBeLessThanOrEqual(Date.parse('2026-11-11T11:31:00.000Z'));
    const early = storyTime({ publishedMs: Date.parse('2026-11-10T04:00:00.000Z'), nowMs: Date.parse('2026-11-10T04:00:00.000Z'), settings: { ...settings, story_delay_min_hours: 1, story_delay_max_hours: 2 }, seed: 's' }); // 01:00 local
    expect(early).toBeGreaterThanOrEqual(Date.parse('2026-11-10T11:00:00.000Z')); expect(early).toBeLessThanOrEqual(Date.parse('2026-11-10T11:31:00.000Z'));
  });
  it('is never sooner than a couple of minutes from now', () => {
    const now = Date.parse('2026-11-12T15:00:00.000Z');
    expect(at('2026-11-10T14:00:00.000Z', '2026-11-12T15:00:00.000Z')).toBeGreaterThanOrEqual(now + MIN_LEAD_MS);
  });
  it('makes the same code for the same text, shaped like a UUID', async () => {
    const a = await deterministicUuid('story:abc'); expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await deterministicUuid('story:abc')).toBe(a); expect(await deterministicUuid('story:abd')).not.toBe(a);
  });
  it('checks the options saved from the screen', () => {
    expect(automationSettingsSchema.safeParse({ enabled: true, mode: 'auto', storyAfterReel: true }).success).toBe(true);
    expect(automationSettingsSchema.safeParse({ enabled: true, mode: 'wild', storyAfterReel: true }).success).toBe(false);
    expect(automationSettingsSchema.safeParse({ enabled: 'yes', mode: 'auto', storyAfterReel: true }).success).toBe(false);
  });
});

// ---------- the whole automation, with the database, Claude, Higgsfield and the storage replaced by stand-ins ----------
const JPEG = new Uint8Array(6000).fill(7); JPEG[0] = 0xff; JPEG[1] = 0xd8; JPEG[2] = 0xff;
const goodPlan = {
  chosen_product_id: 'prod-1', reason: 'Item de impulso com ótima avaliação e muita saída.', angle: 'Praticidade no dia a dia', hook: 'Achei o jeito mais fácil de organizar a bancada',
  caption: 'Achei o jeito mais fácil de organizar a bancada\nSabe quando tudo vira bagunça em dois dias? Esse organizador resolve sem complicar.\nMuita gente já levou e eu entendi o motivo.',
  hashtags: ['#organizacao', '#achadinhos', '#casa', '#shopee', '#utilidades'], tool: 'kling_2_6', duration: 5, sound: true, camera_movement: null,
  video_prompt: 'Slow smooth push-in on the organizer sitting on a tidy kitchen counter, soft daylight, the whole product stays centered and unchanged.',
};
type Setup = { mode?: 'approval' | 'auto'; storyAfterReel?: boolean; enabled?: boolean; posts?: Rows; claudeAnswers?: string[]; account?: Rows; automationRow?: Record<string, unknown> | null; settings?: Rows; wait?: number; hfConnected?: boolean };
async function world(setup: Setup = {}) {
  const answers = [...(setup.claudeAnswers ?? [JSON.stringify(goodPlan)])];
  const calls = { claude: 0, higgsfield: [] as { method: string; path: string }[] };
  const state = { wait: setup.wait ?? 0 };
  let live = false;
  const fetcher = (async (url: string, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith('https://api.anthropic.com')) {
      if (live) calls.claude++;
      const text = live ? (answers.shift() ?? JSON.stringify(goodPlan)) : 'ok';
      return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: 'end_turn' }));
    }
    if (address.startsWith('https://api.higgsfield.ai')) {
      const path = new URL(address).pathname; const method = init?.method ?? 'GET';
      if (live) calls.higgsfield.push({ method, path });
      if (!live) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ status: 'queued', request_id: 'req-1' }));
    }
    return new Response(JPEG as unknown as BodyInit);
  }) as unknown as typeof fetch;
  const product = { id: 'prod-1', user_id: U, marketplace: 'shopee', external_id: '1', title: 'Organizador de Bancada Multiuso', price: 29.9, commission: 0.12, sales: 5000, rating: 4.8, images: [IMG], url: 'https://shopee.com.br/produto-i.1.1', collected_at: iso(NOON - 2 * 86_400_000) };
  const built = memoryDb({
    instagram_accounts: setup.account ?? [{ id: 'acc', user_id: U, status: 'connected', created_at: iso(NOON - 30 * 86_400_000), daily_limit: 6, warmup_started_at: iso(NOON - 30 * 86_400_000) }],
    settings: setup.settings ?? [], products: [product], posts: setup.posts ?? [], connector_secrets: [], ai_connections: [], ai_usage: [], media_connections: [], media_usage: [], video_assets: [], post_media: [], activity_log: [],
    automation_settings: setup.automationRow === null ? [] : [{ id: 'a1', user_id: U, enabled: setup.enabled ?? true, mode: setup.mode ?? 'approval', story_after_reel: setup.storyAfterReel ?? true, last_message: null, retry_after: null, ...(setup.automationRow ?? {}) }],
  });
  await connectClaudeKey(built.db as never, { userId: U, masterKey: MASTER, apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5', capCents: 1000, fetcher, now: () => NOON });
  if (setup.hfConnected !== false) await connectHiggsfieldKey(built.db as never, { userId: U, masterKey: MASTER, keyId: KEY_ID, keySecret: KEY_SECRET, capCents: 1000, fetcher, now: () => NOON });
  built.tables['ai_usage']!.length = 0; built.tables['media_usage']!.length = 0; live = true; calls.claude = 0; calls.higgsfield.length = 0;
  const storage = { from: () => ({
    upload: async () => ({ error: null }), remove: async () => ({ error: null }), getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }),
  }) };
  const rpc = async () => ({ data: state.wait, error: null });
  return { tables: built.tables, db: { ...built.db, storage, rpc }, fetcher, calls, state };
}
type World = Awaited<ReturnType<typeof world>>;
const plan = (w: World, options: { now?: number; force?: boolean; makeLink?: (url: string, subIds: string[]) => Promise<string | null> } = {}) =>
  planNextForUser(w.db as never, { userId: U, masterKey: MASTER, fetcher: w.fetcher, now: () => options.now ?? (slots[0] as number) - 10 * MIN, ...(options.force ? { force: true } : {}), ...(options.makeLink ? { makeLink: options.makeLink } : {}) });
const config = (w: World) => w.tables['automation_settings']?.[0] as Record<string, unknown>;
const today = (status: string, extra: Record<string, unknown> = {}) => ({ id: `t-${Math.random()}`, user_id: U, source: 'auto', format: 'reel', status, created_at: iso(NOON - 3 * HOUR), ...extra });

describe('planning the next Reels', () => {
  it('does nothing when the automation is off or was never set up', async () => {
    for (const setup of [{ enabled: false }, { automationRow: null }] as Setup[]) {
      const w = await world(setup);
      expect(await plan(w)).toMatchObject({ created: false, reason: 'disabled' }); expect(w.calls.claude).toBe(0);
    }
  });
  it('orders the Reels when its time comes, marked as made by the automation and planned for the slot', async () => {
    const w = await world({ mode: 'approval' });
    const now = (slots[0] as number) - 10 * MIN;
    const result = await plan(w, { now, makeLink: async () => 'https://shope.ee/abc' });
    expect(result).toMatchObject({ created: true, reason: 'created' });
    const post = w.tables['posts']?.[0] as Record<string, unknown>;
    expect(post).toMatchObject({ id: result.postId, source: 'auto', format: 'reel', status: 'rendering', affiliate_link: 'https://shope.ee/abc' });
    expect(Date.parse(String(post['scheduled_at']))).toBe(Math.max(slots[0] as number, now + MIN_LEAD_MS));
    expect(post['ai_plan']).toMatchObject({ autoMode: 'approval' });
    expect(w.calls.higgsfield.some(call => call.method === 'POST' && call.path === '/kling-video/v2.6/pro/image-to-video')).toBe(true);
    expect(String(config(w)['last_message'])).toMatch(/Reels criado.*1 de 3 hoje/); expect(config(w)['retry_after']).toBeNull();
  });
  it('remembers the automatic mode in the plan', async () => {
    const w = await world({ mode: 'auto' });
    await plan(w); expect((w.tables['posts']?.[0] as Record<string, unknown>)['ai_plan']).toMatchObject({ autoMode: 'auto' });
  });
  it('waits until shortly before the slot, and says when', async () => {
    const w = await world();
    const result = await plan(w, { now: (slots[0] as number) - 3 * HOUR });
    expect(result).toMatchObject({ created: false, reason: 'too-early' }); expect(w.calls.claude).toBe(0);
    expect(String(config(w)['last_message'])).toMatch(/Hoje: 0 de 3 Reels criados\. O próximo será pedido por volta de \d{2}:\d{2}/);
  });
  it('stops at the daily target and says so', async () => {
    const w = await world({ posts: [today('draft'), today('rendering'), today('published')] });
    expect(await plan(w, { now: (slots[2] as number) - 10 * MIN })).toMatchObject({ created: false, reason: 'done' });
    expect(String(config(w)['last_message'])).toMatch(/Hoje: 3 de 3 Reels criados/); expect(w.calls.claude).toBe(0);
  });
  it('does not count failed or canceled videos toward the target', async () => {
    const w = await world({ posts: [today('failed'), today('failed'), today('canceled'), today('published')] });
    expect(await plan(w, { now: (slots[1] as number) - 10 * MIN })).toMatchObject({ created: true });
  });
  it('rests for the day after too many failed videos', async () => {
    const w = await world({ posts: [today('failed'), today('failed'), today('failed')] });
    expect(await plan(w)).toMatchObject({ created: false, reason: 'failures' }); expect(w.calls.claude).toBe(0);
    expect(String(config(w)['last_message'])).toMatch(/descansa até amanhã: 3 vídeos falharam/);
  });
  it('in approval mode, waits while too many videos are waiting for the user', async () => {
    const waiting = [today('draft', { created_at: iso(NOON - 2 * 86_400_000) }), today('draft', { created_at: iso(NOON - 2 * 86_400_000) }), today('draft', { created_at: iso(NOON - 86_400_000) }), today('rendering', { created_at: iso(NOON - 86_400_000) })];
    const blocked = await world({ mode: 'approval', posts: waiting });
    expect(await plan(blocked)).toMatchObject({ created: false, reason: 'pending' }); expect(blocked.calls.claude).toBe(0);
    expect(String(config(blocked)['last_message'])).toMatch(/Aguardando a sua aprovação: 4/);
    const automatic = await world({ mode: 'auto', posts: waiting });
    expect(await plan(automatic)).toMatchObject({ created: true });
  });
  it('plans only one Reels in the first days of a new account, which has a lower daily limit', async () => {
    const account = [{ id: 'acc', user_id: U, status: 'connected', created_at: iso(NOON), daily_limit: 6, warmup_started_at: iso(NOON - HOUR) }];
    const w = await world({ account, posts: [today('published')] });
    expect(await plan(w, { now: (slots[0] as number) - 10 * MIN })).toMatchObject({ created: false, reason: 'done' });
    expect(String(config(w)['last_message'])).toMatch(/Hoje: 1 de 1 Reels criados/);
  });
  it('after an error it waits fifteen minutes before spending again', async () => {
    const bad = JSON.stringify({ ...goodPlan, tool: 'kling_2_6', duration: 7 });
    const w = await world({ claudeAnswers: [bad, bad] });
    const now = (slots[0] as number) - 10 * MIN;
    expect(await plan(w, { now })).toMatchObject({ created: false, reason: 'error' });
    expect(String(config(w)['last_message'])).toMatch(/A última tentativa não deu certo.*15 minutos/);
    expect(Date.parse(String(config(w)['retry_after']))).toBe(now + 15 * MIN);
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Automação não conseguiu criar o Reels')).toBe(true);
    const claudeCalls = w.calls.claude;
    expect(await plan(w, { now: now + 5 * MIN })).toMatchObject({ created: false, reason: 'backoff' }); expect(w.calls.claude).toBe(claudeCalls);
    expect(await plan(w, { now: now + 16 * MIN })).toMatchObject({ created: true }); // a good answer this time; the wait is over
    expect(config(w)['retry_after']).toBeNull();
  });
  it('the "create now" button ignores the clock but not the target', async () => {
    const early = await world();
    expect(await plan(early, { now: window.startMs - 5 * HOUR, force: true })).toMatchObject({ created: true });
    const done = await world({ posts: [today('draft'), today('draft'), today('draft')] });
    expect(await plan(done, { force: true })).toMatchObject({ created: false, reason: 'done' });
  });
  it('lets only one visit order at a time', async () => {
    const w = await world({ wait: 30_000 });
    expect(await plan(w)).toMatchObject({ created: false, reason: 'busy' }); expect(w.calls.claude).toBe(0);
  });
  it('asks for the Instagram connection when there is none', async () => {
    const w = await world({ account: [] });
    expect(await plan(w)).toMatchObject({ created: false, reason: 'no-account' }); expect(String(config(w)['last_message'])).toMatch(/Conecte o Instagram/);
  });
  it('reports a missing Higgsfield connection as an error and backs off, without calling Claude', async () => {
    const w = await world({ hfConnected: false });
    expect(await plan(w)).toMatchObject({ created: false, reason: 'error' }); expect(w.calls.claude).toBe(0);
    expect(String(config(w)['last_message'])).toMatch(/Conecte o Higgsfield/);
  });
  it('shows today\'s progress on the screen', async () => {
    const w = await world({ mode: 'auto', posts: [today('published'), today('failed'), today('rendering')] });
    expect(await loadAutomationView(w.db as never, U, NOON)).toMatchObject({ enabled: true, mode: 'auto', storyAfterReel: true, madeToday: 2, targetToday: 3, pending: 1 });
    const off = await world({ automationRow: null });
    expect(await loadAutomationView(off.db as never, U, NOON)).toMatchObject({ enabled: false, mode: 'approval', madeToday: 0, targetToday: 3 });
  });
});

describe('creating the Stories', () => {
  const published = (extra: Record<string, unknown> = {}) => ({ id: 'reel-1', user_id: U, instagram_account_id: 'acc', product_id: 'prod-1', source: 'auto', format: 'reel', status: 'published', published_at: iso(NOON - 3 * HOUR), ...extra });
  const withMedia = async (setup: Setup) => { const w = await world(setup); w.tables['post_media']!.push({ post_id: 'reel-1', user_id: U, asset_id: 'asset-1', position: 0 }); return w; };
  const stories = (w: World, now = NOON) => createStoriesForUser(w.db as never, { userId: U, now: () => now });

  it('schedules the Story of a published Reels, with the same video, a few hours later', async () => {
    const w = await withMedia({ posts: [published()] });
    expect(await stories(w)).toBe(1);
    const story = w.tables['posts']?.find(row => row['format'] === 'story') as Record<string, unknown>;
    expect(story).toMatchObject({ user_id: U, instagram_account_id: 'acc', product_id: 'prod-1', status: 'scheduled', source: 'auto', parent_post_id: 'reel-1', video_asset_id: 'asset-1', caption: null, affiliate_link: null, trigger_word: null });
    expect(story['idempotency_key']).toBe(await deterministicUuid('story:reel-1'));
    const when = Date.parse(String(story['scheduled_at']));
    expect(when).toBeGreaterThanOrEqual(NOON + MIN_LEAD_MS);
    expect(w.tables['post_media']?.find(row => row['post_id'] === story['id'])).toMatchObject({ asset_id: 'asset-1', position: 0 });
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Story agendado pela automação')).toBe(true);
  });
  it('creates only one Story per Reels, even when it runs again', async () => {
    const w = await withMedia({ posts: [published()] });
    await stories(w); expect(await stories(w)).toBe(0);
    expect(w.tables['posts']?.filter(row => row['format'] === 'story')).toHaveLength(1);
  });
  it('leaves out Reels that are not eligible', async () => {
    const cases: [string, Setup][] = [
      ['automation off', { enabled: false, posts: [published()] }],
      ['stories turned off', { storyAfterReel: false, posts: [published()] }],
      ['made by hand', { posts: [published({ source: 'ai' })] }],
      ['not published yet', { posts: [published({ status: 'scheduled', published_at: null })] }],
      ['published too long ago', { posts: [published({ published_at: iso(NOON - 40 * HOUR) })] }],
      ['is a Story already', { posts: [published({ format: 'story' })] }],
    ];
    for (const [label, setup] of cases) { const w = await withMedia(setup); expect(await stories(w), label).toBe(0); }
    const noMedia = await world({ posts: [published()] });
    expect(await stories(noMedia)).toBe(0);
  });
  it('runs for every user with the automation on, and one user\'s problem never stops the rest', async () => {
    const w = await withMedia({ posts: [published()] });
    const result = await runAutomation(w.db as never, { masterKey: MASTER, fetcher: w.fetcher, now: () => NOON });
    expect(result).toMatchObject({ users: 1, stories: 1 });
    w.tables['automation_settings']!.push({ id: 'a2', user_id: 'user-without-anything', enabled: true, mode: 'approval', story_after_reel: true });
    const again = await runAutomation(w.db as never, { masterKey: MASTER, fetcher: w.fetcher, now: () => NOON });
    expect(again.users).toBe(2);
  });
});