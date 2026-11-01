// Server-only: conversion sync for Shopee. Never import from components.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/integrations/supabase/types';
import { buildConversionQuery, unknownFieldName, pickWindow, flattenConversions, planQueue, FRESH_QUERY_GAP_MS, SCROLL_TTL_MS, DAY_S, type SyncWindow, type OrderRow } from './conversions';
import { ShopeeConnector, ACCOUNT_PROBLEM_CODES, type GraphDataResult, type GraphFailure, type GraphRequest } from './shopee.server';

type Admin = SupabaseClient<Database>;
type Execute = (request: GraphRequest) => Promise<GraphDataResult>;

export type PagesResult = ({ ok: true; nodes: unknown[] } | { ok: false; nodes: unknown[]; expired: true } | { ok: false; nodes: unknown[]; failure: GraphFailure }) & { omitted?: string[] };

const MAX_FIELD_PRUNES = 8;
/** Fields the Shopee schema said do not exist. Remembered while this server instance lives so later syncs skip them. */
const rejectedFields = new Set<string>();

/** Follows scrollId pages. A scrollId is single-use and expires in 30s; on expiry the window restarts later.
 *  If Shopee says a field does not exist ("Cannot query field"), that field is dropped and the same page is asked again. */
export async function fetchConversionPages(execute: Execute, window: SyncWindow, now: () => number = Date.now, maxPages = 200): Promise<PagesResult> {
  const nodes: unknown[] = [];
  const omit = new Set(rejectedFields);
  const dropped: string[] = [];
  const omitted = () => (dropped.length ? { omitted: [...dropped] } : {});
  let scrollId: string | undefined; let lastAt = 0;
  for (let page = 0; page < maxPages; page++) {
    if (scrollId !== undefined && now() - lastAt > SCROLL_TTL_MS - 2000) return { ok: false, nodes, expired: true, ...omitted() };
    const result = await execute({ query: buildConversionQuery(window, scrollId, [...omit]) });
    if (!result.ok) {
      const unknown = result.errors.map(e => unknownFieldName(e.message)).find((name): name is string => !!name);
      if (unknown && !omit.has(unknown) && dropped.length < MAX_FIELD_PRUNES) {
        omit.add(unknown); rejectedFields.add(unknown); dropped.push(unknown);
        page--; // the same page is asked again without the rejected field
        continue;
      }
      return { ok: false, nodes, failure: result, ...omitted() };
    }
    lastAt = now();
    const report = result.data['conversionReport'] as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; scrollId?: unknown } } | null | undefined;
    if (Array.isArray(report?.nodes)) nodes.push(...report.nodes);
    const next = report?.pageInfo?.hasNextPage === true && typeof report.pageInfo.scrollId === 'string' && report.pageInfo.scrollId ? report.pageInfo.scrollId : undefined;
    if (!next) return { ok: true, nodes, ...omitted() };
    scrollId = next;
  }
  return { ok: true, nodes, ...omitted() };
}

export async function upsertOrders(admin: Admin, userId: string, rows: OrderRow[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({ ...r, user_id: userId, marketplace: 'shopee', synced_at: new Date().toISOString() }));
    const { error } = await admin.from('orders').upsert(batch, { onConflict: 'user_id,conversion_id,external_order_id,item_id' });
    if (error) throw new Error('Não foi possível guardar as vendas.');
  }
}

async function openConnector(admin: Admin, userId: string) {
  const { data: connection } = await admin.from('marketplace_connections').select('credential_id').eq('user_id', userId).eq('marketplace', 'shopee').maybeSingle();
  if (!connection?.credential_id) return null;
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
  const { data: stored, error } = await admin.from('connector_secrets').select('ciphertext,key_version').eq('id', connection.credential_id).eq('user_id', userId).single();
  if (error || !stored || stored.key_version !== 1) throw new Error('Não foi possível abrir a conexão. Salve suas credenciais novamente.');
  const { decryptCredentials } = await import('./connector-crypto.server');
  const credentials = await decryptCredentials(stored.ciphertext, key, userId);
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  return new ShopeeConnector(credentials, {
    acquire: async () => {
      for (let i = 0; i < 3; i++) {
        const { data: delay, error: e } = await admin.rpc('reserve_connector_slot', { p_scope: 'shopee', p_interval_ms: 3000 });
        if (e || delay == null || delay > 15000) return false;
        if (delay === 0) return true;
        await wait(delay);
      }
      return false;
    },
    slowDown: async () => { await admin.rpc('slow_shopee_requests'); },
  });
}

export type TickResult = { status: 'done' | 'wait' | 'busy' | 'simulated' | 'paused' | 'error' | 'restart'; message: string; waitSeconds?: number; saved?: number; remaining?: number };

export async function runSyncTick(admin: Admin, userId: string, manual: boolean, mode: 'recent' | 'history' = 'recent'): Promise<TickResult> {
  const { data: gap, error: gapError } = await admin.rpc('reserve_connector_slot', { p_scope: `shopee-conv:${userId}`, p_interval_ms: FRESH_QUERY_GAP_MS });
  if (gapError) return { status: 'error', message: 'Não foi possível aplicar a pausa de segurança.' };
  if (gap !== 0) return { status: 'wait', message: 'Aguarde alguns segundos antes de atualizar de novo.', waitSeconds: Math.ceil((gap ?? 30000) / 1000) };
  const { data: locked } = await admin.rpc('shopee_sync_lock', { p_user_id: userId, p_seconds: 120 });
  if (!locked) return { status: 'busy', message: 'Já estamos atualizando suas vendas. Aguarde um pouco.' };
  const log = (result: string, details: Record<string, unknown> = {}) => admin.from('activity_log').insert({ user_id: userId, action: 'Vendas da Shopee atualizadas', result, details: details as Json });
  const update = (patch: Database['public']['Tables']['shopee_sync_state']['Update']) => admin.from('shopee_sync_state').update({ ...patch, running_until: null }).eq('user_id', userId);
  try {
    const connector = await openConnector(admin, userId);
    if (!connector) { await update({}); return { status: 'simulated', message: 'Modo de teste (dados simulados)' }; }
    const { data: state } = await admin.from('shopee_sync_state').select('*').eq('user_id', userId).single();
    if (!state) throw new Error('state');
    if (!manual && state.next_attempt_at && Date.parse(state.next_attempt_at) > Date.now()) { await update({}); return { status: 'paused', message: state.last_result ?? 'Sincronização pausada.' }; }
    const { data: oldest } = await admin.from('orders').select('ordered_at').eq('user_id', userId).eq('status', 'pending').order('ordered_at', { ascending: true }).limit(1).maybeSingle();
    const plan = planQueue({ ...state, queue: Array.isArray(state.queue) ? state.queue as unknown as SyncWindow[] : [] }, Date.now(), oldest?.ordered_at ? Date.parse(oldest.ordered_at) : null);
    const queue = pickWindow(plan.queue, manual, mode, Math.floor(Date.now() / 1000));
    const window = queue[0];
    if (!window) { await update({ ...plan.patch }); return { status: 'done', message: mode === 'history' ? 'Seu histórico já está carregado.' : 'Suas vendas já estão em dia.', saved: 0, remaining: 0 }; }
    const pages = await fetchConversionPages(req => connector.execute(req), window);
    const rows = flattenConversions(pages.nodes, state.sub_id_separator);
    if (pages.ok) {
      await upsertOrders(admin, userId, rows);
      const message = rows.length ? `${rows.length} ${rows.length === 1 ? 'item atualizado' : 'itens atualizados'}.` : 'Nenhuma venda nova nesse período.';
      await update({ ...plan.patch, queue: queue.slice(1) as unknown as Json, last_success_at: new Date().toISOString(), failures: 0, next_attempt_at: null, last_result: message });
      if (manual || rows.length || pages.omitted) await log(message, { window, saved: rows.length, ...(pages.omitted ? { omitted_fields: pages.omitted } : {}) });
      return { status: 'done', message, saved: rows.length, remaining: queue.length - 1 };
    }
    if ('expired' in pages) {
      await update({ ...plan.patch, queue: queue as unknown as Json, last_result: 'A consulta demorou demais e será refeita.' });
      return { status: 'restart', message: 'A consulta demorou demais. Tente de novo em instantes.' };
    }
    const f = pages.failure;
    const codes = f.errors.map(e => e.extensions.code);
    const failures = state.failures + 1;
    const hardStop = f.accountProblem || f.awaitingAccess || f.invalidCredentials;
    const delayMs = hardStop ? 30 * DAY_S * 1000 : Math.min(2 ** failures * 5 * 60_000, 6 * 3600_000);
    if (hardStop) await admin.from('marketplace_connections').update({ status: f.awaitingAccess ? 'awaiting_access' : f.accountProblem ? 'account_problem' : 'invalid_credentials' }).eq('user_id', userId).eq('marketplace', 'shopee');
    await update({ ...plan.patch, queue: queue as unknown as Json, failures, next_attempt_at: new Date(Date.now() + delayMs).toISOString(), last_result: f.message });
    // Error paths are logged so a rejected field (10010) can be identified.
    await log(f.message, { window, codes, errors: f.errors.map(e => ({ path: e.path, message: e.message, code: e.extensions.code })), account_problem: codes.some(c => ACCOUNT_PROBLEM_CODES.includes(c)), ...(pages.omitted ? { omitted_fields: pages.omitted } : {}) });
    return { status: 'error', message: f.message };
  } catch {
    await update({});
    await log('Não foi possível atualizar as vendas.');
    return { status: 'error', message: 'Não foi possível atualizar as vendas. Tente de novo mais tarde.' };
  }
}
