import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { summarizeSales, simulatedRows, attributionLabel } from './conversions';

export const getSalesOverview = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const sb = context.supabase; const now = Date.now();
  const [{ data: connection }, { data: settings }, { data: state }] = await Promise.all([
    sb.from('marketplace_connections').select('credential_id,status').eq('user_id', context.userId).eq('marketplace', 'shopee').maybeSingle(),
    sb.from('settings').select('timezone').eq('user_id', context.userId).maybeSingle(),
    sb.from('shopee_sync_state').select('last_success_at,last_result').eq('user_id', context.userId).maybeSingle(),
  ]);
  const timezone = settings?.timezone ?? 'America/Sao_Paulo';
  const simulated = !connection?.credential_id;
  let rows;
  if (simulated) rows = simulatedRows(now);
  else {
    const since = new Date(now - 120 * 86_400_000).toISOString();
    const { data, error } = await sb.from('orders').select('id,conversion_id,external_order_id,status,fraud_status,commission_cents,conversion_commission_cents,ordered_at,completed_at,item_name,item_image_url,attribution_type').eq('user_id', context.userId).gte('ordered_at', since).order('ordered_at', { ascending: false }).limit(2000);
    if (error) throw new Error('Não foi possível carregar suas vendas.');
    rows = (data ?? []).map(r => ({ ...r, status: r.status as 'pending' | 'completed' | 'cancelled' }));
  }
  const summary = summarizeSales(rows, timezone, now);
  const latest = rows.slice(0, 10).map(r => ({ id: r.id, date: r.ordered_at, product: r.item_name ?? 'Produto', image: r.item_image_url, status: r.status, fraud: (r.fraud_status ?? '').toUpperCase() === 'FRAUD', commissionCents: r.commission_cents, store: attributionLabel(r.attribution_type) }));
  return { simulated, timezone, connectionStatus: connection?.status ?? 'disconnected', lastSyncAt: state?.last_success_at ?? null, lastResult: state?.last_result ?? null, ...summary, latest };
});

export const syncSalesNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { runSyncTick } = await import('./shopee-sync.server');
  return runSyncTick(supabaseAdmin, context.userId, true);
});
