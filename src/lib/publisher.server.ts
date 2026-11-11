// Server-only: the publisher. The scheduler visits once a minute; each visit moves every publication one small step forward,
// so no single visit has to wait for Instagram to process a video (the scheduler gives up after about 30 seconds).
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPublishingToken } from './instagram.server';
import {
  PublishError, containerStatus, createCarouselContainer, publishContainer, startPublishing, type PublishItem, type PublishState,
} from './instagram-publish.server';
import { FORMAT_LABELS, MEDIA_BUCKET, validateMedia, type PostFormat } from './posts';
import {
  DEFAULT_PUBLISH_SETTINGS, HEARTBEAT_SCOPE, MAX_PUBLISH_TRIES, STUCK_AFTER_MS, dayBounds, effectiveDailyLimit, failureMessage, nextDayWindowStart, retryDelayMs, type PublishSettings,
} from './publishing';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Post = { id: string; user_id: string; instagram_account_id: string; format: string; status: string; scheduled_at: string | null; caption: string; attempts: number; error: string | null; publish_state: unknown; updated_at: string };
type Account = { id: string; status: string; daily_limit: number | null; warmup_started_at: string | null };
export type TickResult = { checked: number; started: number; published: number; waiting: number; limited: number; retried: number; failed: number; paused: number };

const COLUMNS = 'id,user_id,instagram_account_id,format,status,scheduled_at,caption,attempts,error,publish_state,updated_at';
const iso = (ms: number) => new Date(ms).toISOString();
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const toPost = (row: Row): Post => ({
  id: str(row['id']), user_id: str(row['user_id']), instagram_account_id: str(row['instagram_account_id']), format: str(row['format']), status: str(row['status']),
  scheduled_at: typeof row['scheduled_at'] === 'string' ? row['scheduled_at'] : null, caption: str(row['caption']), attempts: Number(row['attempts'] ?? 0),
  error: typeof row['error'] === 'string' ? row['error'] : null, publish_state: row['publish_state'], updated_at: str(row['updated_at']),
});
function parseState(value: unknown): PublishState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s['startedAt'] !== 'number') return null;
  if (s['phase'] === 'container' && typeof s['containerId'] === 'string') return { phase: 'container', containerId: s['containerId'], startedAt: s['startedAt'], ...(typeof s['publishTries'] === 'number' ? { publishTries: s['publishTries'] } : {}) };
  if (s['phase'] === 'children' && Array.isArray(s['children']) && s['children'].every(id => typeof id === 'string')) return { phase: 'children', children: s['children'] as string[], startedAt: s['startedAt'] };
  return null;
}

export async function runPublishTick(db: Db, options: { masterKey: string; fetcher?: typeof fetch; now?: () => number; budgetMs?: number }): Promise<TickResult> {
  const fetcher = options.fetcher ?? fetch; const now = options.now ?? Date.now; const began = now();
  const result: TickResult = { checked: 0, started: 0, published: 0, waiting: 0, limited: 0, retried: 0, failed: 0, paused: 0 };
  const hasTime = () => now() - began < (options.budgetMs ?? 20_000);
  const log = (post: Post, action: string, text: string, details: Record<string, unknown> = {}) => db.from('activity_log').insert({ user_id: post.user_id, action, result: text, details: { post_id: post.id, ...details } });

  // The "visit" mark lets the Publicações screen warn when the scheduler stops coming.
  await db.from('connector_runtime').upsert({ scope: HEARTBEAT_SCOPE, next_allowed_at: iso(began), interval_ms: 60_000 }, { onConflict: 'scope' });

  const settingsCache = new Map<string, PublishSettings>(); const accountCache = new Map<string, Account | null>();
  async function settingsOf(userId: string): Promise<PublishSettings> {
    const cached = settingsCache.get(userId); if (cached) return cached;
    const { data } = await db.from('settings').select('timezone,daily_post_limit,min_interval_minutes,max_attempts,window_start,warmup_initial_days,warmup_initial_limit,warmup_second_end_day,warmup_second_limit').eq('user_id', userId).maybeSingle();
    const row = (data ?? {}) as Partial<Record<keyof PublishSettings, unknown>>;
    const merged = { ...DEFAULT_PUBLISH_SETTINGS } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_PUBLISH_SETTINGS)) if (row[key as keyof PublishSettings] !== undefined && row[key as keyof PublishSettings] !== null) merged[key] = row[key as keyof PublishSettings];
    const settings = merged as PublishSettings; settingsCache.set(userId, settings); return settings;
  }
  async function accountOf(post: Post): Promise<Account | null> {
    const key = `${post.user_id}:${post.instagram_account_id}`;
    if (accountCache.has(key)) return accountCache.get(key) ?? null;
    const { data } = await db.from('instagram_accounts').select('id,status,daily_limit,warmup_started_at').eq('id', post.instagram_account_id).eq('user_id', post.user_id).maybeSingle();
    const row = data as Row | null;
    const account = row ? { id: str(row['id']), status: str(row['status']), daily_limit: typeof row['daily_limit'] === 'number' ? row['daily_limit'] : null, warmup_started_at: typeof row['warmup_started_at'] === 'string' ? row['warmup_started_at'] : null } : null;
    accountCache.set(key, account); return account;
  }
  const note = async (post: Post, message: string) => {
    if (post.error === message) return;
    post.error = message;
    await db.from('posts').update({ error: message }).eq('id', post.id).eq('user_id', post.user_id);
  };
  async function tokenOf(post: Post) {
    const token = await getPublishingToken(db as never, post.user_id, options.masterKey, now()).catch(() => null);
    if (!token) throw new PublishError('auth');
    return token;
  }
  async function itemsOf(post: Post): Promise<PublishItem[] | null> {
    const links = await db.from('post_media').select('asset_id,position').eq('post_id', post.id).eq('user_id', post.user_id).order('position', { ascending: true });
    const ordered = ((links.data ?? []) as Row[]).map(row => str(row['asset_id']));
    if (!ordered.length) return null;
    const assets = await db.from('video_assets').select('id,storage_path,media_type').in('id', ordered).eq('user_id', post.user_id);
    const byId = new Map(((assets.data ?? []) as Row[]).map(row => [str(row['id']), row]));
    const items: PublishItem[] = [];
    for (const id of ordered) {
      const asset = byId.get(id); const path = asset ? str(asset['storage_path']) : '';
      if (!asset || !path) return null;
      items.push({ url: db.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl, kind: str(asset['media_type']) === 'video' ? 'video' : 'image' });
    }
    return items;
  }

  async function succeed(post: Post, mediaId: string | null) {
    await db.from('posts').update({ status: 'published', published_at: iso(now()), ig_media_id: mediaId, publish_state: null, error: null }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'publishing');
    await log(post, 'Publicação enviada', `${FORMAT_LABELS[post.format as PostFormat] ?? post.format} publicada no Instagram`, { ig_media_id: mediaId });
    result.published++;
  }
  /** A failed step: pause when the connection is gone, try again a few times, then give up. Attempts are counted only when a new try starts. */
  async function fail(post: Post, error: unknown) {
    const problem = error instanceof PublishError ? error : new PublishError('meta', 'erro inesperado');
    const message = failureMessage(problem.kind, problem.detail);
    const settings = await settingsOf(post.user_id);
    if (problem.kind === 'auth') {
      await db.from('instagram_accounts').update({ status: 'expired' }).eq('id', post.instagram_account_id).eq('user_id', post.user_id);
      accountCache.delete(`${post.user_id}:${post.instagram_account_id}`);
      await db.from('posts').update({ status: 'scheduled', attempts: Math.max(0, post.attempts - 1), error: message, publish_state: null }).eq('id', post.id).eq('user_id', post.user_id);
      await log(post, 'Publicações pausadas', 'Conexão do Instagram expirada', { code: problem.code });
      result.paused++; return;
    }
    if (problem.kind === 'invalid' || post.attempts >= settings.max_attempts) {
      await db.from('posts').update({ status: 'failed', error: message, publish_state: null }).eq('id', post.id).eq('user_id', post.user_id);
      await log(post, 'Publicação falhou', message, { attempts: post.attempts, code: problem.code });
      result.failed++; return;
    }
    await db.from('posts').update({ status: 'scheduled', scheduled_at: iso(now() + retryDelayMs(post.attempts)), error: message, publish_state: null }).eq('id', post.id).eq('user_id', post.user_id);
    await log(post, 'Nova tentativa agendada', message, { attempts: post.attempts, code: problem.code });
    result.retried++;
  }

  /** Instagram never confirmed a publish that was tried: give up WITHOUT starting over, and tell the user to look at the profile first. */
  async function failUnconfirmed(post: Post) {
    const message = failureMessage('unconfirmed');
    await db.from('posts').update({ status: 'failed', error: message, publish_state: null }).eq('id', post.id).eq('user_id', post.user_id);
    await log(post, 'Publicação sem confirmação', message, { attempts: post.attempts });
    result.failed++;
  }

  /** A publication that Instagram is already processing: check it and take the next step. */
  async function advance(post: Post) {
    result.checked++;
    const state = parseState(post.publish_state);
    const tooOld = (since: number) => now() - since > STUCK_AFTER_MS;
    if (!state) { if (tooOld(Date.parse(post.updated_at) || 0)) await fail(post, new PublishError('timeout')); return; }
    try {
      const { token, igUserId } = await tokenOf(post);
      const save = (next: PublishState) => db.from('posts').update({ publish_state: next }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'publishing');
      if (state.phase === 'children') {
        const statuses = await Promise.all(state.children.map(id => containerStatus(fetcher, token, id)));
        const bad = statuses.find(s => s.code === 'ERROR' || s.code === 'EXPIRED');
        if (bad) { await fail(post, new PublishError('processing', bad.detail)); return; }
        if (statuses.every(s => s.code === 'FINISHED' || s.code === 'PUBLISHED')) { await save(await createCarouselContainer(fetcher, { token, igUserId, children: state.children, caption: post.caption, startedAt: state.startedAt })); return; }
        if (tooOld(state.startedAt)) await fail(post, new PublishError('timeout'));
        return;
      }
      const status = await containerStatus(fetcher, token, state.containerId);
      const attempted = (state.publishTries ?? 0) > 0;
      if (status.code === 'PUBLISHED') { await succeed(post, null); return; }
      if (status.code === 'FINISHED') {
        const tries = state.publishTries ?? 0;
        if (tries >= MAX_PUBLISH_TRIES) { await failUnconfirmed(post); return; }
        // Written BEFORE the call: from here on, whatever happens, no new container may be created for this publication,
        // because Instagram may already have published it even if its answer never reaches us.
        // The step is claimed only if nobody else touched the post since it was read: if two visits of the scheduler overlap, only one of them publishes.
        const claimed = await db.from('posts').update({ publish_state: { ...state, publishTries: tries + 1 } }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'publishing').eq('updated_at', post.updated_at).select('id');
        if (!claimed.data?.length) return;
        try { await succeed(post, await publishContainer(fetcher, { token, igUserId, containerId: state.containerId })); }
        catch (error) {
          if (error instanceof PublishError && error.kind === 'auth') throw error; // the key was refused, so nothing was published: the normal pause applies
          await note(post, failureMessage('checking')); // the next visit asks Instagram if it went out, and only repeats the publish call if it did not
        }
        return;
      }
      if (status.code === 'ERROR' || status.code === 'EXPIRED') { if (attempted) await failUnconfirmed(post); else await fail(post, new PublishError('processing', status.detail)); return; }
      if (tooOld(state.startedAt)) { if (attempted) await failUnconfirmed(post); else await fail(post, new PublishError('timeout')); }
    } catch (error) {
      // After a publish try, a problem while checking is never a reason to start over: it would publish a second copy.
      if ((state.phase === 'container' && (state.publishTries ?? 0) > 0) && !(error instanceof PublishError && error.kind === 'auth')) {
        if (tooOld(state.startedAt)) await failUnconfirmed(post); else await note(post, failureMessage('checking'));
        return;
      }
      await fail(post, error);
    }
  }

  /** A scheduled publication whose time has come: check the rules, claim it and ask Instagram to receive the files. */
  async function begin(post: Post): Promise<boolean> {
    result.checked++;
    const account = await accountOf(post);
    if (!account || account.status !== 'connected') { await note(post, failureMessage('auth')); result.paused++; return false; }
    const settings = await settingsOf(post.user_id); const at = now();
    const busy = await db.from('posts').select('id', { count: 'exact', head: true }).eq('instagram_account_id', post.instagram_account_id).eq('status', 'publishing').neq('id', post.id);
    if ((busy.count ?? 0) > 0) { result.waiting++; return false; }
    const bounds = dayBounds(at, settings.timezone);
    if (bounds) {
      const today = await db.from('posts').select('id', { count: 'exact', head: true }).eq('instagram_account_id', post.instagram_account_id).eq('status', 'published').gte('published_at', bounds.start).lt('published_at', bounds.end);
      const limit = effectiveDailyLimit(settings, account.daily_limit, account.warmup_started_at, at);
      if ((today.count ?? 0) >= limit) {
        const next = nextDayWindowStart(at, settings.timezone, settings.window_start);
        if (next) {
          await db.from('posts').update({ scheduled_at: next, error: null }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'scheduled');
          await log(post, 'Limite diário atingido', 'Publicação movida para o próximo dia', { limit, next });
          result.limited++; return false;
        }
      }
    }
    const last = await db.from('posts').select('published_at').eq('instagram_account_id', post.instagram_account_id).eq('status', 'published').order('published_at', { ascending: false }).limit(1).maybeSingle();
    const lastAt = Date.parse(str((last.data as Row | null)?.['published_at']));
    if (!Number.isNaN(lastAt) && at - lastAt < settings.min_interval_minutes * 60_000) {
      await note(post, `Aguardando o intervalo mínimo de ${settings.min_interval_minutes} minutos entre publicações.`); result.waiting++; return false;
    }
    const claim = await db.from('posts').update({ status: 'publishing', attempts: post.attempts + 1, error: null, publish_state: null }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'scheduled').eq('attempts', post.attempts).select('id');
    if (!claim.data?.length) return false;
    post.attempts += 1; post.status = 'publishing';
    result.started++;
    try {
      const items = await itemsOf(post);
      const problem = items ? validateMedia(post.format as PostFormat, items.map(item => item.kind)) : 'arquivos não encontrados';
      if (!items || problem) { await fail(post, new PublishError('invalid', problem ?? '')); return true; }
      const { token, igUserId } = await tokenOf(post);
      const state = await startPublishing(fetcher, { token, igUserId, format: post.format as PostFormat, caption: post.caption, items, now: now() });
      await db.from('posts').update({ publish_state: state }).eq('id', post.id).eq('user_id', post.user_id).eq('status', 'publishing');
    } catch (error) { await fail(post, error); }
    return true;
  }

  const inflight = await db.from('posts').select(COLUMNS).eq('status', 'publishing').order('updated_at', { ascending: true }).limit(6);
  for (const row of (inflight.data ?? []) as Row[]) { if (!hasTime()) break; await advance(toPost(row)); }
  const due = await db.from('posts').select(COLUMNS).eq('status', 'scheduled').lte('scheduled_at', iso(began)).order('scheduled_at', { ascending: true }).limit(10);
  let starts = 0;
  for (const row of (due.data ?? []) as Row[]) { if (!hasTime() || starts >= 2) break; if (await begin(toPost(row))) starts++; }
  return result;
}