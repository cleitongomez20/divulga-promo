import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { instanceNameFor, whatsappErrorMessage } from './whatsapp';
import { groupRulesSchema } from './whatsapp-groups';

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

export const getWhatsAppGroups = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<GroupsResult> => {
  const groups = await loadGroups(await admin(), context.userId);
  return groups ? { ok: true, groups } : { ok: false, message: LOAD_ERROR };
});

/** Busca no WhatsApp conectado a lista atual de grupos e atualiza a tabela, sem mexer nas regras já salvas. */
export const syncWhatsAppGroups = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<GroupsResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, `whatsapp-groups:${context.userId}`, 10_000)) return { ok: false, message: 'Aguarde alguns segundos antes de atualizar de novo.' };
    const { data: conn } = await db.from('whatsapp_connections').select('status').eq('user_id', context.userId).maybeSingle();
    if ((conn as { status?: string } | null)?.status !== 'connected') return { ok: false, message: 'Conecte o WhatsApp primeiro.' };
    const { listGroups } = await import('./whatsapp.server');
    const found = await listGroups(instanceNameFor(context.userId));
    const now = new Date().toISOString();
    if (found.length) {
      const { error } = await db.from('whatsapp_groups').upsert(found.map(g => ({ user_id: context.userId, group_jid: g.jid, name: g.name, size: g.size, present: true, updated_at: now })), { onConflict: 'user_id,group_jid' });
      if (error) return { ok: false, message: 'Não foi possível salvar os grupos. Tente de novo.' };
    }
    // Grupos dos quais o número saiu deixam de aparecer e são pausados; as regras ficam guardadas caso ele volte.
    const seen = new Set(found.map(g => g.jid));
    const { data: all } = await db.from('whatsapp_groups').select('group_jid').eq('user_id', context.userId).eq('present', true);
    const gone = ((all as { group_jid: string }[] | null) ?? []).map(r => r.group_jid).filter(jid => !seen.has(jid));
    if (gone.length) await db.from('whatsapp_groups').update({ present: false, enabled: false }).eq('user_id', context.userId).in('group_jid', gone);
    const groups = await loadGroups(db, context.userId);
    return groups ? { ok: true, groups } : { ok: false, message: LOAD_ERROR };
  } catch (error) {
    const { WhatsAppError } = await import('./whatsapp.server');
    return { ok: false, message: whatsappErrorMessage(error instanceof WhatsAppError ? error.kind : 'server') };
  }
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
    if (!changed?.length) return { ok: false, message: 'Esse grupo não foi encontrado. Atualize a lista de grupos.' };
    const groups = await loadGroups(db, context.userId);
    return groups ? { ok: true, groups } : { ok: false, message: LOAD_ERROR };
  });
