import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  let parse: (input: unknown) => unknown = input => input;
  const builder = {
    middleware: () => builder,
    inputValidator: (validator: (input: unknown) => unknown) => { parse = validator; return builder; },
    handler: (handler: (args: { context: unknown; data: unknown }) => unknown) => (args: { context: unknown; data: unknown }) => handler({ ...args, data: parse(args.data) }),
  };
  return builder;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({ get supabaseAdmin() { return state.db; } }));

import { FORMAT_RULES, checkSchedule, createPostSchema, kindOfMime, ownsMediaPath, validateMedia, zonedTimeToUtcIso } from '@/lib/posts';
import { createManualPost, cancelPost, queuePostNow } from '@/lib/posts.functions';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const FILE2 = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';

describe('media rules per format', () => {
  it('reels takes exactly one video', () => {
    expect(validateMedia('reel', ['video'])).toBeNull();
    expect(validateMedia('reel', ['image'])).toMatch(/só vídeo/);
    expect(validateMedia('reel', ['video', 'video'])).toMatch(/precisa de/);
  });
  it('story takes one photo or one video', () => {
    expect(validateMedia('story', ['image'])).toBeNull();
    expect(validateMedia('story', ['video'])).toBeNull();
    expect(validateMedia('story', ['image', 'image'])).not.toBeNull();
  });
  it('photo takes exactly one photo', () => {
    expect(validateMedia('photo', ['image'])).toBeNull();
    expect(validateMedia('photo', ['video'])).toMatch(/só foto/);
  });
  it('carousel takes from 2 to 10 items, mixed', () => {
    expect(validateMedia('carousel', ['image'])).not.toBeNull();
    expect(validateMedia('carousel', ['image', 'video'])).toBeNull();
    expect(validateMedia('carousel', Array(10).fill('image'))).toBeNull();
    expect(validateMedia('carousel', Array(11).fill('image'))).not.toBeNull();
    expect(FORMAT_RULES.carousel.max).toBe(10);
  });
  it('knows which file types are accepted', () => {
    expect(kindOfMime('image/jpeg')).toBe('image');
    expect(kindOfMime('video/mp4')).toBe('video');
    expect(kindOfMime('video/quicktime')).toBe('video');
    expect(kindOfMime('image/png')).toBeNull();
  });
});

describe('time zone conversion and schedule limits', () => {
  it('converts wall-clock time in São Paulo and Manaus to UTC', () => {
    expect(zonedTimeToUtcIso('2026-11-08T14:30', 'America/Sao_Paulo')).toBe('2026-11-08T17:30:00.000Z');
    expect(zonedTimeToUtcIso('2026-11-08T14:30', 'America/Manaus')).toBe('2026-11-08T18:30:00.000Z');
  });
  it('rejects impossible dates and bad text', () => {
    expect(zonedTimeToUtcIso('2026-02-31T10:00', 'America/Sao_Paulo')).toBeNull();
    expect(zonedTimeToUtcIso('amanhã', 'America/Sao_Paulo')).toBeNull();
    expect(zonedTimeToUtcIso('2026-11-08T14:30', 'Nao/Existe')).toBeNull();
  });
  it('accepts only future times within 60 days', () => {
    const now = Date.UTC(2026, 10, 6, 12, 0);
    expect(checkSchedule(null, now)).toBeNull();
    expect(checkSchedule(new Date(now + 3_600_000).toISOString(), now)).toBeNull();
    expect(checkSchedule(new Date(now - 1000).toISOString(), now)).toMatch(/passou/);
    expect(checkSchedule(new Date(now + 61 * 86_400_000).toISOString(), now)).toMatch(/60 dias/);
  });
});

describe('input validation', () => {
  const base = { requestId: REQUEST, format: 'reel', productId: PRODUCT, media: [{ path: `${USER}/${FILE}.mp4` }] };
  it('accepts a valid manual post and fills defaults', () => {
    const parsed = createPostSchema.parse(base);
    expect(parsed.caption).toBe(''); expect(parsed.affiliateLink).toBe(''); expect(parsed.scheduledAt).toBeNull();
  });
  it('rejects paths that are not produced by the upload screen', () => {
    expect(createPostSchema.safeParse({ ...base, media: [{ path: '../../etc/passwd' }] }).success).toBe(false);
    expect(createPostSchema.safeParse({ ...base, media: [{ path: `${USER}/${FILE}.png` }] }).success).toBe(false);
  });
  it('rejects links that are not from Shopee and captions that are too long', () => {
    expect(createPostSchema.safeParse({ ...base, affiliateLink: 'https://example.com/x' }).success).toBe(false);
    expect(createPostSchema.safeParse({ ...base, affiliateLink: 'https://shope.ee/abc' }).success).toBe(true);
    expect(createPostSchema.safeParse({ ...base, caption: 'a'.repeat(2201) }).success).toBe(false);
  });
  it('checks that a path is inside the user folder', () => {
    expect(ownsMediaPath(`${USER}/${FILE}.mp4`, USER)).toBe(true);
    expect(ownsMediaPath(`${OTHER}/${FILE}.mp4`, USER)).toBe(false);
  });
});

type Options = { account?: unknown; product?: unknown; objects?: Record<string, { size: number; mimetype: string }>; insertError?: Record<string, { code?: string } | undefined>; wait?: number; changed?: unknown[] };
function fakeDb(options: Options) {
  const calls = { inserts: [] as { table: string; rows: unknown }[], deletes: [] as string[], updates: [] as { table: string; values: unknown }[] };
  const from = (table: string) => {
    let mode: 'read' | 'delete' | 'update' | 'insert' = 'read';
    const settle = () => {
      if (mode === 'insert') return { data: null, error: options.insertError?.[table] ?? null };
      if (mode === 'update') return { data: options.changed ?? [], error: null };
      return { data: null, error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: table === 'instagram_accounts' ? options.account ?? null : table === 'products' ? options.product ?? null : null, error: null }),
      insert: (rows: unknown) => { mode = 'insert'; calls.inserts.push({ table, rows }); return chain; },
      update: (values: unknown) => { mode = 'update'; calls.updates.push({ table, values }); return chain; },
      delete: () => { mode = 'delete'; calls.deletes.push(table); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return chain;
  };
  const storage = { from: () => ({
    list: async (_folder: string, query: { search: string }) => ({ data: Object.entries(options.objects ?? {}).filter(([name]) => name === query.search).map(([name, metadata]) => ({ name, metadata })), error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }),
  }) };
  return { calls, db: { from, storage, rpc: async () => ({ data: options.wait ?? 0, error: null }) } };
}
const ctx = { context: { userId: USER, supabase: {}, claims: {} } };
const post = (data: unknown) => (createManualPost as unknown as (args: unknown) => Promise<{ status: string; message?: string; postId?: string }>)({ ...ctx, data });
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const good: Options = { account: { id: 'acc', status: 'connected' }, product: { id: PRODUCT }, objects: { [`${FILE}.mp4`]: { size: 1_000_000, mimetype: 'video/mp4' } } };
const input = { requestId: REQUEST, format: 'reel', productId: PRODUCT, caption: 'Olha esse achadinho', media: [{ path: `${USER}/${FILE}.mp4` }] };

describe('createManualPost', () => {
  it('registers the file, the post and the media link, as a draft', async () => {
    const { db, calls } = fakeDb(good); state.db = db;
    const result = await post(input);
    expect(result.status).toBe('ok');
    expect(calls.inserts.map(c => c.table)).toEqual(['video_assets', 'posts', 'post_media', 'activity_log']);
    const postRow = (calls.inserts[1]?.rows as Record<string, unknown>);
    expect(postRow['status']).toBe('draft'); expect(postRow['user_id']).toBe(USER); expect(postRow['instagram_account_id']).toBe('acc'); expect(postRow['idempotency_key']).toBe(REQUEST);
    const asset = (calls.inserts[0]?.rows as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(asset['media_type']).toBe('video'); expect(asset['source']).toBe('manual'); expect(asset['size_bytes']).toBe(1_000_000);
  });
  it('schedules when a future time is given and keeps the carousel order', async () => {
    const objects = { [`${FILE}.jpg`]: { size: 500, mimetype: 'image/jpeg' }, [`${FILE2}.mp4`]: { size: 900, mimetype: 'video/mp4' } };
    const { db, calls } = fakeDb({ ...good, objects }); state.db = db;
    const result = await post({ ...input, format: 'carousel', scheduledAt: future(), media: [{ path: `${USER}/${FILE}.jpg` }, { path: `${USER}/${FILE2}.mp4` }] });
    expect(result.status).toBe('ok');
    expect((calls.inserts[1]?.rows as Record<string, unknown>)['status']).toBe('scheduled');
    const links = calls.inserts[2]?.rows as { position: number }[];
    expect(links.map(l => l.position)).toEqual([0, 1]);
  });
  it('refuses files from another user and writes nothing', async () => {
    const { db, calls } = fakeDb(good); state.db = db;
    const result = await post({ ...input, media: [{ path: `${OTHER}/${FILE}.mp4` }] });
    expect(result.status).toBe('error'); expect(calls.inserts).toHaveLength(0);
  });
  it('refuses when the stored file is missing, too big or of another type', async () => {
    for (const objects of [{}, { [`${FILE}.mp4`]: { size: 60_000_000, mimetype: 'video/mp4' } }, { [`${FILE}.mp4`]: { size: 10, mimetype: 'image/jpeg' } }]) {
      const { db, calls } = fakeDb({ ...good, objects }); state.db = db;
      expect((await post(input)).status).toBe('error'); expect(calls.inserts).toHaveLength(0);
    }
  });
  it('refuses a photo for Reels and a past time', async () => {
    const objects = { [`${FILE}.jpg`]: { size: 500, mimetype: 'image/jpeg' } };
    const first = fakeDb({ ...good, objects }); state.db = first.db;
    expect((await post({ ...input, media: [{ path: `${USER}/${FILE}.jpg` }] })).status).toBe('error'); expect(first.calls.inserts).toHaveLength(0);
    const second = fakeDb(good); state.db = second.db;
    expect((await post({ ...input, scheduledAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe('error');
  });
  it('needs a connected Instagram account and an existing product', async () => {
    const noAccount = fakeDb({ ...good, account: null }); state.db = noAccount.db;
    expect((await post(input)).message).toMatch(/Conecte o Instagram/);
    const noProduct = fakeDb({ ...good, product: null }); state.db = noProduct.db;
    expect((await post(input)).message).toMatch(/produto/);
  });
  it('asks to wait when the same user clicks twice in a row', async () => {
    const { db, calls } = fakeDb({ ...good, wait: 1500 }); state.db = db;
    expect((await post(input)).message).toMatch(/Aguarde/); expect(calls.inserts).toHaveLength(0);
  });
  it('undoes the registered files when the post cannot be created', async () => {
    const { db, calls } = fakeDb({ ...good, insertError: { posts: {} } }); state.db = db;
    expect((await post(input)).status).toBe('error');
    expect(calls.deletes).toEqual(['posts', 'video_assets']);
  });
  it('treats a repeated request as already registered, without leaving extra files', async () => {
    const { db, calls } = fakeDb({ ...good, insertError: { posts: { code: '23505' } } }); state.db = db;
    const result = await post(input);
    expect(result.status).toBe('ok'); expect(result.message).toMatch(/já tinha/); expect(calls.deletes).toContain('video_assets');
  });
});

describe('cancelPost', () => {
  const cancel = (changed: unknown[]) => { const { db } = fakeDb({ changed }); state.db = db; return (cancelPost as unknown as (args: unknown) => Promise<{ status: string }>)({ ...ctx, data: { postId: PRODUCT } }); };
  it('cancels drafts and scheduled posts only', async () => {
    expect((await cancel([{ id: PRODUCT }])).status).toBe('ok');
    expect((await cancel([])).status).toBe('error');
  });
});

describe('queuePostNow', () => {
  const queue = (options: Options) => {
    const { db, calls } = fakeDb(options); state.db = db;
    return { calls, run: () => (queuePostNow as unknown as (args: unknown) => Promise<{ status: string; message?: string }>)({ ...ctx, data: { postId: PRODUCT } }) };
  };
  it('puts a draft, scheduled or failed post at the front of the queue and resets its tries', async () => {
    const { calls, run } = queue({ account: { status: 'connected' }, changed: [{ id: PRODUCT }] });
    expect((await run()).status).toBe('ok');
    const values = calls.updates.find(update => update.table === 'posts')?.values as Record<string, unknown>;
    expect(values).toMatchObject({ status: 'scheduled', attempts: 0, error: null });
    expect(typeof values['scheduled_at']).toBe('string');
  });
  it('refuses when Instagram is not connected', async () => {
    const { calls, run } = queue({ account: { status: 'expired' }, changed: [{ id: PRODUCT }] });
    expect((await run()).message).toMatch(/Reconecte/); expect(calls.updates).toHaveLength(0);
  });
  it('refuses a post that cannot be sent now', async () => {
    const { run } = queue({ account: { status: 'connected' }, changed: [] });
    expect((await run()).status).toBe('error');
  });
});