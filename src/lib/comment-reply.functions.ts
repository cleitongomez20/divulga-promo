import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { PUBLIC_ORIGIN } from './instagram';
import { WEBHOOK_PATH, outcomeMessage, replySettingsSchema } from './comment-reply';
import type { ReplyView, SetupCheck } from './comment-reply.server';

export type ReplyStatus = ReplyView & { webhookUrl: string; verifyTokenConfigured: boolean };
export type ReplyActionResult = { status: 'ok'; message: string } | { status: 'error'; message: string };
export type ReplyCheckResult = { status: 'ok'; check: SetupCheck } | { status: 'error'; message: string };

const STORAGE_UNAVAILABLE = 'O armazenamento seguro ainda não está disponível.';
// The generated database types do not know the comment reply table yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
const masterKey = () => { const key = process.env['CONNECTOR_ENCRYPTION_KEY']; if (!key) throw new Error(STORAGE_UNAVAILABLE); return key; };
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `reply-edit:${userId}`, p_interval_ms: 3000 });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const explain = async (error: unknown): Promise<string> => {
  const { ReplyError } = await import('./comment-reply.server');
  const { InstagramError } = await import('./instagram.server');
  if (error instanceof ReplyError) return error.outcome === 'invalid' ? 'Não consegui concluir. Confira se a conexão com o Instagram tem uma Página ligada.' : outcomeMessage(error.outcome);
  if (error instanceof InstagramError) return 'A conexão com o Instagram expirou. Reconecte na tela Conexões.';
  return error instanceof Error && error.message === STORAGE_UNAVAILABLE ? error.message : 'Não foi possível concluir agora. Tente de novo.';
};

export const getReplyStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ReplyStatus> => {
  const { loadReplyView } = await import('./comment-reply.server');
  const view = await loadReplyView(await admin(), context.userId);
  return { ...view, webhookUrl: `${PUBLIC_ORIGIN}${WEBHOOK_PATH}`, verifyTokenConfigured: Boolean(process.env['META_WEBHOOK_VERIFY_TOKEN']) };
});

export const saveReplySettingsFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => replySettingsSchema.parse(input)).handler(async ({ context, data }): Promise<ReplyActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { saveReplySettings } = await import('./comment-reply.server');
      if (!(await saveReplySettings(db, context.userId, data))) return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' };
      await db.from('activity_log').insert({ user_id: context.userId, action: data.enabled ? 'Resposta automática ligada' : 'Resposta automática desligada', result: data.enabled ? 'Link enviado por mensagem a quem comenta' : 'Desligada pelo usuário', details: {} });
      return { status: 'ok', message: data.enabled ? 'Resposta automática ligada.' : 'Resposta automática desligada.' };
    } catch (error) { return { status: 'error', message: await explain(error) }; }
  });

export const checkReplySetupFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ReplyCheckResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { checkReplySetup } = await import('./comment-reply.server');
    return { status: 'ok', check: await checkReplySetup(db, { userId: context.userId, masterKey: masterKey() }) };
  } catch (error) { return { status: 'error', message: await explain(error) }; }
});

// Manual test: reads the latest comments from the Instagram API (no webhook needed), queues the ones with the trigger and sends the replies.
export const syncCommentsFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ReplyActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { syncRecentComments } = await import('./comment-reply.sync.server');
    const r = await syncRecentComments(db, { userId: context.userId, masterKey: masterKey() });
    if (r.problem) return { status: 'error', message: r.problem };
    const sent = r.send?.sent ?? 0; const failed = r.send?.failed ?? 0; const waiting = r.send?.waiting ?? 0;
    const head = `Publicações verificadas: ${r.posts}${r.skipped ? ` (${r.skipped} de outra conta, ignoradas)` : ''}. Comentários lidos: ${r.comments}, das últimas 2 horas: ${r.recent}, com o gatilho: ${r.matched}.`;
    if (!r.matched) return { status: 'ok', message: `${head} Nenhum comentário novo com "EU QUERO" de outra conta nas últimas 2 horas.` };
    if (!r.queued && !sent && !failed && !waiting) return { status: 'ok', message: `${head} Esses comentários já tinham sido registrados antes. Veja o resultado na lista abaixo.` };
    return { status: 'ok', message: `${head} Enviadas: ${sent}, falharam: ${failed}, na espera: ${waiting}. O motivo de cada falha aparece na lista abaixo.` };
  } catch (error) { return { status: 'error', message: await explain(error) }; }
});

export const subscribeCommentsFn = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ReplyActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { subscribeComments } = await import('./comment-reply.server');
    await subscribeComments(db, { userId: context.userId, masterKey: masterKey() });
    return { status: 'ok', message: 'Pedido enviado à Meta. Clique em "Verificar configuração" para confirmar.' };
  } catch (error) { return { status: 'error', message: await explain(error) }; }
});
