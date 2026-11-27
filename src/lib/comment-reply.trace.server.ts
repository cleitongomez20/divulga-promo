// Server-only: leaves a trace in the activity log of everything Meta sends to the webhook, so it is possible to see where the "EU QUERO"
// flow stops (Meta never called, signature refused, account not recognised, or processed). It never throws and never stores the message body.
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
const obj = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null);

function summarize(rawBody: string): { object: string; ids: string[]; fields: string[] } {
  let root: Row | null = null;
  try { root = obj(JSON.parse(rawBody)); } catch { root = null; }
  const ids: string[] = []; const fields: string[] = [];
  const entries = Array.isArray(root?.['entry']) ? (root?.['entry'] as unknown[]) : [];
  for (const raw of entries) {
    const entry = obj(raw); if (!entry) continue;
    if (typeof entry['id'] === 'string') ids.push(entry['id']);
    if (typeof entry['field'] === 'string') fields.push(entry['field']);
    if (Array.isArray(entry['changes'])) for (const change of entry['changes'] as unknown[]) { const field = obj(change)?.['field']; if (typeof field === 'string') fields.push(field); }
  }
  return { object: typeof root?.['object'] === 'string' ? root['object'] : 'desconhecido', ids, fields: [...new Set(fields)] };
}

function resultOf(method: string, status: number): string {
  if (method === 'GET') return status === 200 ? 'Verificação do webhook aceita (o token confere).' : 'Verificação do webhook recusada: o token de verificação não confere com META_WEBHOOK_VERIFY_TOKEN.';
  if (status === 200) return 'Notificação recebida e processada.';
  if (status === 401) return 'Notificação recusada: a assinatura não confere com o segredo do app salvo aqui.';
  if (status === 400) return 'Notificação recusada: conteúdo inválido.';
  return `Notificação recebida com resposta ${status}.`;
}

export async function traceWebhook(db: SupabaseClient, p: { method: string; rawBody: string; status: number }): Promise<void> {
  try {
    const seen = p.method === 'POST' ? summarize(p.rawBody) : { object: 'verificacao', ids: [] as string[], fields: [] as string[] };
    let userId: string | null = null; let recognised = false;
    for (const igUserId of seen.ids) {
      const { data } = await db.from('instagram_accounts').select('user_id').eq('ig_user_id', igUserId).limit(1).maybeSingle();
      const found = (data as Row | null)?.['user_id'];
      if (typeof found === 'string') { userId = found; recognised = true; break; }
    }
    if (!userId) {
      const { data } = await db.from('instagram_accounts').select('user_id').order('created_at', { ascending: true }).limit(1).maybeSingle();
      const first = (data as Row | null)?.['user_id'];
      if (typeof first === 'string') userId = first;
    }
    if (!userId) return;
    await db.from('activity_log').insert({
      user_id: userId, action: 'Webhook da Meta', result: resultOf(p.method, p.status),
      details: { metodo: p.method, status: p.status, objeto: seen.object, campos: seen.fields, ids_recebidos: seen.ids, conta_reconhecida: recognised },
    });
  } catch {
    // The trace must never break the webhook.
  }
}
