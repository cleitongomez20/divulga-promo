import { describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ tokenOk: true }));
vi.mock('@/lib/instagram.server', () => ({
  getPublishingToken: async () => (control.tokenOk ? { token: 'tok', igUserId: 'ig1', pageId: null } : null),
}));

import { addDays, dayBounds, effectiveDailyLimit, localDate, nextDayWindowStart, retryDelayMs, warmupDay, DEFAULT_PUBLISH_SETTINGS } from '@/lib/publishing';
import { runPublishTick } from '@/lib/publisher.server';

const NOW = Date.parse('2026-11-08T15:00:00.000Z'); // 12:00 in São Paulo
const iso = (ms: number) => new Date(ms).toISOString();
const SP = 'America/Sao_Paulo';

describe('scheduling rules', () => {
  it('finds the local day and its limits in São Paulo', () => {
    expect(localDate(Date.parse('2026-11-08T02:30:00Z'), SP)).toBe('2026-11-07');
    expect(dayBounds(NOW, SP)).toEqual({ start: '2026-11-08T03:00:00.000Z', end: '2026-11-09T03:00:00.000Z' });
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });
  it('counts warm-up days from the day the account was connected', () => {
    expect(warmupDay('2026-11-08T10:00:00Z', NOW, SP)).toBe(1);
    expect(warmupDay('2026-11-06T10:00:00Z', NOW, SP)).toBe(3);
    expect(warmupDay('2026-11-01T10:00:00Z', NOW, SP)).toBe(8);
    expect(warmupDay(null, NOW, SP)).toBeGreaterThan(1000);
  });
  it('uses the warm-up limits first, then the normal limit, never above the account limit', () => {
    const limit = (started: string, account: number | null = 6) => effectiveDailyLimit(DEFAULT_PUBLISH_SETTINGS, account, started, NOW);
    expect(limit('2026-11-08T10:00:00Z')).toBe(1); // day 1
    expect(limit('2026-11-06T10:00:00Z')).toBe(1); // day 3
    expect(limit('2026-11-05T10:00:00Z')).toBe(2); // day 4
    expect(limit('2026-11-02T10:00:00Z')).toBe(2); // day 7
    expect(limit('2026-11-01T10:00:00Z')).toBe(6); // day 8
    expect(limit('2026-11-01T10:00:00Z', 2)).toBe(2);
  });
  it('moves to the start of the posting window on the next day', () => {
    expect(nextDayWindowStart(NOW, SP, '08:00:00')).toBe('2026-11-09T11:00:00.000Z');
  });
  it('waits longer after each failed try', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([300_000, 600_000, 900_000]);
  });
});

type Rows = Record<string, unknown>[];
function memoryDb(seed: Record<string, Rows>) {
  const tables: Record<string, Rows> = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
  const from = (name: string) => {
    const all = () => (tables[name] ??= []);
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: unknown; let order: { col: string; asc: boolean } | null = null; let max: number | null = null; let head = false; let counting = false; let key = '';
    const hits = () => all().filter(row => filters.every(test => test(row)));
    const run = () => {
      if (op === 'insert') { all().push(...(Array.isArray(payload) ? payload : [payload]).map(row => ({ ...(row as object) }))); return { data: null, error: null }; }
      if (op === 'upsert') { const row = { ...(payload as Record<string, unknown>) }; const found = all().find(r => r[key] === row[key]); if (found) Object.assign(found, row); else all().push(row); return { data: null, error: null }; }
      if (op === 'update') { const touched = hits(); touched.forEach(row => Object.assign(row, payload)); return { data: touched.map(row => ({ ...row })), error: null }; }
      if (op === 'delete') { const gone = new Set(hits()); tables[name] = all().filter(row => !gone.has(row)); return { data: null, error: null }; }
      let found = hits();
      if (order) { const { col, asc } = order; found = [...found].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
      if (max !== null) found = found.slice(0, max);
      return { data: head ? null : found.map(row => ({ ...row })), count: counting ? hits().length : null, error: null };
    };
    const chain: Record<string, unknown> = {
      select: (_cols?: string, options?: { count?: string; head?: boolean }) => { if (options?.count) counting = true; if (options?.head) head = true; return chain; },
      eq: (col: string, value: unknown) => { filters.push(row => row[col] === value); return chain; },
      neq: (col: string, value: unknown) => { filters.push(row => row[col] !== value); return chain; },
      in: (col: string, values: unknown[]) => { filters.push(row => values.includes(row[col])); return chain; },
      lte: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) <= value); return chain; },
      gte: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) >= value); return chain; },
      lt: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) < value); return chain; },
      order: (col: string, options?: { ascending?: boolean }) => { order = { col, asc: options?.ascending !== false }; return chain; },
      limit: (count: number) => { max = count; return chain; },
      maybeSingle: async () => { const { data } = run(); return { data: (data as Rows | null)?.[0] ?? null, error: null }; },
      insert: (rows: unknown) => { op = 'insert'; payload = rows; return chain; },
      upsert: (row: unknown, options?: { onConflict?: string }) => { op = 'upsert'; payload = row; key = options?.onConflict ?? 'id'; return chain; },
      update: (values: unknown) => { op = 'update'; payload = values; return chain; },
      delete: () => { op = 'delete'; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return chain;
  };
  const storage = { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }) }) };
  return { tables, db: { from, storage } };
}

type Call = { method: string; path: string; params: Record<string, string>; auth: string | null };
function scriptedInstagram(respond: (call: Call, index: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const post = init?.method === 'POST';
    const call: Call = {
      method: init?.method ?? 'GET', path: url.pathname.replace(/^\/v[\d.]+/, ''), auth: (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null,
      params: post ? Object.fromEntries(new URLSearchParams(String(init?.body))) : Object.fromEntries(url.searchParams),
    };
    calls.push(call);
    const reply = respond(call, calls.length - 1);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const U = 'user-1';
const account = (extra: Record<string, unknown> = {}) => ({ id: 'acc', user_id: U, status: 'connected', daily_limit: 6, warmup_started_at: '2026-10-01T00:00:00.000Z', ...extra });
const post = (extra: Record<string, unknown> = {}) => ({
  id: 'p1', user_id: U, instagram_account_id: 'acc', format: 'reel', status: 'scheduled', scheduled_at: iso(NOW - 60_000), caption: 'Olha esse achadinho', attempts: 0, error: null,
  publish_state: null, updated_at: iso(NOW - 120_000), published_at: null, ig_media_id: null, ...extra,
});
const video = (id: string) => ({ id, user_id: U, storage_path: `${U}/${id}.mp4`, media_type: 'video' });
const image = (id: string) => ({ id, user_id: U, storage_path: `${U}/${id}.jpg`, media_type: 'image' });
const link = (postId: string, assetId: string, position = 0) => ({ post_id: postId, user_id: U, asset_id: assetId, position });
const base = (extra: Record<string, Rows> = {}): Record<string, Rows> => ({
  settings: [], instagram_accounts: [account()], posts: [post()], post_media: [link('p1', 'a1')], video_assets: [video('a1')], activity_log: [], connector_runtime: [], ...extra,
});
const tick = (db: unknown, fetcher: typeof fetch, at = NOW) => runPublishTick(db as never, { masterKey: 'key', fetcher, now: () => at });
const row = (tables: Record<string, Rows>, id = 'p1') => tables['posts']?.find(r => r['id'] === id) as Record<string, unknown>;
const noCalls = () => scriptedInstagram(() => ({ json: {} }));

describe('publisher: a Reels', () => {
  it('creates the container, waits while Instagram processes, then publishes', async () => {
    const { tables, db } = memoryDb(base());
    const status = ['IN_PROGRESS', 'FINISHED'];
    const ig = scriptedInstagram(call => {
      if (call.method === 'POST' && call.path === '/ig1/media') return { json: { id: 'c1' } };
      if (call.method === 'GET') return { json: { status_code: status.shift() ?? 'FINISHED' } };
      return { json: { id: 'm1' } };
    });
    const first = await tick(db, ig.fetcher);
    expect(first.started).toBe(1);
    expect(ig.calls[0]).toMatchObject({ method: 'POST', path: '/ig1/media', auth: 'Bearer tok', params: { media_type: 'REELS', video_url: 'https://files.test/user-1/a1.mp4', caption: 'Olha esse achadinho', share_to_feed: 'true' } });
    expect(row(tables)).toMatchObject({ status: 'publishing', attempts: 1, publish_state: { phase: 'container', containerId: 'c1' } });
    await tick(db, ig.fetcher, NOW + 60_000);
    expect(row(tables)['status']).toBe('publishing');
    expect(ig.calls.some(call => call.path.endsWith('media_publish'))).toBe(false);
    const last = await tick(db, ig.fetcher, NOW + 120_000);
    expect(last.published).toBe(1);
    expect(ig.calls.at(-1)).toMatchObject({ method: 'POST', path: '/ig1/media_publish', params: { creation_id: 'c1' } });
    expect(row(tables)).toMatchObject({ status: 'published', ig_media_id: 'm1', publish_state: null, error: null });
    expect(tables['activity_log']?.some(entry => entry['action'] === 'Publicação enviada')).toBe(true);
    expect(tables['connector_runtime']?.[0]?.['scope']).toBe('publish-heartbeat');
  });
  it('does not touch publications that are not due yet', async () => {
    const { tables, db } = memoryDb(base({ posts: [post({ scheduled_at: iso(NOW + 3_600_000) })] }));
    const ig = noCalls(); await tick(db, ig.fetcher);
    expect(ig.calls).toHaveLength(0); expect(row(tables)['status']).toBe('scheduled');
  });
});

describe('publisher: Story and carousel', () => {
  it('sends a Story photo without caption', async () => {
    const { db } = memoryDb(base({ posts: [post({ format: 'story' })], video_assets: [image('a1')] }));
    const ig = scriptedInstagram(() => ({ json: { id: 'c1' } })); await tick(db, ig.fetcher);
    expect(ig.calls[0]?.params).toEqual({ media_type: 'STORIES', image_url: 'https://files.test/user-1/a1.jpg' });
  });
  it('sends a photo with its caption', async () => {
    const { db } = memoryDb(base({ posts: [post({ format: 'photo' })], video_assets: [image('a1')] }));
    const ig = scriptedInstagram(() => ({ json: { id: 'c1' } })); await tick(db, ig.fetcher);
    expect(ig.calls[0]?.params).toEqual({ image_url: 'https://files.test/user-1/a1.jpg', caption: 'Olha esse achadinho' });
  });
  it('builds each item, then the carousel, in order, and publishes it', async () => {
    const { tables, db } = memoryDb(base({ posts: [post({ format: 'carousel' })], video_assets: [image('a1'), video('a2')], post_media: [link('p1', 'a2', 1), link('p1', 'a1', 0)] }));
    let child = 0;
    const ig = scriptedInstagram(call => {
      if (call.method === 'POST' && call.path === '/ig1/media') return { json: { id: call.params['media_type'] === 'CAROUSEL' ? 'parent' : `k${++child}` } };
      if (call.method === 'GET') return { json: { status_code: 'FINISHED' } };
      return { json: { id: 'm2' } };
    });
    await tick(db, ig.fetcher);
    expect(ig.calls[0]?.params).toEqual({ image_url: 'https://files.test/user-1/a1.jpg', is_carousel_item: 'true' });
    expect(ig.calls[1]?.params).toEqual({ media_type: 'VIDEO', video_url: 'https://files.test/user-1/a2.mp4', is_carousel_item: 'true' });
    expect(row(tables)['publish_state']).toMatchObject({ phase: 'children', children: ['k1', 'k2'] });
    await tick(db, ig.fetcher, NOW + 60_000);
    expect(ig.calls.find(call => call.params['media_type'] === 'CAROUSEL')?.params).toMatchObject({ children: 'k1,k2', caption: 'Olha esse achadinho' });
    expect(row(tables)['publish_state']).toMatchObject({ phase: 'container', containerId: 'parent' });
    await tick(db, ig.fetcher, NOW + 120_000);
    expect(row(tables)).toMatchObject({ status: 'published', ig_media_id: 'm2' });
  });
});

describe('publisher: account protection', () => {
  it('moves the publication to the next day when the warm-up limit is reached', async () => {
    const todays = post({ id: 'p0', status: 'published', published_at: '2026-11-08T13:00:00.000Z', scheduled_at: '2026-11-08T13:00:00.000Z' });
    const { tables, db } = memoryDb(base({ instagram_accounts: [account({ warmup_started_at: '2026-11-08T10:00:00.000Z' })], posts: [todays, post()] }));
    const ig = noCalls(); const result = await tick(db, ig.fetcher);
    expect(result.limited).toBe(1); expect(ig.calls).toHaveLength(0);
    expect(row(tables)).toMatchObject({ status: 'scheduled', scheduled_at: '2026-11-09T11:00:00.000Z' });
    expect(tables['activity_log']?.some(entry => entry['action'] === 'Limite diário atingido')).toBe(true);
  });
  it('waits for the minimum interval between publications', async () => {
    const recent = post({ id: 'p0', status: 'published', published_at: iso(NOW - 10 * 60_000), scheduled_at: iso(NOW - 10 * 60_000) });
    const { tables, db } = memoryDb(base({ posts: [recent, post()] }));
    const ig = noCalls(); const result = await tick(db, ig.fetcher);
    expect(result.waiting).toBe(1); expect(ig.calls).toHaveLength(0);
    expect(row(tables)['status']).toBe('scheduled'); expect(String(row(tables)['error'])).toMatch(/intervalo mínimo/);
  });
  it('sends one publication at a time per account', async () => {
    const running = post({ id: 'p2', status: 'publishing', publish_state: { phase: 'container', containerId: 'c9', startedAt: NOW - 60_000 }, updated_at: iso(NOW - 60_000), scheduled_at: iso(NOW - 600_000) });
    const { tables, db } = memoryDb(base({ posts: [running, post()] }));
    const ig = scriptedInstagram(() => ({ json: { status_code: 'IN_PROGRESS' } })); const result = await tick(db, ig.fetcher);
    expect(result.waiting).toBe(1); expect(ig.calls.every(call => call.method === 'GET')).toBe(true); expect(row(tables)['status']).toBe('scheduled');
  });
  it('pauses everything and keeps the publication when the account is not connected', async () => {
    const { tables, db } = memoryDb(base({ instagram_accounts: [account({ status: 'expired' })] }));
    const ig = noCalls(); const result = await tick(db, ig.fetcher);
    expect(result.paused).toBe(1); expect(ig.calls).toHaveLength(0);
    expect(row(tables)['status']).toBe('scheduled'); expect(String(row(tables)['error'])).toMatch(/expirou/);
  });
});

describe('publisher: failures', () => {
  it('schedules another try after a refusal, without publishing twice', async () => {
    const { tables, db } = memoryDb(base());
    const ig = scriptedInstagram(() => ({ status: 400, json: { error: { code: 100, message: 'Invalid parameter' } } }));
    const result = await tick(db, ig.fetcher);
    expect(result.retried).toBe(1);
    expect(row(tables)).toMatchObject({ status: 'scheduled', attempts: 1, scheduled_at: iso(NOW + 300_000), publish_state: null });
    expect(String(row(tables)['error'])).toMatch(/recusou/);
    expect(ig.calls.filter(call => call.path.endsWith('media_publish'))).toHaveLength(0);
  });
  it('gives up after the maximum number of tries', async () => {
    const { tables, db } = memoryDb(base({ posts: [post({ attempts: 2 })] }));
    const ig = scriptedInstagram(() => ({ status: 400, json: { error: { code: 100, message: 'Invalid parameter' } } }));
    const result = await tick(db, ig.fetcher);
    expect(result.failed).toBe(1); expect(row(tables)).toMatchObject({ status: 'failed', attempts: 3 });
  });
  it('marks the account as expired and does not use up a try when the token is rejected', async () => {
    const { tables, db } = memoryDb(base());
    const ig = scriptedInstagram(() => ({ status: 400, json: { error: { code: 190, message: 'Invalid OAuth access token' } } }));
    const result = await tick(db, ig.fetcher);
    expect(result.paused).toBe(1);
    expect(tables['instagram_accounts']?.[0]?.['status']).toBe('expired');
    expect(row(tables)).toMatchObject({ status: 'scheduled', attempts: 0 });
    const again = noCalls(); await tick(db, again.fetcher, NOW + 60_000);
    expect(again.calls).toHaveLength(0);
  });
  it('treats an error status of the container as a failed try', async () => {
    const stuck = post({ status: 'publishing', attempts: 3, publish_state: { phase: 'container', containerId: 'c1', startedAt: NOW - 60_000 }, updated_at: iso(NOW - 60_000) });
    const { tables, db } = memoryDb(base({ posts: [stuck] }));
    const ig = scriptedInstagram(() => ({ json: { status_code: 'ERROR', status: 'Error: Media upload has failed' } }));
    await tick(db, ig.fetcher);
    expect(row(tables)['status']).toBe('failed'); expect(String(row(tables)['error'])).toMatch(/processar/);
  });
  it('gives up on a publication Instagram never finishes processing', async () => {
    const stuck = post({ status: 'publishing', attempts: 1, publish_state: { phase: 'container', containerId: 'c1', startedAt: NOW - 31 * 60_000 }, updated_at: iso(NOW - 31 * 60_000) });
    const { tables, db } = memoryDb(base({ posts: [stuck] }));
    const ig = scriptedInstagram(() => ({ json: { status_code: 'IN_PROGRESS' } }));
    const result = await tick(db, ig.fetcher);
    expect(result.retried).toBe(1); expect(row(tables)['status']).toBe('scheduled'); expect(String(row(tables)['error'])).toMatch(/demorou/);
  });
  it('fails right away, without trying again, when the files do not fit the format', async () => {
    const { tables, db } = memoryDb(base({ video_assets: [image('a1')] }));
    const ig = noCalls(); await tick(db, ig.fetcher);
    expect(ig.calls).toHaveLength(0); expect(row(tables)['status']).toBe('failed'); expect(String(row(tables)['error'])).toMatch(/não servem/);
  });
  it('treats an unreadable connection as an expired one', async () => {
    control.tokenOk = false;
    try {
      const { tables, db } = memoryDb(base());
      const ig = noCalls(); const result = await tick(db, ig.fetcher);
      expect(result.paused).toBe(1); expect(row(tables)).toMatchObject({ status: 'scheduled', attempts: 0 });
    } finally { control.tokenOk = true; }
  });
});