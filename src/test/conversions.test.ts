import { describe, it, expect, vi } from 'vitest';
import { parseMoneyToCents, mapOrderStatus, flattenConversions, summarizeSales, planQueue, buildConversionQuery, parseSubIds, FRESH_QUERY_GAP_MS } from '@/lib/conversions';
import { fetchConversionPages, upsertOrders } from '@/lib/shopee-sync.server';

const win = { field: 'purchase' as const, start: 1_700_000_000, end: 1_700_604_800 };
const node = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ conversionId: id, purchaseTime: 1_700_000_100, netCommission: '10.50', totalCommission: '12.00', utmContent: 'a-b', orders: [{ orderId: 'o' + id, orderStatus: status, items: [{ itemId: 1, modelId: 2, itemTotalCommission: '10.50', fraudStatus: 'VERIFIED', imageUrl: 'https://x/y.jpg', ...extra }] }] });

describe('money', () => {
  it('converts text to integer cents without floats', () => {
    expect(parseMoneyToCents('0.1')).toBe(10);
    expect(parseMoneyToCents('12.345')).toBe(1235);
    expect(parseMoneyToCents('1234567.89')).toBe(123456789);
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
  });
});

describe('status mapping', () => {
  it.each([['UNPAID', 'pending'], ['PENDING', 'pending'], ['COMPLETED', 'completed'], ['CANCELLED', 'cancelled']])('%s → %s', (raw, mapped) => expect(mapOrderStatus(raw)).toBe(mapped));
});

describe('query', () => {
  it('requests no deprecated fields and caps at 500', () => {
    const q = buildConversionQuery(win, 'abc=');
    for (const f of ['checkoutId', 'conversionStatus', 'grossCommission', 'cappedCommission', 'totalBrandCommission', 'estimatedTotalCommission', 'itemCommission ', 'grossBrandCommission']) expect(q).not.toContain(f);
    expect(q).toContain('limit: 500'); expect(q).toContain('scrollId: "abc="');
  });
  it('first page has no scrollId and the fresh-query gap is over 30s', () => {
    expect(buildConversionQuery(win)).not.toContain('scrollId:');
    expect(FRESH_QUERY_GAP_MS).toBeGreaterThan(30_000);
  });
  it('splits sub ids with a configurable separator', () => { expect(parseSubIds('a|b', '|')).toEqual(['a', 'b']); });
});

describe('pagination', () => {
  it('follows scrollId pages until hasNextPage is false', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { conversionReport: { nodes: [node('1', 'PENDING')], pageInfo: { hasNextPage: true, scrollId: 's1' } } } })
      .mockResolvedValueOnce({ ok: true, data: { conversionReport: { nodes: [node('2', 'COMPLETED')], pageInfo: { hasNextPage: false } } } });
    const r = await fetchConversionPages(execute, win, () => 0);
    expect(r.ok).toBe(true); expect(r.nodes).toHaveLength(2);
    expect(execute.mock.calls[0]![0].query).not.toContain('scrollId:');
    expect(execute.mock.calls[1]![0].query).toContain('scrollId: "s1"');
  });
  it('stops when the scrollId would be older than 30 seconds', async () => {
    let t = 0; const execute = vi.fn(async () => { t += 40_000; return { ok: true as const, data: { conversionReport: { nodes: [], pageInfo: { hasNextPage: true, scrollId: 's' } } } }; });
    const r = await fetchConversionPages(execute, win, () => t);
    expect(r.ok).toBe(false); expect('expired' in r).toBe(true); expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('upsert', () => {
  it('is idempotent on conversion + order + item', async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const admin = { from: () => ({ upsert }) } as never;
    const rows = flattenConversions([node('1', 'PENDING')], '-');
    await upsertOrders(admin, 'u', rows); await upsertOrders(admin, 'u', rows);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]).toEqual(upsert.mock.calls[1]!.map((x, i) => i === 0 ? expect.anything() : x));
    expect((upsert.mock.calls[0] as unknown as [unknown, { onConflict: string }])[1].onConflict).toBe('user_id,conversion_id,external_order_id,item_id');
    expect(rows[0]).toMatchObject({ item_id: '1:2', commission_cents: 1050, sub_ids: ['a', 'b'] });
  });
});

describe('earnings', () => {
  const now = Date.parse('2023-11-20T12:00:00Z');
  const rows = flattenConversions([node('1', 'COMPLETED', { completeTime: 1_700_400_000 }), node('2', 'PENDING'), node('3', 'CANCELLED'), node('4', 'COMPLETED', { fraudStatus: 'FRAUD', completeTime: 1_700_400_000 })], '-');
  it('counts completed net commission, pending apart, excluding cancelled and fraud', () => {
    expect(summarizeSales(rows, 'America/Sao_Paulo', now)).toEqual({ earnedCents: 1050, pendingCents: 1050, ordersCount: 3 });
  });
});

describe('planning', () => {
  it('queues 90 days of history in 7-day windows on first run', () => {
    const { queue } = planQueue({ queue: [], backfill_queued: false, history_days: 90, interval_minutes: 30, last_periodic_at: null, last_reconcile_at: new Date().toISOString() }, Date.now(), null);
    expect(queue).toHaveLength(13); expect(queue.every(w => w.end - w.start <= 7 * 86400)).toBe(true);
  });
});
