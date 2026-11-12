import { z } from 'zod';
import { zonedTimeToUtcIso } from './posts';
import { addDays, localDate } from './publishing';

export const AUTOMATION_MODES = ['approval', 'auto'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
export const MODE_LABELS: Record<AutomationMode, string> = { approval: 'Com a minha aprovação', auto: 'Totalmente automático' };

/** A video is ordered this long before the time it is meant to go out, because Higgsfield takes a few minutes. */
export const ORDER_LEAD_MS = 25 * 60_000;
/** No new Reels is ordered this close to the end of the posting window. */
export const LATE_CUTOFF_MS = 30 * 60_000;
/** In approval mode, no new video is ordered while this many are waiting for the user. */
export const MAX_PENDING_APPROVAL = 4;
/** After this many failed videos in one day, the automation rests until the next day. */
export const MAX_FAILED_PER_DAY = 3;
/** After an error the automation waits this long before trying again, so a problem cannot burn money every minute. */
export const RETRY_BACKOFF_MS = 15 * 60_000;
/** A Story is created for Reels published up to this long ago. */
export const STORY_LOOKBACK_MS = 36 * 3_600_000;
/** The minimum time between "now" and a time chosen for a post. */
export const MIN_LEAD_MS = 2 * 60_000;

export const automationSettingsSchema = z.object({ enabled: z.boolean(), mode: z.enum(AUTOMATION_MODES), storyAfterReel: z.boolean() });

/** What the automation needs from the Configurações screen. */
export type AutomationSettings = {
  timezone: string; products_per_day: number; daily_post_limit: number; window_start: string; window_end: string;
  story_delay_min_hours: number; story_delay_max_hours: number; repeat_days: number;
};
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  timezone: 'America/Sao_Paulo', products_per_day: 3, daily_post_limit: 6, window_start: '08:00', window_end: '22:00', story_delay_min_hours: 1, story_delay_max_hours: 8, repeat_days: 14,
};

/** The same text always gives the same number between 0 and 1: every visit of the scheduler computes the same times. */
export function seededUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return (hash >>> 0) / 4_294_967_296;
}

/** Reels per day: the products per day, but never more than the daily limit allows (each Reels may bring a Story with it). */
export function reelsPerDay(productsPerDay: number, dailyLimit: number, storyAfterReel: boolean): number {
  return Math.max(1, Math.min(productsPerDay, Math.floor(dailyLimit / (storyAfterReel ? 2 : 1))));
}

const hhmm = (value: string) => (/^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : null);
/** Start and end (UTC milliseconds) of the posting window on the local day of the given instant. Falls back to 08:00-22:00 when the settings do not make sense. */
export function windowOfDay(ms: number, timeZone: string, windowStart: string, windowEnd: string): { startMs: number; endMs: number } {
  const date = localDate(ms, timeZone);
  const make = (day: string, start: string, end: string) => ({ start: zonedTimeToUtcIso(`${day}T${start}`, timeZone), end: zonedTimeToUtcIso(`${day}T${end}`, timeZone) });
  let s = hhmm(windowStart) ?? '08:00'; let e = hhmm(windowEnd) ?? '22:00';
  if (s >= e) { s = '08:00'; e = '22:00'; }
  const built = make(date, s, e);
  return { startMs: Date.parse(built.start ?? ''), endMs: Date.parse(built.end ?? '') };
}

/** The times of the day's Reels: evenly spread across the window, each moved a little by a fixed amount so they do not look robotic. */
export function slotTimes(window: { startMs: number; endMs: number }, count: number, seed: string): number[] {
  const spacing = (window.endMs - window.startMs) / Math.max(1, count);
  return Array.from({ length: Math.max(1, count) }, (_, k) => Math.round(window.startMs + (k + 0.5) * spacing + (seededUnit(`${seed}#${k}`) - 0.5) * spacing * 0.5));
}

export type PlanDecision = { order: true; slotMs: number } | { order: false; reason: 'done' | 'too-early' | 'too-late' };
/** Should the next Reels of the day be ordered now? `force` ignores the clock (the "create the next one now" button) but never the daily target. */
export function decideOrder(p: { nowMs: number; made: number; target: number; slots: readonly number[]; window: { startMs: number; endMs: number }; force: boolean }): PlanDecision {
  if (p.made >= p.target) return { order: false, reason: 'done' };
  const slotMs = p.slots[p.made] ?? p.window.endMs;
  if (p.force) return { order: true, slotMs: Math.max(slotMs, p.nowMs + MIN_LEAD_MS) };
  if (p.nowMs > p.window.endMs - LATE_CUTOFF_MS) return { order: false, reason: 'too-late' };
  if (p.nowMs < slotMs - ORDER_LEAD_MS) return { order: false, reason: 'too-early' };
  return { order: true, slotMs: Math.max(slotMs, p.nowMs + MIN_LEAD_MS) };
}

/** When the Story of a published Reels goes out: a few hours later (between the minimum and the maximum of the settings), always inside the posting window. */
export function storyTime(p: { publishedMs: number; nowMs: number; settings: AutomationSettings; seed: string }): number {
  const { settings } = p;
  const min = Math.max(0, settings.story_delay_min_hours); const max = Math.max(min, settings.story_delay_max_hours);
  let at = p.publishedMs + (min + seededUnit(`${p.seed}#delay`) * (max - min)) * 3_600_000;
  const inside = windowOfDay(at, settings.timezone, settings.window_start, settings.window_end);
  if (at < inside.startMs) at = inside.startMs + seededUnit(`${p.seed}#early`) * 30 * 60_000;
  else if (at > inside.endMs) {
    const next = windowOfDay(Date.parse(`${addDays(localDate(at, settings.timezone), 1)}T12:00:00Z`), settings.timezone, settings.window_start, settings.window_end);
    at = next.startMs + seededUnit(`${p.seed}#late`) * 30 * 60_000;
  }
  return Math.round(Math.max(at, p.nowMs + MIN_LEAD_MS));
}