import { describe, expect, it, vi } from 'vitest';
import { memoryDb, type Rows } from './memory-db';

const state = vi.hoisted(() => ({
  token: { token: 'tok', igUserId: 'ig1', pageId: 'page1' } as { token: string; igUserId: string; pageId: string | null } | null,
  expired: false, appSecret: 'app-secret' as string | null, granted: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages'] as string[],
}));
vi.mock('@/lib/instagram.server', () => {
  class InstagramError extends Error { constructor(readonly code = 'expirado') { super(code); } }
  return {
    InstagramError,
    getPublishingToken: async () => { if (state.expired) throw new InstagramError(); return state.token; },
    loadAppCredentials: async () => (state.appSecret ? { appSecret: state.appSecret } : null),
    fetchGrantedPermissions: async () => state.granted,
  };
});

import {
  DEFAULT_TEMPLATE, DM_MAX_BYTES, buildDm, matchesTrigger, normalizeText, outcomeMessage, outcomeOf, parseWebhook, replySettingsSchema, verifySignature,
} from '@/lib/comment-reply';
import { ReplyError, checkReplySetup, handleWebhookRequest, ingestEvents, loadReplyView, saveReplySettings, sendPending, sendPrivateReply, subscribeComments } from '@/lib/comment-reply.server';

const U = 'user-1';
const NOW = Date.parse('2026-11-19T15:00:00.000Z');
const HOUR = 3_600_000; const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('recognizing the trigger', () => {
  it('ignores case, accents, punctuation and emojis', () => {
    for (const comment of ['EU QUERO', 'eu quero', 'Eu quero!!!', 'EU QUERO 😍😍', '  eu   quero  ', 'Éu quéro', 'eu-quero', 'Oi, eu quero muito esse!', '"eu quero"']) expect(matchesTrigger(comment, 'EU QUERO'), comment).toBe(true);
  });
  it('needs the whole phrase as separate words', () => {
    for (const comment of ['euquero', 'quero', 'eu queroo', 'eu', 'tenho eu querida', 'quero eu', '', '😍😍']) expect(matchesTrigger(comment, 'EU QUERO'), comment).toBe(false);
  });
  it('works with another trigger and refuses an empty one', () => {
    expect(matchesTrigger('Quero o link!', 'quero o link')).toBe(true); expect(matchesTrigger('qualquer coisa', '')).toBe(false); expect(matchesTrigger('qualquer coisa', '!!!')).toBe(false);
  });
  it('cleans text the same way every time', () => {
    expect(normalizeText('Éu  QUÉRO!!! 😍')).toBe('eu quero'); expect(normalizeText('')).toBe('');
  });
});

describe('the message', () => {
  it('puts the link where {link} is', () => {
    expect(buildDm('Oi! Seu link: {link}', 'https://shope.ee/abc')).toBe('Oi! Seu link: https://shope.ee/abc');
    expect(buildDm('{link} e de novo {link}', 'L')).toBe('L e de novo L');
  });
  it('keeps the default message, with the link, when the text would pass 1,000 bytes', () => {
    const long = `${'😍'.repeat(300)} {link}`;
    const message = buildDm(long, 'https://shope.ee/abc');
    expect(message).toBe(DEFAULT_TEMPLATE.replace('{link}', 'https://shope.ee/abc'));
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(DM_MAX_BYTES);
  });
  it('checks what the user saves', () => {
    expect(replySettingsSchema.safeParse({ enabled: true, template: 'Seu link: {link}' }).success).toBe(true);
    expect(replySettingsSchema.safeParse({ enabled: true, template: 'Sem o lugar do link' }).success).toBe(false);
    expect(replySettingsSchema.safeParse({ enabled: true, template: '{l}' }).success).toBe(false);
    expect(replySettingsSchema.safeParse({ enabled: true, template: `${'a'.repeat(600)}{link}` }).success).toBe(false);
    expect(replySettingsSchema.safeParse({ enabled: 'yes', template: 'Seu link: {link}' }).success).toBe(false);
  });
});

const comment = (extra: Record<string, unknown> = {}) => ({ from: { id: 'user-a', username: 'maria' }, media: { id: 'media1', media_product_type: 'REELS' }, id: 'c1', text: 'eu quero!', ...extra });
const notification = (value: unknown = comment(), entryId = 'ig1') => ({ object: 'instagram', entry: [{ id: entryId, time: 1_700_000_000, changes: [{ field: 'comments', value }] }] });

describe('reading the notification from Meta', () => {
  it('reads a comment in the "changes" shape', () => {
    expect(parseWebhook(notification())).toEqual([{ igUserId: 'ig1', commentId: 'c1', fromId: 'user-a', username: 'maria', text: 'eu quero!', mediaId: 'media1', parentId: null }]);
  });
  it('reads the shape where the field is directly in the entry', () => {
    const direct = { object: 'instagram', entry: [{ id: '17841400000000000', field: 'comments', value: { id: '18000000000000000', media: { id: '17900000000000000' }, from: { id: '55', username: 'x' }, text: 'EU QUERO', parent_id: 'p9' } }] };
    expect(parseWebhook(direct)).toMatchObject([{ igUserId: '17841400000000000', commentId: '18000000000000000', mediaId: '17900000000000000', parentId: 'p9', fromId: '55', username: 'x' }]);
  });
  it('refuses ids sent as numbers, because a long number loses digits and would point to the wrong comment', () => {
    expect(parseWebhook({ object: 'instagram', entry: [{ id: 'ig1', changes: [{ field: 'comments', value: { id: 18000000000000000, media: { id: 'm1' }, text: 'x' } }] }] })).toEqual([]);
  });
  it('reads several comments and ignores everything else', () => {
    const body = { object: 'instagram', entry: [{ id: 'ig1', changes: [{ field: 'comments', value: comment() }, { field: 'mentions', value: comment({ id: 'c2' }) }, { field: 'comments', value: comment({ id: 'c3', text: 'oi' }) }] }, { id: 'ig2', changes: [{ field: 'comments', value: comment({ id: 'c4' }) }] }] };
    expect(parseWebhook(body).map(event => [event.igUserId, event.commentId])).toEqual([['ig1', 'c1'], ['ig1', 'c3'], ['ig2', 'c4']]);
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual([]); expect(parseWebhook(null)).toEqual([]); expect(parseWebhook('texto')).toEqual([]); expect(parseWebhook({ object: 'instagram' })).toEqual([]);
    expect(parseWebhook(notification({ id: 'c1', text: 'x' }))).toEqual([]); // no media: cannot be matched
    expect(parseWebhook(notification({ media: { id: 'm' }, text: 'x' }))).toEqual([]); // no comment id
  });
  it('treats a missing text as empty', () => {
    expect(parseWebhook(notification({ id: 'c1', media: { id: 'm1' } }))[0]?.text).toBe('');
  });
});

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
describe('checking that Meta really sent it', () => {
  it('accepts the right signature and refuses everything else', async () => {
    const body = JSON.stringify(notification());
    const good = await sign(body, 'app-secret');
    expect(await verifySignature(body, good, 'app-secret')).toBe(true);
    expect(await verifySignature(body, good.toUpperCase().replace('SHA256=', 'sha256='), 'app-secret')).toBe(true);
    expect(await verifySignature(`${body} `, good, 'app-secret')).toBe(false); // the text was changed
    expect(await verifySignature(body, good, 'other-secret')).toBe(false);
    expect(await verifySignature(body, null, 'app-secret')).toBe(false);
    expect(await verifySignature(body, good.replace('sha256=', 'sha1='), 'app-secret')).toBe(false);
    expect(await verifySignature(body, 'sha256=abc', 'app-secret')).toBe(false);
    expect(await verifySignature(body, good, '')).toBe(false);
  });
});

describe('what Instagram answers', () => {
  const of = (code: number | null, subcode: number | null = null, status = 400) => outcomeOf({ code, subcode, status });
  it('tells apart each answer to a private reply', () => {
    expect(of(100, 2534023)).toBe('already'); expect(of(100, 2534025)).toBe('expired'); expect(of(100, 2534022)).toBe('blocked');
    expect(of(190)).toBe('auth'); expect(of(null, null, 401)).toBe('auth'); expect(of(10)).toBe('permission'); expect(of(200)).toBe('permission'); expect(of(null, null, 403)).toBe('permission');
    expect(of(4)).toBe('retry'); expect(of(17)).toBe('retry'); expect(of(2)).toBe('retry'); expect(of(null, null, 500)).toBe('retry'); expect(of(null, null, 429)).toBe('retry');
    expect(of(100)).toBe('invalid'); expect(of(null, null, 400)).toBe('invalid');
  });
  it('explains each one in Portuguese', () => {
    for (const outcome of ['sent', 'already', 'expired', 'blocked', 'auth', 'permission', 'retry', 'invalid'] as const) expect(outcomeMessage(outcome).length).toBeGreaterThan(10);
  });
});

// ---------- the whole thing, with the database and Instagram replaced by stand-ins ----------
type Call = { method: string; path: string; search: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
type Reply = { status?: number; json?: unknown; throws?: boolean };
type Options = { posts?: Rows; events?: Rows; settings?: Rows; accounts?: Rows; wait?: number; replies?: Reply[] };
function world(options: Options = {}) {
  const calls: Call[] = []; const replies = [...(options.replies ?? [])]; const state2 = { wait: options.wait ?? 0 }; const sleeps: number[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ method: init?.method ?? 'GET', path: parsed.pathname.replace(/^\/v[\d.]+/, ''), search: parsed.search, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    const reply = replies.shift() ?? { json: { recipient_id: 'user-a', message_id: 'mid-1' } };
    if (reply.throws) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  const built = memoryDb({
    instagram_accounts: options.accounts ?? [{ id: 'acc', user_id: U, ig_user_id: 'ig1', page_id: 'page1', status: 'connected' }],
    comment_reply_settings: options.settings ?? [{ user_id: U, enabled: true, template: 'Oi! Seu link: {link}', last_message: null, last_event_at: null }],
    posts: options.posts ?? [{ id: 'p1', user_id: U, ig_media_id: 'media1', status: 'published', trigger_word: 'EU QUERO', affiliate_link: 'https://shope.ee/abc', format: 'reel' }],
    comment_events: options.events ?? [], activity_log: [],
  });
  // The real table refuses a repeated comment id and creates the id and the dates by itself; the stand-in does the same.
  const db = { ...built.db, rpc: async () => ({ data: state2.wait, error: null }), from: (name: string) => {
    const chain = built.db.from(name) as Record<string, unknown>;
    if (name === 'comment_events') {
      const original = chain['insert'] as (rows: unknown) => unknown;
      chain['insert'] = (rows: Record<string, unknown>) => {
        if (built.tables['comment_events']?.some(row => row['comment_id'] === rows['comment_id'])) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
        return original({ id: crypto.randomUUID(), created_at: iso(NOW), updated_at: iso(NOW), ...rows });
      };
    }
    return chain;
  } };
  return { tables: built.tables, db, fetcher, calls, state: state2, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}
type World = ReturnType<typeof world>;
const event = (extra: Record<string, unknown> = {}) => ({ igUserId: 'ig1', commentId: 'c1', fromId: 'user-a', username: 'maria', text: 'eu quero!', mediaId: 'media1', parentId: null, ...extra });
const queued = (extra: Record<string, unknown> = {}) => ({ id: `e-${Math.random()}`, user_id: U, post_id: 'p1', comment_id: `c-${Math.random()}`, author_id: 'user-a', author_username: 'maria', status: 'detected', attempts: 0, error: null, commented_at: iso(NOW - 5 * 60_000), created_at: iso(NOW - 5 * 60_000), updated_at: iso(NOW - 5 * 60_000), ...extra });
const send = (w: World, extra: { limit?: number } = {}) => sendPending(w.db as never, { masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep, ...extra });
const ingest = (w: World, events: ReturnType<typeof event>[]) => ingestEvents(w.db as never, events, { now: () => NOW });
const rowOf = (w: World, index = 0) => w.tables['comment_events']?.[index] as Record<string, unknown>;

describe('queuing the comments', () => {
  it('queues a comment that asks for the link on a published post', async () => {
    const w = world();
    expect(await ingest(w, [event()])).toBe(1);
    expect(rowOf(w)).toMatchObject({ user_id: U, post_id: 'p1', comment_id: 'c1', author_id: 'user-a', author_username: 'maria', status: 'detected', attempts: 0, commented_at: iso(NOW) });
  });
  it('leaves out comments that are not for the automation', async () => {
    const cases: [string, Options, Record<string, unknown>][] = [
      ['another comment', {}, { text: 'que lindo!' }],
      ['own comment', {}, { fromId: 'ig1' }],
      ['unknown post', {}, { mediaId: 'other-media' }],
      ['not published', { posts: [{ id: 'p1', user_id: U, ig_media_id: 'media1', status: 'scheduled', trigger_word: 'EU QUERO', affiliate_link: 'x' }] }, {}],
      ['automation off', { settings: [{ user_id: U, enabled: false, template: 'x {link}' }] }, {}],
      ['never set up', { settings: [] }, {}],
      ['unknown account', {}, { igUserId: 'someone-else' }],
    ];
    for (const [label, options, extra] of cases) { const w = world(options); expect(await ingest(w, [event(extra)]), label).toBe(0); expect(w.tables['comment_events'], label).toHaveLength(0); }
  });
  it('uses the post\'s own trigger, and "EU QUERO" when it has none', async () => {
    const own = world({ posts: [{ id: 'p1', user_id: U, ig_media_id: 'media1', status: 'published', trigger_word: 'QUERO O LINK', affiliate_link: 'x' }] });
    expect(await ingest(own, [event({ text: 'eu quero' })])).toBe(0); expect(await ingest(own, [event({ text: 'Quero o link!!' })])).toBe(1);
    const none = world({ posts: [{ id: 'p1', user_id: U, ig_media_id: 'media1', status: 'published', trigger_word: null, affiliate_link: 'x' }] });
    expect(await ingest(none, [event()])).toBe(1);
  });
  it('ignores a notification delivered twice', async () => {
    const w = world();
    expect(await ingest(w, [event(), event()])).toBe(1); expect(await ingest(w, [event()])).toBe(0); expect(w.tables['comment_events']).toHaveLength(1);
  });
});

describe('sending the private reply', () => {
  it('sends the link to the author of the comment, through the Page', async () => {
    const w = world({ events: [queued({ comment_id: 'c1' })] });
    const result = await send(w);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ method: 'POST', path: '/page1/messages', body: { recipient: { comment_id: 'c1' }, message: { text: 'Oi! Seu link: https://shope.ee/abc' } } });
    expect(w.calls[0]?.headers['authorization']).toBe('Bearer tok');
    expect(rowOf(w)).toMatchObject({ status: 'sent', attempts: 1, error: null, message_id: 'mid-1', sent_at: iso(NOW) });
    expect(w.tables['comment_reply_settings']?.[0]).toMatchObject({ last_event_at: iso(NOW), last_message: null });
    expect(w.tables['activity_log']?.some(entry => entry['action'] === 'Link enviado por mensagem')).toBe(true);
  });
  it('tries the Instagram account when the Page is refused as unsupported, and only then', async () => {
    const w = world({ events: [queued()], replies: [{ status: 400, json: { error: { code: 100, message: 'Unsupported post request' } } }, { json: { message_id: 'mid-2' } }] });
    expect(await send(w)).toMatchObject({ sent: 1 });
    expect(w.calls.map(call => call.path)).toEqual(['/page1/messages', '/ig1/messages']); expect(rowOf(w)).toMatchObject({ status: 'sent', message_id: 'mid-2' });
    state.token = { token: 'tok', igUserId: 'ig1', pageId: null };
    const alone = world({ events: [queued()] }); await send(alone);
    state.token = { token: 'tok', igUserId: 'ig1', pageId: 'page1' };
    expect(alone.calls.map(call => call.path)).toEqual(['/ig1/messages']);
  });
  it('does not try another id after an answer that is not "unsupported"', async () => {
    const w = world({ events: [queued()], replies: [{ status: 400, json: { error: { code: 100, error_subcode: 2534022, message: 'x' } } }] });
    await send(w); expect(w.calls).toHaveLength(1); expect(rowOf(w)).toMatchObject({ status: 'failed' });
  });
  it('closes each kind of refusal in the right way', async () => {
    const run = async (reply: Reply) => { const w = world({ events: [queued()], replies: [reply, reply] }); await send(w); return rowOf(w); };
    expect(await run({ status: 400, json: { error: { code: 100, error_subcode: 2534023 } } })).toMatchObject({ status: 'skipped' });
    expect(await run({ status: 400, json: { error: { code: 100, error_subcode: 2534025 } } })).toMatchObject({ status: 'expired' });
    expect(await run({ status: 400, json: { error: { code: 100, error_subcode: 2534022 } } })).toMatchObject({ status: 'failed' });
    expect(await run({ status: 400, json: { error: { code: 100, message: 'x' } } })).toMatchObject({ status: 'failed' });
  });
  it('retries a temporary problem twice and then gives up', async () => {
    const w = world({ events: [queued()], replies: Array.from({ length: 3 }, () => ({ status: 500, json: { error: { code: 2 } } })) });
    await send(w); expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 1 }); expect(String(rowOf(w)['error'])).toMatch(/tentar de novo/);
    await send(w); expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 2 });
    const last = await send(w); expect(rowOf(w)).toMatchObject({ status: 'failed', attempts: 3 }); expect(last.failed).toBe(1);
  });
  it('a lost answer counts as a temporary problem', async () => {
    const w = world({ events: [queued()], replies: [{ throws: true }] });
    await send(w); expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 1 });
  });
  it('a missing permission is shown on the screen and retried a few times', async () => {
    const w = world({ events: [queued()], replies: [{ status: 403, json: { error: { code: 10, message: 'permission' } } }] });
    await send(w);
    expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 1 }); expect(String(w.tables['comment_reply_settings']?.[0]?.['last_message'])).toMatch(/permissão/);
  });
  it('an expired connection pauses everything and keeps the replies for later', async () => {
    const w = world({ events: [queued({ comment_id: 'a' }), queued({ comment_id: 'b' })], replies: [{ status: 400, json: { error: { code: 190, message: 'Invalid OAuth access token' } } }] });
    const result = await send(w);
    expect(w.calls).toHaveLength(1); expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 0 }); expect(rowOf(w, 1)).toMatchObject({ status: 'detected', attempts: 0 });
    expect(w.tables['instagram_accounts']?.[0]?.['status']).toBe('expired'); expect(String(w.tables['comment_reply_settings']?.[0]?.['last_message'])).toMatch(/expirou/); expect(result.sent).toBe(0);
  });
  it('an unreadable or expired key does the same without calling Instagram', async () => {
    for (const mode of ['expired', 'missing'] as const) {
      state.expired = mode === 'expired'; state.token = mode === 'missing' ? null : state.token;
      const w = world({ events: [queued()] }); await send(w);
      state.expired = false; state.token = { token: 'tok', igUserId: 'ig1', pageId: 'page1' };
      expect(w.calls).toHaveLength(0); expect(rowOf(w)).toMatchObject({ status: 'detected', attempts: 0 }); expect(w.tables['instagram_accounts']?.[0]?.['status']).toBe('expired');
    }
  });
  it('lets a comment older than the 7 days go, without calling Instagram', async () => {
    const w = world({ events: [queued({ commented_at: iso(NOW - 8 * DAY) })] });
    await send(w); expect(w.calls).toHaveLength(0); expect(rowOf(w)).toMatchObject({ status: 'expired' });
  });
  it('does not send when the automation was turned off, or when the post has no link', async () => {
    const off = world({ events: [queued()], settings: [{ user_id: U, enabled: false, template: 'x {link}' }] });
    await send(off); expect(off.calls).toHaveLength(0); expect(rowOf(off)).toMatchObject({ status: 'skipped' });
    const noLink = world({ events: [queued()], posts: [{ id: 'p1', user_id: U, ig_media_id: 'media1', status: 'published', affiliate_link: null }] });
    await send(noLink); expect(noLink.calls).toHaveLength(0); expect(rowOf(noLink)).toMatchObject({ status: 'failed' });
  });
  it('never passes the hourly cap, and the waiting replies go out later', async () => {
    const sent = Array.from({ length: 80 }, (_, i) => queued({ status: 'sent', comment_id: `old-${i}`, sent_at: iso(NOW - 10 * 60_000) }));
    const w = world({ events: [...sent, queued({ comment_id: 'new' })] });
    const result = await send(w);
    expect(w.calls).toHaveLength(0); expect(result.waiting).toBe(1); expect(w.tables['comment_events']?.find(row => row['comment_id'] === 'new')).toMatchObject({ status: 'detected', attempts: 0 });
    const later = world({ events: [...sent.map(row => ({ ...row, sent_at: iso(NOW - 2 * HOUR) })), queued({ comment_id: 'new' })] });
    expect((await send(later)).sent).toBe(1);
  });
  it('waits a little between two messages of the same account', async () => {
    const w = world({ events: [queued()], wait: 1500 });
    await send(w); expect(w.sleeps).toEqual([1500]);
    const far = world({ events: [queued()], wait: 60_000 }); await send(far); expect(far.sleeps).toEqual([3000]);
  });
  it('sends only a few at a time and leaves the rest for the next visit', async () => {
    const w = world({ events: Array.from({ length: 7 }, (_, i) => queued({ comment_id: `c${i}`, created_at: iso(NOW - (10 - i) * 60_000) })) });
    const result = await send(w, { limit: 5 });
    expect(result).toMatchObject({ sent: 5, waiting: 2 }); expect(w.tables['comment_events']?.filter(row => row['status'] === 'detected')).toHaveLength(2);
  });
  it('puts back in the queue a message that was left "sending" by a crash', async () => {
    const w = world({ events: [queued({ status: 'sending', attempts: 1, updated_at: iso(NOW - 10 * 60_000) })] });
    expect((await send(w)).sent).toBe(1);
  });
  it('two visits at the same time send a message only once', async () => {
    const w = world({ events: [queued()] });
    await Promise.all([send(w), send(w)]);
    expect(w.calls).toHaveLength(1); expect(rowOf(w)).toMatchObject({ status: 'sent' });
  });
  it('sendPrivateReply sends exactly what Instagram documents', async () => {
    const w = world();
    await sendPrivateReply(w.fetcher, { token: 't', pageId: 'p', igUserId: 'i', commentId: 'cm', text: 'oi' });
    expect(w.calls[0]).toMatchObject({ method: 'POST', path: '/p/messages', body: { recipient: { comment_id: 'cm' }, message: { text: 'oi' } } });
    await expect(sendPrivateReply(world({ replies: [{ status: 400, json: { error: { code: 100 } } }, { status: 400, json: { error: { code: 100 } } }] }).fetcher, { token: 't', pageId: 'p', igUserId: 'i', commentId: 'cm', text: 'x' })).rejects.toBeInstanceOf(ReplyError);
  });
});

describe('the webhook', () => {
  const request = async (w: World, extra: Partial<Parameters<typeof handleWebhookRequest>[1]> = {}, body = JSON.stringify(notification()), secret = 'app-secret') =>
    handleWebhookRequest(w.db as never, { method: 'POST', query: new URLSearchParams(), signature: await sign(body, secret), rawBody: body, verifyToken: 'verify-me', masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep, ...extra });
  const subscribe = (w: World, query: Record<string, string>, verifyToken: string | undefined = 'verify-me') => handleWebhookRequest(w.db as never, { method: 'GET', query: new URLSearchParams(query), signature: null, rawBody: '', verifyToken, masterKey: 'key' });

  it('answers Meta\'s check with the challenge, and only with the right token', async () => {
    const w = world();
    expect(await subscribe(w, { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' })).toEqual({ status: 200, body: '12345' });
    expect((await subscribe(w, { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);
    expect((await subscribe(w, { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1' })).status).toBe(403);
    expect((await subscribe(w, { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me' })).status).toBe(403);
    expect((await subscribe(w, { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, undefined)).status).toBe(403);
  });
  it('a signed comment is queued and answered right away', async () => {
    const w = world();
    expect(await request(w)).toEqual({ status: 200, body: 'ok' });
    expect(w.calls).toHaveLength(1); expect(rowOf(w)).toMatchObject({ comment_id: 'c1', status: 'sent', author_username: 'maria' });
  });
  it('refuses a notification with a wrong, missing or foreign signature, and does nothing', async () => {
    for (const extra of [{ signature: 'sha256=00' }, { signature: null }]) { const w = world(); expect((await request(w, extra)).status).toBe(401); expect(w.tables['comment_events']).toHaveLength(0); expect(w.calls).toHaveLength(0); }
    const forged = world(); expect((await request(forged, {}, JSON.stringify(notification()), 'attacker-secret')).status).toBe(401); expect(forged.tables['comment_events']).toHaveLength(0);
  });
  it('a body changed after it was signed is refused', async () => {
    const w = world(); const body = JSON.stringify(notification());
    expect((await request(w, { signature: await sign(body, 'app-secret'), rawBody: body.replace('eu quero', 'EU QUERO') })).status).toBe(401);
  });
  it('ignores, with a normal answer, what is not ours or cannot be checked', async () => {
    const other = world(); expect((await request(other, {}, JSON.stringify(notification(comment(), 'someone-else')))).status).toBe(200); expect(other.tables['comment_events']).toHaveLength(0);
    state.appSecret = null; const noSecret = world(); expect((await request(noSecret)).status).toBe(200); state.appSecret = 'app-secret';
    expect(noSecret.tables['comment_events']).toHaveLength(0); expect(noSecret.calls).toHaveLength(0);
  });
  it('answers normally to notifications without comments, and refuses broken ones', async () => {
    const w = world();
    expect((await request(w, {}, JSON.stringify({ object: 'instagram', entry: [{ id: 'ig1', changes: [{ field: 'mentions', value: {} }] }] }))).status).toBe(200);
    expect((await request(w, {}, 'not json')).status).toBe(400); expect((await request(w, { method: 'PUT' })).status).toBe(405);
    expect(w.calls).toHaveLength(0);
  });
  it('a forged entry among real ones refuses the whole notification', async () => {
    state.appSecret = 'app-secret';
    const w = world({ accounts: [{ id: 'acc', user_id: U, ig_user_id: 'ig1', page_id: 'page1', status: 'connected' }] });
    const body = JSON.stringify(notification());
    expect((await request(w, { signature: await sign(body, 'not-the-secret'), rawBody: body })).status).toBe(401);
  });
  it('answers Meta even when the comment does not ask for the link', async () => {
    const w = world(); expect((await request(w, {}, JSON.stringify(notification(comment({ text: 'que lindo!' }))))).status).toBe(200);
    expect(w.tables['comment_events']).toHaveLength(0); expect(w.calls).toHaveLength(0);
  });
});

describe('the screen and the setup checks', () => {
  it('shows the settings, the counts and the latest comments', async () => {
    const events = [queued({ status: 'sent', author_username: 'ana', created_at: iso(NOW - 3 * 60_000) }), queued({ status: 'detected', created_at: iso(NOW - 2 * 60_000) }), queued({ status: 'failed', error: 'x', created_at: iso(NOW - 60_000) })];
    const view = await loadReplyView(world({ events }).db as never, U);
    expect(view).toMatchObject({ enabled: true, template: 'Oi! Seu link: {link}', webhookPath: '/api/public/meta-webhook', counts: { sent: 1, waiting: 1, failed: 1 } });
    expect(view.recent).toHaveLength(3); expect(view.recent[0]?.status).toBe('failed');
    expect(await loadReplyView(world({ settings: [] }).db as never, U)).toMatchObject({ enabled: false, template: DEFAULT_TEMPLATE, recent: [] });
  });
  it('saves the settings, and clears the old warning when turned off', async () => {
    const w = world({ settings: [{ user_id: U, enabled: true, template: 'a {link}', last_message: 'problema' }] });
    expect(await saveReplySettings(w.db as never, U, { enabled: false, template: 'Novo {link}' })).toBe(true);
    expect(w.tables['comment_reply_settings']?.[0]).toMatchObject({ enabled: false, template: 'Novo {link}', last_message: null });
    const fresh = world({ settings: [] }); await saveReplySettings(fresh.db as never, U, { enabled: true, template: 'Primeiro {link}' });
    expect(fresh.tables['comment_reply_settings']?.[0]).toMatchObject({ user_id: U, enabled: true, template: 'Primeiro {link}' });
  });
  it('reads the permissions and whether Meta sends the comments', async () => {
    const w = world({ replies: [{ json: { data: [{ id: 'app', subscribed_fields: ['comments', 'messages'] }] } }] });
    expect(await checkReplySetup(w.db as never, { userId: U, masterKey: 'key', fetcher: w.fetcher })).toEqual({ permissions: { granted: ['instagram_manage_comments', 'instagram_manage_messages'], missing: [], ok: true }, subscription: { ok: true, fields: ['comments', 'messages'] } });
    expect(w.calls[0]).toMatchObject({ method: 'GET', path: '/page1/subscribed_apps' });
  });
  it('points out what is missing', async () => {
    state.granted = ['instagram_basic', 'instagram_content_publish'];
    const missing = world({ replies: [{ json: { data: [{ id: 'app', subscribed_fields: ['feed'] }] } }] });
    const check = await checkReplySetup(missing.db as never, { userId: U, masterKey: 'key', fetcher: missing.fetcher });
    state.granted = ['instagram_basic', 'instagram_manage_comments', 'pages_messaging'];
    expect(check.permissions).toMatchObject({ ok: false, missing: ['instagram_manage_comments', 'instagram_manage_messages'] }); expect(check.subscription).toEqual({ ok: false, fields: ['feed'] });
    const legacy = world({ replies: [{ json: { data: [] } }] });
    expect((await checkReplySetup(legacy.db as never, { userId: U, masterKey: 'key', fetcher: legacy.fetcher })).permissions.ok).toBe(true); // pages_messaging also counts
    state.granted = ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages'];
  });
  it('does not fail the whole check when the subscription cannot be read', async () => {
    const noPage = world(); state.token = { token: 'tok', igUserId: 'ig1', pageId: null };
    const first = await checkReplySetup(noPage.db as never, { userId: U, masterKey: 'key', fetcher: noPage.fetcher }); state.token = { token: 'tok', igUserId: 'ig1', pageId: 'page1' };
    expect(first.subscription).toBeNull();
    const refused = world({ replies: [{ status: 400, json: { error: { code: 100 } } }] });
    expect((await checkReplySetup(refused.db as never, { userId: U, masterKey: 'key', fetcher: refused.fetcher })).subscription).toBeNull();
  });
  it('asks Meta to send the comments of the account', async () => {
    const w = world();
    await subscribeComments(w.db as never, { userId: U, masterKey: 'key', fetcher: w.fetcher });
    expect(w.calls[0]).toMatchObject({ method: 'POST', path: '/page1/subscribed_apps', search: '?subscribed_fields=comments' }); expect(w.calls[0]?.headers['authorization']).toBe('Bearer tok');
  });
  it('explains when there is no Page or the connection expired', async () => {
    state.token = { token: 'tok', igUserId: 'ig1', pageId: null };
    await expect(subscribeComments(world().db as never, { userId: U, masterKey: 'key' })).rejects.toMatchObject({ outcome: 'invalid' }); state.token = { token: 'tok', igUserId: 'ig1', pageId: 'page1' };
    state.token = null; await expect(subscribeComments(world().db as never, { userId: U, masterKey: 'key' })).rejects.toMatchObject({ outcome: 'auth' });
    await expect(checkReplySetup(world().db as never, { userId: U, masterKey: 'key' })).rejects.toMatchObject({ outcome: 'auth' }); state.token = { token: 'tok', igUserId: 'ig1', pageId: 'page1' };
  });
});
