// Server-only: the automation. On every visit of the scheduler it decides, for each user who turned it on, whether the next Reels of the day
// should be ordered now, and whether a published Reels is due for its Story. It spends money only through the guarded paths that already exist
// (the Claude and Higgsfield monthly caps, the limit of videos at once) and it backs off after an error, so a problem can never burn money every minute.
import type { SupabaseClient } from '@supabase/supabase-js';
import { aiErrorMessage } from './ai.server';
import { BrainError } from './content-brain.server';
import { HiggsfieldError } from './higgsfield.server';
import { higgsfieldErrorMessage } from './higgsfield';
import { dayBounds, DEFAULT_PUBLISH_SETTINGS, effectiveDailyLimit, type PublishSettings } from './publishing';
import { formatInZone } from './posts';
import {
  DEFAULT_AUTOMATION_SETTINGS, MAX_FAILED_PER_DAY, MAX_PENDING_APPROVAL, RETRY_BACKOFF_MS, STORY_LOOKBACK_MS, decideOrder, reelsPerDay, slotTimes, storyTime, windowOfDay,
  type AutomationMode, type AutomationSettings,
} from './automation';
import { startVideoDraft } from './video-brain.server';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
export type MakeLink = (productUrl: string, subIds: string[]) => Promise<string | null>;
export type PlanOutcome = { created: boolean; reason: string; postId?: string };
export type AutomationConfig = { enabled: boolean; mode: AutomationMode; storyAfterReel: boolean; message: string | null; retryAfterMs: number | null };

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const iso = (ms: number) => new Date(ms).toISOString();

export async function configOf(db: Db, userId: string): Promise<AutomationConfig | null> {
  const { data } = await db.from('automation_settings').select('enabled,mode,story_after_reel,last_message,retry_after').eq('user_id', userId).maybeSingle();
  const row = data as Row | null;
  if (!row) return null;
  const retry = Date.parse(str(row['retry_after']));
  return { enabled: row['enabled'] === true, mode: row['mode'] === 'auto' ? 'auto' : 'approval', storyAfterReel: row['story_after_reel'] !== false, message: str(row['last_message']) || null, retryAfterMs: Number.isNaN(retry) ? null : retry };
}

async function settingsOf(db: Db, userId: string): Promise<{ automation: AutomationSettings; publish: PublishSettings }> {
  const { data } = await db.from('settings').select('timezone,products_per_day,daily_post_limit,window_start,window_end,story_delay_min_hours,story_delay_max_hours,repeat_days,warmup_initial_days,warmup_initial_limit,warmup_second_end_day,warmup_second_limit').eq('user_id', userId).maybeSingle();
  const row = (data ?? {}) as Row;
  const pick = <T extends object>(defaults: T): T => {
    const merged = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults)) if (row[key] !== undefined && row[key] !== null) merged[key] = row[key];
    return merged as T;
  };
  return { automation: pick(DEFAULT_AUTOMATION_SETTINGS), publish: pick(DEFAULT_PUBLISH_SETTINGS) };
}

/** Saves the status line shown on the screen, and (when given) the time before which no new try is made. Only writes when something changed. */
async function remember(db: Db, userId: string, config: AutomationConfig, message: string, retryAfterMs?: number | null) {
  const retryChanged = retryAfterMs !== undefined && retryAfterMs !== config.retryAfterMs;
  if (message === config.message && !retryChanged) return;
  await db.from('automation_settings').update({ last_message: message, ...(retryAfterMs !== undefined ? { retry_after: retryAfterMs === null ? null : iso(retryAfterMs) } : {}) }).eq('user_id', userId);
}
function explain(error: unknown): string {
  if (error instanceof BrainError) return error.message;
  const aiMessage = aiErrorMessage(error);
  if (aiMessage) return aiMessage;
  if (error instanceof HiggsfieldError) return higgsfieldErrorMessage(error.kind, error.detail);
  return 'Aconteceu um problema inesperado.';
}
const clock = (ms: number, timeZone: string) => formatInZone(iso(ms), timeZone).split(' ').pop() ?? '';

/** Decides whether the next Reels of the day is ordered now and, if so, orders it. `force` is the "create the next one now" button: it ignores the clock only. */
export async function planNextForUser(db: Db, p: { userId: string; masterKey: string; force?: boolean; fetcher?: Fetcher; now?: () => number; makeLink?: MakeLink }): Promise<PlanOutcome> {
  const now = p.now ?? Date.now; const at = now();
  const config = await configOf(db, p.userId);
  if (!config || !config.enabled) return { created: false, reason: 'disabled' };
  if (!p.force && config.retryAfterMs !== null && at < config.retryAfterMs) return { created: false, reason: 'backoff' };
  const { automation, publish } = await settingsOf(db, p.userId);
  const { data: account } = await db.from('instagram_accounts').select('id,daily_limit,warmup_started_at').eq('user_id', p.userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!account) { await remember(db, p.userId, config, 'Conecte o Instagram na tela Conexões para a automação funcionar.'); return { created: false, reason: 'no-account' }; }
  const accountRow = account as Row;
  const limit = effectiveDailyLimit(publish, typeof accountRow['daily_limit'] === 'number' ? accountRow['daily_limit'] : null, str(accountRow['warmup_started_at']) || null, at);
  const target = reelsPerDay(automation.products_per_day, limit, config.storyAfterReel);
  const bounds = dayBounds(at, automation.timezone);
  if (!bounds) return { created: false, reason: 'clock' };

  const [today, waiting] = await Promise.all([
    db.from('posts').select('id,status').eq('user_id', p.userId).eq('source', 'auto').eq('format', 'reel').gte('created_at', bounds.start).lt('created_at', bounds.end),
    db.from('posts').select('id').eq('user_id', p.userId).eq('source', 'auto').eq('format', 'reel').in('status', ['draft', 'rendering']),
  ]);
  const todays = (today.data ?? []) as Row[];
  const failed = todays.filter(row => str(row['status']) === 'failed').length;
  const made = todays.filter(row => !['failed', 'canceled'].includes(str(row['status']))).length;
  if (failed >= MAX_FAILED_PER_DAY) { await remember(db, p.userId, config, `A automação descansa até amanhã: ${failed} vídeos falharam hoje. Veja o Histórico.`); return { created: false, reason: 'failures' }; }
  const pending = ((waiting.data ?? []) as Row[]).length;
  if (config.mode === 'approval' && pending >= MAX_PENDING_APPROVAL) {
    await remember(db, p.userId, config, `Aguardando a sua aprovação: ${pending} vídeos prontos ou em criação. A automação espera você aprovar ou cancelar.`);
    return { created: false, reason: 'pending' };
  }

  const window = windowOfDay(at, automation.timezone, automation.window_start, automation.window_end);
  const slots = slotTimes(window, target, `${p.userId}:${bounds.start}`);
  const decision = decideOrder({ nowMs: at, made, target, slots, window, force: p.force === true });
  if (!decision.order) {
    const progress = `Hoje: ${made} de ${target} Reels criados.`;
    const message = decision.reason === 'done' ? `${progress} A automação continua amanhã.`
      : decision.reason === 'too-late' ? `${progress} Já é tarde para outro; a automação continua amanhã.`
      : `${progress} O próximo será pedido por volta de ${clock((slots[made] ?? window.endMs) - 25 * 60_000, automation.timezone)}.`;
    await remember(db, p.userId, config, message);
    return { created: false, reason: decision.reason };
  }

  // Only one visit may order at a time: the second of two overlapping visits finds the slot taken and waits for the next minute.
  const { data: wait } = await db.rpc('reserve_connector_slot', { p_scope: `auto-plan:${p.userId}`, p_interval_ms: 50_000 });
  if (typeof wait === 'number' && wait > 0) return { created: false, reason: 'busy' };
  try {
    const draft = await startVideoDraft(db, { userId: p.userId, masterKey: p.masterKey, format: 'reel', now, ...(p.fetcher ? { fetcher: p.fetcher } : {}), ...(p.makeLink ? { makeLink: p.makeLink } : {}), auto: { mode: config.mode, scheduledAt: iso(decision.slotMs) } });
    await remember(db, p.userId, config, `Reels criado para "${draft.productTitle.slice(0, 50)}" (${made + 1} de ${target} hoje).`, null);
    await db.from('automation_settings').update({ last_run_at: iso(at) }).eq('user_id', p.userId);
    return { created: true, reason: 'created', postId: draft.postId };
  } catch (error) {
    const message = explain(error);
    await remember(db, p.userId, config, `A última tentativa não deu certo: ${message} Nova tentativa em 15 minutos.`, at + RETRY_BACKOFF_MS);
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Automação não conseguiu criar o Reels', result: message, details: {} });
    return { created: false, reason: 'error' };
  }
}

/** A UUID that is always the same for the same text, so a Story can never be created twice for the same Reels (the database refuses a repeated key). */
export async function deterministicUuid(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Creates the Story of each published Reels (the same video, a few hours later, inside the posting window). Returns how many were created. */
export async function createStoriesForUser(db: Db, p: { userId: string; now?: () => number }): Promise<number> {
  const now = p.now ?? Date.now; const at = now();
  const config = await configOf(db, p.userId);
  if (!config || !config.enabled || !config.storyAfterReel) return 0;
  const { automation } = await settingsOf(db, p.userId);
  const { data: reels } = await db.from('posts').select('id,instagram_account_id,product_id,published_at').eq('user_id', p.userId).eq('source', 'auto').eq('format', 'reel').eq('status', 'published').gte('published_at', iso(at - STORY_LOOKBACK_MS)).order('published_at', { ascending: true }).limit(10);
  const list = (reels ?? []) as Row[];
  if (!list.length) return 0;
  const { data: children } = await db.from('posts').select('parent_post_id').eq('user_id', p.userId).in('parent_post_id', list.map(row => str(row['id'])));
  const has = new Set(((children ?? []) as Row[]).map(row => str(row['parent_post_id'])));
  let created = 0;
  for (const reel of list) {
    const reelId = str(reel['id']);
    if (has.has(reelId)) continue;
    const { data: link } = await db.from('post_media').select('asset_id').eq('post_id', reelId).eq('user_id', p.userId).order('position', { ascending: true }).limit(1).maybeSingle();
    const assetId = str((link as Row | null)?.['asset_id']);
    const publishedMs = Date.parse(str(reel['published_at']));
    if (!assetId || Number.isNaN(publishedMs)) continue;
    const storyId = crypto.randomUUID();
    const when = storyTime({ publishedMs, nowMs: at, settings: automation, seed: reelId });
    const inserted = await db.from('posts').insert({
      id: storyId, user_id: p.userId, instagram_account_id: str(reel['instagram_account_id']), product_id: str(reel['product_id']), format: 'story', status: 'scheduled', scheduled_at: iso(when),
      caption: null, trigger_word: null, affiliate_link: null, video_asset_id: assetId, parent_post_id: reelId, source: 'auto', idempotency_key: await deterministicUuid(`story:${reelId}`),
      ai_plan: { fromReel: reelId, reason: 'Story do mesmo vídeo do Reels, algumas horas depois.', angle: 'Reforço do Reels', hook: '', linkMissing: false },
    });
    if (inserted.error) continue; // already created by another visit, or nothing to do
    const media = await db.from('post_media').insert({ user_id: p.userId, post_id: storyId, asset_id: assetId, position: 0 });
    if (media.error) { await db.from('posts').delete().eq('id', storyId).eq('user_id', p.userId); continue; }
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Story agendado pela automação', result: 'Story do mesmo vídeo do Reels', details: { post_id: storyId, reel_id: reelId, scheduled_at: iso(when) } });
    created++;
  }
  return created;
}

export type AutomationRun = { users: number; reels: number; stories: number };
/** One visit of the scheduler: for every user with the automation on, creates the due Stories and orders the next Reels if it is time. */
export async function runAutomation(db: Db, p: { masterKey: string; fetcher?: Fetcher; now?: () => number; makeLinkFor?: (userId: string) => MakeLink }): Promise<AutomationRun> {
  const result: AutomationRun = { users: 0, reels: 0, stories: 0 };
  const { data } = await db.from('automation_settings').select('user_id').eq('enabled', true).limit(10);
  for (const row of (data ?? []) as Row[]) {
    const userId = str(row['user_id']);
    result.users++;
    try {
      result.stories += await createStoriesForUser(db, { userId, ...(p.now ? { now: p.now } : {}) });
      const outcome = await planNextForUser(db, { userId, masterKey: p.masterKey, ...(p.fetcher ? { fetcher: p.fetcher } : {}), ...(p.now ? { now: p.now } : {}), ...(p.makeLinkFor ? { makeLink: p.makeLinkFor(userId) } : {}) });
      if (outcome.created) result.reels++;
    } catch { /* one user's problem never stops the others */ }
  }
  return result;
}

export type AutomationView = { enabled: boolean; mode: AutomationMode; storyAfterReel: boolean; message: string | null; madeToday: number; targetToday: number; pending: number };
/** What the screen shows: the switches, the status line and today's progress. */
export async function loadAutomationView(db: Db, userId: string, nowMs: number): Promise<AutomationView> {
  const config = await configOf(db, userId);
  const { automation, publish } = await settingsOf(db, userId);
  const bounds = dayBounds(nowMs, automation.timezone);
  const [today, waiting, account] = await Promise.all([
    bounds ? db.from('posts').select('id,status').eq('user_id', userId).eq('source', 'auto').eq('format', 'reel').gte('created_at', bounds.start).lt('created_at', bounds.end) : Promise.resolve({ data: [] as Row[] }),
    db.from('posts').select('id').eq('user_id', userId).eq('source', 'auto').eq('format', 'reel').in('status', ['draft', 'rendering']),
    db.from('instagram_accounts').select('daily_limit,warmup_started_at').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle(),
  ]);
  const accountRow = (account.data ?? {}) as Row;
  const limit = effectiveDailyLimit(publish, typeof accountRow['daily_limit'] === 'number' ? accountRow['daily_limit'] : null, str(accountRow['warmup_started_at']) || null, nowMs);
  const made = ((today.data ?? []) as Row[]).filter(row => !['failed', 'canceled'].includes(str(row['status']))).length;
  return {
    enabled: config?.enabled ?? false, mode: config?.mode ?? 'approval', storyAfterReel: config?.storyAfterReel ?? true, message: config?.message ?? null,
    madeToday: made, targetToday: reelsPerDay(automation.products_per_day, limit, config?.storyAfterReel ?? true), pending: ((waiting.data ?? []) as Row[]).length,
  };
}