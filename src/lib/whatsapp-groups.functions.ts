import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { groupRulesSchema, needsGroupSync } from './whatsapp-groups';

export type WhatsAppGroup = {
  id: string; name: string; size: number | null; enabled: boolean; categoryId: number | null; keyword: string;
  days: number[]; windowStart: string; windowEnd: string; intervalMinutes: number;
};
export type GroupsResult = { ok: true; groups: WhatsAppGroup[] } | { ok: false; message: string };

// Os tipos gerados do banco ainda não conhecem as tabelas novas, então este arquivo fala com o banco sem eles.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
async function tooSoon(db: SupabaseClient, scope: string, ms: number) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: scope, p_interval_ms: ms });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}

type Row = { id: string; name: string; size: number | null; enabled: boolean; category_id: number | null; keyword: string; days_of_week: number[]; window_start: string; window_end: string; interval_minutes: number };
const toGroup = (r: Row): WhatsAppGroup => ({ id: r.id, name: r.name, size: r.size, enabled: r.enabled, categoryId: r.category_id === null ? null : Number(r.category_id), keyword: r.keyword, days: [...r.days_of_week].sort((a, b) => a - b), windowStart: r.window_start, windowEnd: r.window_end, intervalMinutes: r.interval_minutes });
async function loadGroups(db: SupabaseClient, userId: string): Promise<WhatsAppGroup[] | null> {
  const { data, error } = await db.from('whatsapp_groups').select('id,name,size,enabled,category_id,keyword,days_of_week,window_start,window_end,interval_minutes').eq('user_id', userId).eq('present', true).order('name', { ascending: true }).limit(500);
  if (error) return null;
  return (data as Row[]).map(toGroup);
}
const LOAD_ERROR = 'Não foi possível carregar os grupos. Tente de novo.';

/** Devolve os grupos. Se o WhatsApp está conectado e a lista nunca foi buscada (ou está velha), busca antes, sem botão. */
export const loadWhatsAppGroups = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<GroupsResult> => {
  const db = await admin();
  const { data } = await db.from('whatsapp_connections').select('status,groups_synced_at').eq('user_id', context.userId).maybeSingle();
  const conn = data as { status?: string; groups_synced_at?: string | null } | null;
  let failure: GroupsResult | null = null;
  if (conn?.status === 'connected' && needsGroupSync(conn.groups_synced_at, new Date()) && !(await tooSoon(db, `whatsapp-groups:${context.userId}`, 10_000))) {
    const { syncGroupsFor } = await import('./whatsapp-groups.server');
    const synced = await syncGroupsFor(db, context.userId);
    if (!synced.ok) failure = { ok: false, message: synced.message };
  }
  const groups = await loadGroups(db, context.userId);
  if (!groups) return { ok: false, message: LOAD_ERROR };
  // Se a busca falhou mas já existem grupos salvos, mostra os salvos.
  return failure && groups.length === 0 ? failure : { ok: true, groups };
});

export const saveGroupRules = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => groupRulesSchema.parse(input)).handler(async ({ context, data }): Promise<GroupsResult> => {
    const db = await admin();
    if (await tooSoon(db, `whatsapp-rules:${context.userId}`, 800)) return { ok: false, message: 'Aguarde um instante e salve de novo.' };
    const { data: changed, error } = await db.from('whatsapp_groups').update({
      enabled: data.enabled, category_id: data.categoryId, keyword: data.keyword, days_of_week: [...data.days].sort((a, b) => a - b),
      window_start: data.windowStart, window_end: data.windowEnd, interval_minutes: data.intervalMinutes,
    }).eq('id', data.groupId).eq('user_id', context.userId).select('id');
    if (error) return { ok: false, message: 'Não foi possível salvar as regras. Confira os dados e tente de novo.' };
    if (!changed?.length) return { ok: false, message: 'Esse grupo não foi encontrado. Recarregue a página.' };
    const groups = await loadGroups(db, context.userId);
    return groups ? { ok: true, groups } : { ok: false, message: LOAD_ERROR };
  });
