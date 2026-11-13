import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { capCentsOrNull, capText, claudeErrorMessage, claudeSettingsSchema, connectClaudeSchema } from './claude';
import type { ClaudeStatusData } from './claude.server';

export type ClaudeStatus = ClaudeStatusData;
export type ClaudeActionResult = { status: 'ok'; message?: string } | { status: 'error'; message: string };

const masterKey = () => {
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
  return key;
};
// The generated database types do not know the new AI tables yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: Awaited<ReturnType<typeof admin>>, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `claude-edit:${userId}`, p_interval_ms: 3000 });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const failure = async (error: unknown): Promise<ClaudeActionResult> => {
  const { ClaudeError } = await import('./claude.server');
  if (error instanceof ClaudeError) return { status: 'error', message: claudeErrorMessage(error.kind, error.detail) };
  return { status: 'error', message: error instanceof Error && error.message === 'O armazenamento seguro ainda não está disponível.' ? error.message : 'Não foi possível concluir agora. Tente de novo.' };
};
const log = (db: Awaited<ReturnType<typeof admin>>, userId: string, action: string, result: string) => db.from('activity_log').insert({ user_id: userId, action, result, details: {} });

export const getClaudeStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ClaudeStatus> => {
  const { loadClaudeStatus } = await import('./claude.server');
  return loadClaudeStatus(await admin(), context.userId, Date.now());
});

/** The key is checked with a real (tiny) call first; it is saved only when Claude accepts it. */
export const connectClaude = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => connectClaudeSchema.parse(input)).handler(async ({ context, data }): Promise<ClaudeActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { connectClaudeKey } = await import('./claude.server');
      await connectClaudeKey(db, { userId: context.userId, masterKey: masterKey(), apiKey: data.apiKey, model: data.model, capCents: capCentsOrNull(data.monthlyCapUsd) });
      await log(db, context.userId, 'Claude conectado', `Modelo ${data.model}, ${capText(data.monthlyCapUsd)}`);
      return { status: 'ok', message: 'Claude conectado e testado com sucesso.' };
    } catch (error) { return failure(error); }
  });

export const testClaude = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ClaudeActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { testStoredClaude } = await import('./claude.server');
    await testStoredClaude(db, { userId: context.userId, masterKey: masterKey() });
    return { status: 'ok', message: 'O Claude respondeu. A conexão está funcionando.' };
  } catch (error) { return failure(error); }
});

export const updateClaudeSettings = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => claudeSettingsSchema.parse(input)).handler(async ({ context, data }): Promise<ClaudeActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { data: changed, error } = await db.from('ai_connections').update({ model: data.model, monthly_cap_cents: capCentsOrNull(data.monthlyCapUsd) }).eq('user_id', context.userId).select('id');
      if (error) return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: claudeErrorMessage('not_connected') };
      await log(db, context.userId, 'Ajustes do Claude salvos', `Modelo ${data.model}, ${capText(data.monthlyCapUsd)}`);
      return { status: 'ok', message: 'Ajustes salvos.' };
    } catch (error) { return failure(error); }
  });

export const removeClaude = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ClaudeActionResult> => {
  try {
    const db = await admin();
    const { removeClaudeConnection } = await import('./claude.server');
    await removeClaudeConnection(db, context.userId);
    await log(db, context.userId, 'Claude desconectado', 'Chave removida');
    return { status: 'ok', message: 'Claude desconectado e a chave foi apagada.' };
  } catch (error) { return failure(error); }
});