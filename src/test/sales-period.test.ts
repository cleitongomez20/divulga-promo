import { describe, it, expect } from 'vitest';
import { periodRange, parseCustomRange, clampWindow, isTooOldError, MAX_LOOKBACK_DAYS, summarizeSales, pickWindow, PERIODS, WINDOW_DAYS, DAY_S, type SummaryRow } from '@/lib/conversions';

const SP = 'America/Sao_Paulo';
const now = Date.parse('2026-11-01T15:00:00Z'); // 12:00 in São Paulo (UTC-3)
const iso = (ms: number) => new Date(ms).toISOString();

describe('period ranges (account time zone)', () => {
  it('starts days and months at local midnight', () => {
    expect(iso(periodRange('today', SP, now).from)).toBe('2026-11-01T03:00:00.000Z');
    expect(iso(periodRange('month', SP, now).from)).toBe('2026-11-01T03:00:00.000Z');
    expect(iso(periodRange('7d', SP, now).from)).toBe('2026-10-26T03:00:00.000Z');
    expect(iso(periodRange('30d', SP, now).from)).toBe('2026-10-03T03:00:00.000Z');
    expect(iso(periodRange('90d', SP, now).from)).toBe(iso(Date.UTC(2026, 10, 1 - 89, 3)));
  });
  it('last month runs from the first day of October to the first day of November', () => {
    const r = periodRange('last_month', SP, now);
    expect(iso(r.from)).toBe('2026-10-01T03:00:00.000Z');
    expect(iso(r.to)).toBe('2026-11-01T03:00:00.000Z');
  });
  it('handles January (previous month is December) and daylight saving time', () => {
    const jan = periodRange('last_month', SP, Date.parse('2027-01-15T15:00:00Z'));
    expect(iso(jan.from)).toBe('2026-12-01T03:00:00.000Z');
    expect(iso(jan.to)).toBe('2027-01-01T03:00:00.000Z');
    const ny = periodRange('month', 'America/New_York', Date.parse('2026-11-02T15:00:00Z'));
    expect(iso(ny.from)).toBe('2026-11-01T04:00:00.000Z'); // still daylight time (UTC-4) on Nov 1 at midnight
  });
  it('has a label and a phrase for every period', () => {
    expect(PERIODS.map(p => p.key)).toEqual(['today', '7d', '30d', 'month', 'last_month', '90d']);
    expect(PERIODS.every(p => p.label && p.phrase)).toBe(true);
  });
});

describe('earnings for a chosen period', () => {
  const row = (id: string, status: SummaryRow['status'], orderedAt: string, completedAt: string | null, cents: number): SummaryRow => ({ conversion_id: id, external_order_id: id, status, fraud_status: null, commission_cents: cents, conversion_commission_cents: cents, ordered_at: orderedAt, completed_at: completedAt });
  const rows = [
    row('a', 'completed', '2026-10-10T12:00:00Z', '2026-10-20T12:00:00Z', 1000),
    row('b', 'completed', '2026-10-28T12:00:00Z', '2026-11-01T10:00:00Z', 500),
    row('c', 'pending', '2026-10-30T12:00:00Z', null, 300),
    row('d', 'pending', '2026-11-01T11:00:00Z', null, 200),
  ];
  it('keeps the month behaviour when no range is given', () => {
    expect(summarizeSales(rows, SP, now)).toEqual({ earnedCents: 500, pendingCents: 200, ordersCount: 1 });
  });
  it('sums only what falls inside the range', () => {
    expect(summarizeSales(rows, SP, now, periodRange('last_month', SP, now))).toEqual({ earnedCents: 1000, pendingCents: 300, ordersCount: 3 });
    expect(summarizeSales(rows, SP, now, periodRange('90d', SP, now))).toEqual({ earnedCents: 1500, pendingCents: 500, ordersCount: 4 });
    expect(summarizeSales(rows, SP, now, periodRange('today', SP, now))).toEqual({ earnedCents: 500, pendingCents: 200, ordersCount: 1 });
  });
});

describe('which window a manual run asks for', () => {
  const history = [{ field: 'purchase' as const, start: 1, end: 2 }];
  it('"Atualizar agora" puts the last 7 days first', () => {
    const q = pickWindow(history, true, 'recent', 10_000_000);
    expect(q).toHaveLength(2);
    expect(q[0]).toEqual({ field: 'purchase', start: 10_000_000 - WINDOW_DAYS * DAY_S, end: 10_000_000 });
  });
  it('"Buscar histórico" keeps working through the queued windows', () => {
    expect(pickWindow(history, true, 'history', 10_000_000)).toEqual(history);
  });
  it('the automatic run never adds a window', () => {
    expect(pickWindow(history, false, 'recent', 10_000_000)).toEqual(history);
  });
});

describe('custom period', () => {
  it('runs from local midnight of the first day to local midnight after the last day', () => {
    const r = periodRange('custom', SP, now, { from: '2026-10-10', to: '2026-10-12' });
    expect(iso(r.from)).toBe('2026-10-10T03:00:00.000Z');
    expect(iso(r.to)).toBe('2026-10-13T03:00:00.000Z');
  });
  it('accepts a single day', () => {
    const r = periodRange('custom', SP, now, { from: '2026-10-31', to: '2026-10-31' });
    expect(r.to - r.from).toBe(DAY_S * 1000);
  });
  it('puts reversed dates in order and refuses invalid or very long ranges', () => {
    expect(parseCustomRange('2026-10-12', '2026-10-10')).toEqual({ from: '2026-10-10', to: '2026-10-12' });
    expect(parseCustomRange('2026-10-10', undefined)).toBeNull();
    expect(parseCustomRange('10/10/2026', '2026-10-12')).toBeNull();
    expect(parseCustomRange('2026-13-40', '2026-10-12')).toBeNull();
    expect(parseCustomRange('2024-01-01', '2026-10-12')).toBeNull();
  });
  it('sums only the chosen days', () => {
    const row = (id: string, status: SummaryRow['status'], orderedAt: string, completedAt: string | null, cents: number): SummaryRow => ({ conversion_id: id, external_order_id: id, status, fraud_status: null, commission_cents: cents, conversion_commission_cents: cents, ordered_at: orderedAt, completed_at: completedAt });
    const rows = [row('a', 'completed', '2026-10-10T12:00:00Z', '2026-10-11T12:00:00Z', 700), row('b', 'completed', '2026-10-20T12:00:00Z', '2026-10-21T12:00:00Z', 900)];
    expect(summarizeSales(rows, SP, now, periodRange('custom', SP, now, { from: '2026-10-09', to: '2026-10-12' }))).toEqual({ earnedCents: 700, pendingCents: 0, ordersCount: 1 });
  });
});

describe('the Shopee only serves the last 3 months', () => {
  const nowSeconds = 1_800_000_000;
  it('shortens a window that starts too far back', () => {
    const fitted = clampWindow({ field: 'purchase', start: nowSeconds - 90 * DAY_S, end: nowSeconds - 83 * DAY_S }, nowSeconds);
    expect(fitted).toEqual({ field: 'purchase', start: nowSeconds - MAX_LOOKBACK_DAYS * DAY_S, end: nowSeconds - 83 * DAY_S });
  });
  it('drops a window that is entirely too old and keeps recent ones untouched', () => {
    expect(clampWindow({ field: 'purchase', start: nowSeconds - 100 * DAY_S, end: nowSeconds - 90 * DAY_S }, nowSeconds)).toBeNull();
    const recent = { field: 'purchase' as const, start: nowSeconds - 7 * DAY_S, end: nowSeconds };
    expect(clampWindow(recent, nowSeconds)).toEqual(recent);
  });
  it('recognises the Shopee message about the 3 month limit', () => {
    expect(isTooOldError('error [11001]: Params Error : can only query data for the last 3 months')).toBe(true);
    expect(isTooOldError('Business Error')).toBe(false);
  });
});
