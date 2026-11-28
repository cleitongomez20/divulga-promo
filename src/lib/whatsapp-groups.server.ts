// Busca os grupos no WhatsApp conectado e atualiza a tabela, sem mexer nas regras já salvas.
import type { SupabaseClient } from '@supabase/supabase-js';
import { instanceNameFor, whatsappErrorMessage } from './whatsapp';

export async function syncGroupsFor(db: SupabaseClient, userId: string): Promise<{ ok: true; found: number } | { ok: false; message: string }> {
  try {
    const { data: conn } = await db.from('whatsapp_connections').select('status').eq('user_id', userId).maybeSingle();
    if ((conn as { status?: string } | null)?.status !== 'connected') return { ok: false, message: 'Conecte o WhatsApp primeiro.' };
    const { listGroups } = await import('./whatsapp.server');
    const found = await listGroups(instanceNameFor(userId));
    // Lista vazia pode ser só o servidor ainda carregando logo após conectar: não mexe em nada e tenta de novo depois.
    if (!found.length) return { ok: true, found: 0 };
    const now = new Date().toISOString();
    const { error } = await db.from('whatsapp_groups').upsert(found.map(g => ({ user_id: userId, group_jid: g.jid, name: g.name, size: g.size, present: true, updated_at: now })), { onConflict: 'user_id,group_jid' });
    if (error) return { ok: false, message: 'Não foi possível salvar os grupos. Tente de novo.' };
    // Grupos dos quais o número saiu deixam de aparecer e são pausados; as regras ficam guardadas caso ele volte.
    const seen = new Set(found.map(g => g.jid));
    const { data: all } = await db.from('whatsapp_groups').select('group_jid').eq('user_id', userId).eq('present', true);
    const gone = ((all as { group_jid: string }[] | null) ?? []).map(r => r.group_jid).filter(jid => !seen.has(jid));
    if (gone.length) await db.from('whatsapp_groups').update({ present: false, enabled: false }).eq('user_id', userId).in('group_jid', gone);
    await db.from('whatsapp_connections').update({ groups_synced_at: now }).eq('user_id', userId);
    return { ok: true, found: found.length };
  } catch (error) {
    const { WhatsAppError } = await import('./whatsapp.server');
    return { ok: false, message: whatsappErrorMessage(error instanceof WhatsAppError ? error.kind : 'server') };
  }
}
