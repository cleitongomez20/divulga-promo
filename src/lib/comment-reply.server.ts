// Server-only: the comment reply. When someone comments the trigger phrase ("EU QUERO") on a published post, the product link is sent
// to that person as a private reply. The whole flow is built around Meta's rules: one private reply per comment, within 7 days, and
// only notifications that really come from Meta are believed (the signature is checked with the app secret of the account's owner).
import type { SupabaseClient } from '@supabase/supabase-js';
import { GRAPH_VERSION, META_APP_ID, REQUIRED_REPLY_PERMISSIONS } from './instagram';
import { InstagramError, fetchGrantedPermissions, getPublishingToken, loadAppCredentials } from './instagram.server';
import {
  DEFAULT_TEMPLATE, DEFAULT_TRIGGER, MAX_DMS_PER_HOUR, MAX_SEND_ATTEMPTS, REPLY_WINDOW_MS, SEND_PACE_MS, STALE_SENDING_MS, WEBHOOK_PATH, buildDm, matchesTrigger, outcomeMessage, outcomeOf,
  parseWebhook, verifySignature, type CommentEvent, type SendOutcome,
} from './comment-reply';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const iso = (ms: number) => new Date(ms).toISOString();

export class ReplyError extends Error {
  constructor(readonly outcome: SendOutcome, readonly code: number | null = null, readonly subcode: number | null = null) { super(outcome); }
}

async function graphCall(fetcher: Fetcher, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Row> {
  let res: Response; let raw: string;
  try {
    res = await fetcher(`${GRAPH}${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    raw = await res.text();
  } catch { throw new ReplyError('retry'); }
  let json: Row | null = null;
  try { const parsed: unknown = JSON.parse(raw.replace(/("(?:id|message_id|recipient_id)"\s*:\s*)(\d{15,})/g, '$1"$2"')); json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : null; } catch { json = null; }
  const error = json?.['error'] && typeof json['error'] === 'object' ? (json['error'] as Row) : null;
  if (error || !res.ok || !json) {
    const code = typeof error?.['code'] === 'number' ? error['code'] : null; const subcode = typeof error?.['error_subcode'] === 'number' ? error['error_subcode'] : null;
    throw new ReplyError(outcomeOf({ code, subcode, status: res.status }), code, subcode);
  }
  return json;
}

type PrivateReplyInput =
  | { pageAccessToken: string; pageId: string; commentId: string; text: string }
  // Legacy call shape remains accepted at the type boundary so older tests/callers still compile.
  // It is deliberately rejected at runtime: the system-user token is not a substitute for a Page Access Token.
  | { pageAccessToken?: never; token: string; pageId: string | null; igUserId: string; commentId: string; text: string };

/** Sends a private reply using the Page ID and its Page Access Token, as required by Meta's Facebook Login flow. */
export async function sendPrivateReply(fetcher: Fetcher, p: PrivateReplyInput): Promise<{ messageId: string | null }> {
  const pageAccessToken = 'pageAccessToken' in p ? p.pageAccessToken : null;
  if (!p.pageId || !pageAccessToken) throw new ReplyError('permission');
  const json = await graphCall(fetcher, 'POST', `/${encodeURIComponent(p.pageId)}/messages`, pageAccessToken, {
    recipient: { comment_id: p.commentId },
    message: { text: p.text },
  });
  return { messageId: str(json['message_id']) || null };
}

type Settings = { enabled: boolean; template: string; lastMessage: string | null; lastEventAt: string | null };
async function settingsOf(db: Db, userId: string): Promise<Settings | null> {
  const { data } = await db.from('comment_reply_settings').select('enabled,template,last_message,last_event_at').eq('user_id', userId).maybeSingle();
  const row = data as Row | null;
  if (!row) return null;
  return { enabled: row['enabled'] === true, template: str(row['template']) || DEFAULT_TEMPLATE, lastMessage: str(row['last_message']) || null, lastEventAt: str(row['last_event_at']) || null };
}
const note = (db: Db, userId: string, message: string) => db.from('comment_reply_settings').update({ last_message: message }).eq('user_id', userId);

type Account = { id: string; userId: string; pageId: string | null };
async function accountByInstagramId(db: Db, igUserId: string): Promise<Account | null> {
  const { data } = await db.from('instagram_accounts').select('id,user_id,page_id').eq('ig_user_id', igUserId).limit(1).maybeSingle();
  const row = data as Row | null;
  return row ? { id: str(row['id']), userId: str(row['user_id']), pageId: str(row['page_id']) || null } : null;
}

/** Keeps only the comments worth answering (on a published post that asks for the trigger, from someone else) and queues them. Returns how many were queued. */
export async function ingestEvents(db: Db, events: readonly CommentEvent[], p: { now?: () => number } = {}): Promise<number> {
  const now = p.now ?? Date.now; let queued = 0;
  const accounts = new Map<string, Account | null>(); const settings = new Map<string, Settings | null>();
  for (const event of events) {
    if (!accounts.has(event.igUserId)) accounts.set(event.igUserId, await accountByInstagramId(db, event.igUserId));
    const account = accounts.get(event.igUserId);
    if (!account) continue;
    if (!settings.has(account.userId)) settings.set(account.userId, await settingsOf(db, account.userId));
    if (!settings.get(account.userId)?.enabled) continue;
    if (event.fromId === event.igUserId) continue;
    const { data: found } = await db.from('posts').select('id,trigger_word').eq('user_id', account.userId).eq('ig_media_id', event.mediaId).eq('status', 'published').maybeSingle();
    const post = found as Row | null;
    if (!post) continue;
    if (!matchesTrigger(event.text, str(post['trigger_word']) || DEFAULT_TRIGGER)) continue;
    const inserted = await db.from('comment_events').insert({
      user_id: account.userId, post_id: str(post['id']), comment_id: event.commentId, author_id: event.fromId, author_username: event.username, status: 'detected', attempts: 0, commented_at: iso(now()),
    });
    if (!inserted.error) queued++;
  }
  return queued;
}

export type SendResult = { sent: number; failed: number; waiting: number; skipped: number };
/** Sends the queued private replies, a few at a time and never faster than the pace set. A reply that cannot go out yet stays in the queue. */
export async function sendPending(db: Db, p: { masterKey: string; fetcher?: Fetcher; now?: () => number; limit?: number; sleep?: (ms: number) => Promise<void> }): Promise<SendResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now; const sleep = p.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const result: SendResult = { sent: 0, failed: 0, waiting: 0, skipped: 0 };
  await db.from('comment_events').update({ status: 'detected' }).eq('status', 'sending').lt('updated_at', iso(now() - STALE_SENDING_MS));
  const { data } = await db.from('comment_events').select('id,user_id,post_id,comment_id,attempts,commented_at').eq('status', 'detected').order('created_at', { ascending: true }).limit(20);
  const stopped = new Set<string>(); let handled = 0;

  for (const row of (data ?? []) as Row[]) {
    if (handled >= (p.limit ?? 5)) { result.waiting++; continue; }
    const id = str(row['id']); const userId = str(row['user_id']); const attempts = Number(row['attempts'] ?? 0);
    if (stopped.has(userId)) { result.waiting++; continue; }
    const finish = (status: string, error: string | null, extra: Row = {}) => db.from('comment_events').update({ status, error, ...extra }).eq('id', id).eq('user_id', userId);
    const release = (error: string | null, back: number) => db.from('comment_events').update({ status: 'detected', error, attempts: Math.max(0, attempts + 1 - back) }).eq('id', id).eq('user_id', userId);

    const claim = await db.from('comment_events').update({ status: 'sending', attempts: attempts + 1 }).eq('id', id).eq('status', 'detected').eq('attempts', attempts).select('id');
    if (!claim.data?.length) continue;
    const commentedMs = Date.parse(str(row['commented_at']));
    if (!Number.isNaN(commentedMs) && now() - commentedMs > REPLY_WINDOW_MS) { await finish('expired', outcomeMessage('expired')); result.skipped++; continue; }
    const settings = await settingsOf(db, userId);
    if (!settings?.enabled) { await finish('skipped', 'A resposta automática foi desligada.'); result.skipped++; continue; }
    const { data: post } = await db.from('posts').select('affiliate_link').eq('id', str(row['post_id'])).eq('user_id', userId).maybeSingle();
    const link = str((post as Row | null)?.['affiliate_link']);
    if (!link) { await finish('failed', 'A publicação não tem link de afiliado para enviar.'); result.failed++; continue; }

    const { count: lastHour } = await db.from('comment_events').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'sent').gte('sent_at', iso(now() - 3_600_000));
    if ((lastHour ?? 0) >= MAX_DMS_PER_HOUR) { await release(null, 1); stopped.add(userId); result.waiting++; continue; }
    const { data: pace } = await db.rpc('reserve_connector_slot', { p_scope: `dm:${userId}`, p_interval_ms: SEND_PACE_MS });
    if (typeof pace === 'number' && pace > 0) await sleep(Math.min(pace, 3000));

    let credentials: Awaited<ReturnType<typeof getPublishingToken>> = null;
    try { credentials = await getPublishingToken(db as never, userId, p.masterKey, now()); } catch (error) { if (!(error instanceof InstagramError)) throw error; }
    if (!credentials) {
      await db.from('instagram_accounts').update({ status: 'expired' }).eq('user_id', userId);
      await note(db, userId, outcomeMessage('auth')); await release(outcomeMessage('auth'), 1); stopped.add(userId); result.waiting++; continue;
    }
    handled++;
    try {
      if (!credentials.pageId || !credentials.pageAccessToken || !credentials.pageTasks?.includes('MESSAGING')) {
        throw new ReplyError('permission');
      }
      const sent = await sendPrivateReply(fetcher, {
        pageAccessToken: credentials.pageAccessToken,
        pageId: credentials.pageId,
        commentId: str(row['comment_id']),
        text: buildDm(settings.template, link),
      });
      await finish('sent', null, { sent_at: iso(now()), message_id: sent.messageId });
      await db.from('comment_reply_settings').update({ last_event_at: iso(now()), last_message: null }).eq('user_id', userId);
      await db.from('activity_log').insert({ user_id: userId, action: 'Link enviado por mensagem', result: 'Resposta privada a um comentário', details: { post_id: str(row['post_id']) } });
      result.sent++;
    } catch (error) {
      if (!(error instanceof ReplyError)) throw error;
      const message = outcomeMessage(error.outcome);
      if (error.outcome === 'already') { await finish('skipped', message); result.skipped++; }
      else if (error.outcome === 'expired') { await finish('expired', message); result.skipped++; }
      else if (error.outcome === 'blocked' || error.outcome === 'invalid') { await finish('failed', message); result.failed++; }
      else if (error.outcome === 'auth') {
        await db.from('instagram_accounts').update({ status: 'expired' }).eq('user_id', userId);
        await note(db, userId, message); await release(message, 1); stopped.add(userId); result.waiting++;
      } else {
        if (error.outcome === 'permission') await note(db, userId, message);
        if (attempts + 1 >= MAX_SEND_ATTEMPTS) { await finish('failed', message); result.failed++; } else { await release(message, 0); result.waiting++; }
      }
    }
  }
  return result;
}

export type WebhookRequest = { method: string; query: URLSearchParams; signature: string | null; rawBody: string; verifyToken: string | undefined; masterKey: string; fetcher?: Fetcher; now?: () => number; sleep?: (ms: number) => Promise<void> };
/** The whole webhook: answers Meta's subscription check, refuses notifications that are not signed by the account's app, queues the comments and sends what it can right away. */
export async function handleWebhookRequest(db: Db, req: WebhookRequest): Promise<{ status: number; body: string }> {
  if (req.method === 'GET') {
    const token = req.query.get('hub.verify_token'); const challenge = req.query.get('hub.challenge');
    if (req.query.get('hub.mode') === 'subscribe' && req.verifyToken && token === req.verifyToken && challenge) return { status: 200, body: challenge };
    return { status: 403, body: 'Forbidden' };
  }
  if (req.method !== 'POST') return { status: 405, body: 'Method not allowed' };
  let parsed: unknown;
  try { parsed = JSON.parse(req.rawBody); } catch { return { status: 400, body: 'Bad request' }; }
  const events = parseWebhook(parsed);
  if (!events.length) return { status: 200, body: 'ok' };

  const verified: CommentEvent[] = [];
  for (const igUserId of [...new Set(events.map(event => event.igUserId))]) {
    const account = await accountByInstagramId(db, igUserId);
    if (!account) continue;
    const app = await loadAppCredentials(db as never, account.userId, req.masterKey).catch(() => null);
    if (!app) continue;
    if (!(await verifySignature(req.rawBody, req.signature, app.appSecret))) return { status: 401, body: 'Invalid signature' };
    verified.push(...events.filter(event => event.igUserId === igUserId));
  }
  if (verified.length) {
    await ingestEvents(db, verified, { ...(req.now ? { now: req.now } : {}) });
    await sendPending(db, { masterKey: req.masterKey, ...(req.fetcher ? { fetcher: req.fetcher } : {}), ...(req.now ? { now: req.now } : {}), ...(req.sleep ? { sleep: req.sleep } : {}), limit: 3 });
  }
  return { status: 200, body: 'ok' };
}

export type ReplyView = {
  enabled: boolean; template: string; lastMessage: string | null; lastEventAt: string | null; webhookPath: string;
  counts: { sent: number; waiting: number; failed: number };
  recent: { id: string; username: string | null; status: string; error: string | null; at: string }[];
};
export async function loadReplyView(db: Db, userId: string): Promise<ReplyView> {
  const settings = await settingsOf(db, userId);
  const { data } = await db.from('comment_events').select('id,author_username,status,error,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(30);
  const rows = (data ?? []) as Row[];
  const count = (...statuses: string[]) => rows.filter(row => statuses.includes(str(row['status']))).length;
  return {
    enabled: settings?.enabled ?? false, template: settings?.template ?? DEFAULT_TEMPLATE, lastMessage: settings?.lastMessage ?? null, lastEventAt: settings?.lastEventAt ?? null, webhookPath: WEBHOOK_PATH,
    counts: { sent: count('sent'), waiting: count('detected', 'sending'), failed: count('failed') },
    recent: rows.slice(0, 10).map(row => ({ id: str(row['id']), username: str(row['author_username']) || null, status: str(row['status']), error: str(row['error']) || null, at: str(row['created_at']) })),
  };
}

export async function saveReplySettings(db: Db, userId: string, p: { enabled: boolean; template: string }): Promise<boolean> {
  const saved = await db.from('comment_reply_settings').upsert({ user_id: userId, enabled: p.enabled, template: p.template, ...(p.enabled ? {} : { last_message: null }) }, { onConflict: 'user_id' });
  return !saved.error;
}

export type SetupCheck = {
  permissions: { granted: string[]; missing: string[]; ok: boolean };
  subscription: { ok: boolean; fields: string[] } | null;
};
const PAGE_MANAGEMENT_TASKS = ['CREATE_CONTENT', 'MANAGE', 'MODERATE'];
/** Reads the required permission grants, Page tasks and the app's Page webhook subscription. */
export async function checkReplySetup(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number }): Promise<SetupCheck> {
  const fetcher = p.fetcher ?? fetch;
  const credentials = await getPublishingToken(db as never, p.userId, p.masterKey, (p.now ?? Date.now)());
  if (!credentials) throw new ReplyError('auth');

  const granted = await fetchGrantedPermissions(fetcher, credentials.token);
  const missing: string[] = REQUIRED_REPLY_PERMISSIONS.filter(permission => !granted.includes(permission));
  if (!credentials.pageId) missing.push('page_id');
  if (!credentials.pageAccessToken) missing.push('page_access_token');
  if (!credentials.pageTasks?.includes('MESSAGING')) missing.push('tarefa_MESSAGING');
  const canManagePageSubscriptions = (credentials.pageTasks ?? []).some(task => PAGE_MANAGEMENT_TASKS.includes(task));
  if (!canManagePageSubscriptions) missing.push('tarefa_CREATE_CONTENT_MANAGE_ou_MODERATE');

  let subscription: SetupCheck['subscription'] = null;
  if (credentials.pageId && credentials.pageAccessToken) {
    try {
      const json = await graphCall(fetcher, 'GET', `/${encodeURIComponent(credentials.pageId)}/subscribed_apps`, credentials.pageAccessToken);
      const apps = Array.isArray(json['data']) ? (json['data'] as unknown[]) : [];
      const ownApp = apps.find(app => app && typeof app === 'object' && str((app as Row)['id']) === META_APP_ID) as Row | undefined;
      const fields = ownApp && Array.isArray(ownApp['subscribed_fields']) ? (ownApp['subscribed_fields'] as unknown[]).map(String) : [];
      subscription = { ok: Boolean(ownApp) && fields.includes('feed'), fields };
    } catch { subscription = null; }
  }
  return {
    permissions: { granted: granted.filter(permission => REQUIRED_REPLY_PERMISSIONS.includes(permission as typeof REQUIRED_REPLY_PERMISSIONS[number])), missing, ok: missing.length === 0 },
    subscription,
  };
}

/** Installs the app on the connected Facebook Page for the Page feed webhook; Instagram comments are subscribed in the app dashboard. */
export async function subscribeComments(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const credentials = await getPublishingToken(db as never, p.userId, p.masterKey, (p.now ?? Date.now)());
  if (!credentials) throw new ReplyError('auth');
  const canManagePageSubscriptions = (credentials.pageTasks ?? []).some(task => PAGE_MANAGEMENT_TASKS.includes(task));
  if (!credentials.pageId || !credentials.pageAccessToken || !canManagePageSubscriptions) throw new ReplyError('permission');
  await graphCall(p.fetcher ?? fetch, 'POST', `/${encodeURIComponent(credentials.pageId)}/subscribed_apps?subscribed_fields=feed`, credentials.pageAccessToken, {});
}
