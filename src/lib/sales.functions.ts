import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { summarizeSales, simulatedRows, attributionLabel, periodRange, PERIODS } from './conversions';

const LIST_LIMIT = 30;
const periodSchema = z.object({ period: z.enum(['today', '7d', '30d', 'month', 'last_month', '90d']).default('month') });

export const getSalesOverview = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth])
  .inputValidator(input => periodSchema.parse(input ?? {})).handler(async ({ context, data }) => {
    const sb = context.supabase; const now = Date.now();
    const [{ data: connection }, { data: settings }, { data: state }] = await Promise.all([
      sb.from('marketplace_connections').select('credential_id,status').eq('user_id', context.userId).eq('marketplace', 'shopee').maybeSingle(),
      sb.from('settings').select('timezone').eq('user_id', context.userId).maybeSingle(),
      sb.from('shopee_sync_state').select('last_success_at,last_result,backfill_queued,queue').eq('user_id', context.userId).maybeSingle(),
    ]);
    const timezone = settings?.timezone ?? 'America/Sao_Paulo';
    const simulated = !connection?.credential_id;
    let rows;
    if (simulated) rows = simulatedRows(now);
    else {
      const since = new Date(now - 120 * 86_400_000).toISOString();
      const { data: found, error } = await sb.from('orders').select('id,conversion_id,external_order_id,status,fraud_status,commission_cents,conversion_commission_cents,ordered_at,completed_at,item_name,item_image_url,attribution_type').eq('user_id', context.userId).gte('ordered_at', since).order('ordered_at', { ascending: false }).limit(2000);
      if (error) throw new Error('Não foi possível carregar suas vendas.');
      rows = (found ?? []).map(r => ({ ...r, status: r.status as 'pending' | 'completed' | 'cancelled' }));
    }
    const range = periodRange(data.period, timezone, now);
    const summary = summarizeSales(rows, timezone, now, range);
    const inPeriod = rows.filter(r => { const t = Date.parse(r.ordered_at ?? ''); return t >= range.from && t < range.to; });
    const latest = inPeriod.slice(0, LIST_LIMIT).map(r => ({ id: r.id, date: r.ordered_at, product: r.item_name ?? 'Produto', image: r.item_image_url, status: r.status, fraud: (r.fraud_status ?? '').toUpperCase() === 'FRAUD', commissionCents: r.commission_cents, store: attributionLabel(r.attribution_type) }));
    const queueLength = Array.isArray(state?.queue) ? state.queue.length : 0;
    const period = PERIODS.find(p => p.key === data.period)!;
    return {
      simulated, timezone, connectionStatus: connection?.status ?? 'disconnected', lastSyncAt: state?.last_success_at ?? null, lastResult: state?.last_result ?? null,
      ...summary, latest, totalInPeriod: inPeriod.length,
      period: period.key, periodLabel: period.label, periodPhrase: period.phrase,
      rangeFrom: new Date(range.from).toISOString(), rangeTo: new Date(Math.min(range.to - 1, now)).toISOString(),
      historyLoaded: Boolean(state?.backfill_queued) && queueLength === 0,
    };
  });

export const syncSalesNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { runSyncTick } = await import('./shopee-sync.server');
  return runSyncTick(supabaseAdmin, context.userId, true);
});

/** One step of the 90-day history load (one 7-day window). The screen repeats it, respecting the 30s pause. */
export const syncHistoryStep = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { runSyncTick } = await import('./shopee-sync.server');
  return runSyncTick(supabaseAdmin, context.userId, true, 'history');
});
