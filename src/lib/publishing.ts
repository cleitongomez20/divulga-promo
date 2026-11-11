import { zonedTimeToUtcIso } from './posts';

/** The values of the Configurações screen that the publisher needs. Used when a user has no saved settings yet. */
export type PublishSettings = {
  timezone: string; daily_post_limit: number; min_interval_minutes: number; max_attempts: number; window_start: string;
  warmup_initial_days: number; warmup_initial_limit: number; warmup_second_end_day: number; warmup_second_limit: number;
};
export const DEFAULT_PUBLISH_SETTINGS: PublishSettings = {
  timezone: 'America/Sao_Paulo', daily_post_limit: 6, min_interval_minutes: 45, max_attempts: 3, window_start: '08:00',
  warmup_initial_days: 3, warmup_initial_limit: 1, warmup_second_end_day: 7, warmup_second_limit: 2,
};

/** How many times the final "publish" call is repeated for one container when Instagram does not confirm it. A new container is never created after the first try. */
export const MAX_PUBLISH_TRIES = 5;
/** A publication that stays "publishing" this long without finishing is given up on. */
export const STUCK_AFTER_MS = 30 * 60_000;
export const HEARTBEAT_SCOPE = 'publish-heartbeat';
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** Calendar date (YYYY-MM-DD) of an instant in the given time zone. */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}
/** Start and end (UTC instants) of the user's current calendar day. */
export function dayBounds(ms: number, timeZone: string): { start: string; end: string } | null {
  const date = localDate(ms, timeZone);
  const start = zonedTimeToUtcIso(`${date}T00:00`, timeZone);
  const end = zonedTimeToUtcIso(`${addDays(date, 1)}T00:00`, timeZone);
  return start && end ? { start, end } : null;
}
/** 1 on the day the account was connected, 2 on the next calendar day, and so on. Unknown start counts as past the warm-up. */
export function warmupDay(startedAt: string | null, ms: number, timeZone: string): number {
  if (!startedAt) return 9999;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 9999;
  const days = Math.round((Date.parse(`${localDate(ms, timeZone)}T00:00:00Z`) - Date.parse(`${localDate(started, timeZone)}T00:00:00Z`)) / 86_400_000);
  return Math.max(1, days + 1);
}
/** How many publications the account may send today: the warm-up limits first, then the normal daily limit (never above the account's own limit). */
export function effectiveDailyLimit(settings: PublishSettings, accountDailyLimit: number | null, warmupStartedAt: string | null, ms: number): number {
  const base = Math.max(1, Math.min(settings.daily_post_limit, accountDailyLimit ?? settings.daily_post_limit));
  const day = warmupDay(warmupStartedAt, ms, settings.timezone);
  if (day <= settings.warmup_initial_days) return Math.max(1, Math.min(settings.warmup_initial_limit, base));
  if (day <= settings.warmup_second_end_day) return Math.max(1, Math.min(settings.warmup_second_limit, base));
  return base;
}
/** Start of the posting window on the next calendar day (ISO instant). */
export function nextDayWindowStart(ms: number, timeZone: string, windowStart: string): string | null {
  return zonedTimeToUtcIso(`${addDays(localDate(ms, timeZone), 1)}T${windowStart.slice(0, 5)}`, timeZone);
}
/** Waiting time before another attempt: 5 minutes after the first failure, 10 after the second, and so on. */
export const retryDelayMs = (attempt: number) => Math.min(Math.max(attempt, 1), 6) * 5 * 60_000;

export type FailureKind = 'auth' | 'network' | 'meta' | 'timeout' | 'invalid' | 'processing' | 'unconfirmed' | 'checking';
export function failureMessage(kind: FailureKind, detail = ''): string {
  const extra = detail ? ` (${detail.slice(0, 160)})` : '';
  switch (kind) {
    case 'auth': return 'A conexão com o Instagram expirou. Reconecte na tela Conexões e a publicação continua sozinha.';
    case 'network': return 'O Instagram não respondeu agora.';
    case 'timeout': return 'O Instagram demorou demais para processar o arquivo.';
    case 'unconfirmed': return 'O Instagram não confirmou a publicação, e ela pode ter saído. Confira o seu perfil antes de tentar de novo, para não duplicar.';
    case 'checking': return 'O Instagram não confirmou ainda se a publicação saiu. Vou verificar de novo, sem criar outra.';
    case 'processing': return `O Instagram não conseguiu processar o arquivo${extra}.`;
    case 'invalid': return `Os arquivos desta publicação não servem para este formato${extra}.`;
    default: return `O Instagram recusou a publicação${extra}.`;
  }
}