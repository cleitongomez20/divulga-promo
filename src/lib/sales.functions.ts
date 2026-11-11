import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { summarizeSales, simulatedRows, attributionLabel, periodRange, parseCustomRange, PERIODS, CUSTOM_PERIOD } from './conversions';

const LIST_LIMIT = 30;
const periodSchema = z.object({ period: z.enum(['today', '7d', '30d', 'month', 'last_month', '90d', 'custom']).default('month'), from: z.string().optional(), to: z.string().optional() });

export const getSalesOverview = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth])
  .inputValidator(input => periodSchema.parse(input ?? {})).handler(async ({ context, data }) => {
    const sb = context.supabase; const now = Date.now();
    const [{ data: connection }, { data: settings }, { data: state }] = await Promise.all([
      sb.from('marketplace_connections').select('credential_id,status').eq('user_id', context.userId).eq('marketplace', 'shopee').maybeSingle(),
      sb.from('settings').select('timezone').eq('user_id', context.userId).maybeSingle(),
      sb.from('shopee_sync_state').select('last_success_at,last_result,backfill_queued,queue,interval_minutes').eq('user_id', context.userId).maybeSingle(),
    ]);
    const timezone = settings?.timezone ?? 'America/Sao_Paulo';
    // Posts published today (account time zone), counted on any day-independent period.
    const today = periodRange('today', timezone, now);
    const { count: publishedToday } = await sb.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', context.userId).eq('status', 'published').gte('published_at', new Date(today.from).toISOString()).lt('published_at', new Date(today.to).toISOString());
    const simulated = !connection?.credential_id;
    // A custom period needs two valid dates; otherwise the current month is shown.
    const custom = data.period === 'custom' ? parseCustomRange(data.from, data.to) : null;
    const key = data.period === 'custom' && !custom ? 'month' : data.period;
    const range = periodRange(key, timezone, now, custom ?? undefined);
    let rows;
    if (simulated) rows = simulatedRows(now);
    else {
      const since = new Date(Math.min(now - 120 * 86_400_000, range.from)).toISOString();
      const { data: found, error } = await sb.from('orders').select('id,conversion_id,external_order_id,status,fraud_status,commission_cents,conversion_commission_cents,ordered_at,completed_at,item_name,item_image_url,attribution_type').eq('user_id', context.userId).gte('ordered_at', since).order('ordered_at', { ascending: false }).limit(2000);
      if (error) throw new Error('Não foi possível carregar suas vendas.');
      rows = (found ?? []).map(r => ({ ...r, status: r.status as 'pending' | 'completed' | 'cancelled' }));
    }
    const summary = summarizeSales(rows, timezone, now, range);
    const inPeriod = rows.filter(r => { const t = Date.parse(r.ordered_at ?? ''); return t >= range.from && t < range.to; });
    const latest = inPeriod.slice(0, LIST_LIMIT).map(r => ({ id: r.id, date: r.ordered_at, product: r.item_name ?? 'Produto', image: r.item_image_url, status: r.status, fraud: (r.fraud_status ?? '').toUpperCase() === 'FRAUD', commissionCents: r.commission_cents, store: attributionLabel(r.attribution_type) }));
    const queueLength = Array.isArray(state?.queue) ? state.queue.length : 0;
    const period = key === 'custom' ? CUSTOM_PERIOD : PERIODS.find(p => p.key === key)!;
    return {
      simulated, timezone, connectionStatus: connection?.status ?? 'disconnected', lastSyncAt: state?.last_success_at ?? null, lastResult: state?.last_result ?? null,
      ...summary, latest, totalInPeriod: inPeriod.length,
      period: period.key, periodLabel: period.label, periodPhrase: period.phrase,
      rangeFrom: new Date(range.from).toISOString(), rangeTo: new Date(Math.min(range.to - 1, now)).toISOString(),
      historyLoaded: Boolean(state?.backfill_queued) && queueLength === 0,
      syncIntervalMinutes: state?.interval_minutes ?? 30,
      publishedToday: publishedToday ?? 0,
    };
  });

/** One automatic step of the Shopee sync (history windows first, then the periodic refresh).
 *  Not manual: it follows the saved queue, the refresh interval and the pause after errors. The screen repeats it, respecting the 31s gap. */
export const syncSalesStep = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { runSyncTick } = await import('./shopee-sync.server');
  return runSyncTick(supabaseAdmin, context.userId, false);
});
