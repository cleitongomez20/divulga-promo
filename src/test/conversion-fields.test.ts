import { describe, it, expect, vi } from 'vitest';
import { buildConversionQuery, unknownFieldName } from '@/lib/conversions';
import { fetchConversionPages } from '@/lib/shopee-sync.server';
import type { GraphFailure } from '@/lib/shopee.server';

const win = { field: 'purchase' as const, start: 1792896551, end: 1793501351 };
const unknownField = (name: string, type = 'ConversionReport') =>
  ({ ok: false, errors: [{ path: [], message: `Cannot query field "${name}" on type "${type}".`, extensions: { code: 10010, message: '' } }], message: 'x', retryable: false, invalidCredentials: false, awaitingAccess: false, accountProblem: false } as unknown as GraphFailure);

describe('conversion query fields', () => {
  it('no longer asks for fields the app does not use and Shopee rejected', () => {
    const q = buildConversionQuery(win);
    expect(q).not.toContain('campaignType');
    expect(q).not.toContain('displayItemStatus');
    expect(q).toContain('netCommission');
  });
  it('can leave out a field by name without touching similar names', () => {
    const q = buildConversionQuery(win, undefined, ['netCommission', 'itemName']);
    expect(q).not.toContain('netCommission');
    expect(q).not.toContain('itemName');
    expect(q).toContain('totalCommission');
    expect(q).toContain('itemTotalCommission');
  });
  it('reads the field name from the Shopee error and never drops essential fields', () => {
    expect(unknownFieldName('Cannot query field "campaignType" on type "ConversionReport".')).toBe('campaignType');
    expect(unknownFieldName('Cannot query field "conversionId" on type "ConversionReport".')).toBeNull();
    expect(unknownFieldName('Business Error')).toBeNull();
  });
});

describe('automatic dropping of rejected fields', () => {
  it('drops the rejected fields, asks the same page again and reports what was dropped', async () => {
    const sent: string[] = [];
    const answers = [unknownField('zzTestFieldA'), unknownField('zzTestFieldB', 'ConversionReportOrderItem'), { ok: true, data: { conversionReport: { nodes: [{ conversionId: '1' }], pageInfo: { hasNextPage: false } } } }];
    const execute = vi.fn(async (req: { query: string }) => { sent.push(req.query); return answers.shift() as never; });
    const r = await fetchConversionPages(execute, win, () => 0);
    expect(r.ok).toBe(true);
    expect(r.nodes).toHaveLength(1);
    expect(r.omitted).toEqual(['zzTestFieldA', 'zzTestFieldB']);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sent[2]).not.toContain('zzTestFieldA');
  });
  it('gives up on essential fields and on other errors', async () => {
    const execute = vi.fn(async () => unknownField('conversionId') as never);
    const r = await fetchConversionPages(execute, win, () => 0);
    expect(r.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('stops after a limited number of drops', async () => {
    let n = 0;
    const execute = vi.fn(async () => unknownField(`zzLoopField${n++}`) as never);
    const r = await fetchConversionPages(execute, win, () => 0);
    expect(r.ok).toBe(false);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(9);
  });
});
