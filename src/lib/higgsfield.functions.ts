import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { centsOfUsd } from './claude';
import { connectHiggsfieldSchema, higgsfieldErrorMessage, higgsfieldSettingsSchema } from './higgsfield';
import type { HiggsfieldStatusData } from './higgsfield.server';

export type HiggsfieldStatus = HiggsfieldStatusData;
export type HiggsfieldActionResult = { status: 'ok'; message?: string } | { status: 'error'; message: string };

const STORAGE_UNAVAILABLE = 'O armazenamento seguro ainda não está disponível.';
const masterKey = () => {
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error(STORAGE_UNAVAILABLE);
  return key;
};
// The generated database types do not know the media tables yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `higgsfield-edit:${userId}`, p_interval_ms: 3000 });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const failure = async (error: unknown): Promise<HiggsfieldActionResult> => {
  const { HiggsfieldError } = await import('./higgsfield.server');
  if (error instanceof HiggsfieldError) return { status: 'error', message: higgsfieldErrorMessage(error.kind, error.detail) };
  return { status: 'error', message: error instanceof Error && error.message === STORAGE_UNAVAILABLE ? error.message : 'Não foi possível concluir agora. Tente de novo.' };
};
const log = (db: SupabaseClient, userId: string, action: string, result: string) => db.from('activity_log').insert({ user_id: userId, action, result, details: {} });

export const getHiggsfieldStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<HiggsfieldStatus> => {
  const { loadHiggsfieldStatus } = await import('./higgsfield.server');
  return loadHiggsfieldStatus(await admin(), context.userId, Date.now());
});

/** The key is checked with a free call first; it is saved only when Higgsfield accepts it. */
export const connectHiggsfield = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => connectHiggsfieldSchema.parse(input)).handler(async ({ context, data }): Promise<HiggsfieldActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { connectHiggsfieldKey } = await import('./higgsfield.server');
      await connectHiggsfieldKey(db, { userId: context.userId, masterKey: masterKey(), keyId: data.keyId, keySecret: data.keySecret, capCents: centsOfUsd(data.monthlyCapUsd) });
      await log(db, context.userId, 'Higgsfield conectado', `Teto mensal de US$ ${data.monthlyCapUsd}`);
      return { status: 'ok', message: 'Higgsfield conectado. A chave foi aceita.' };
    } catch (error) { return failure(error); }
  });

export const testHiggsfield = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<HiggsfieldActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { testStoredHiggsfield } = await import('./higgsfield.server');
    await testStoredHiggsfield(db, { userId: context.userId, masterKey: masterKey() });
    return { status: 'ok', message: 'O Higgsfield aceitou a chave. A conexão está funcionando.' };
  } catch (error) { return failure(error); }
});

export const updateHiggsfieldSettings = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => higgsfieldSettingsSchema.parse(input)).handler(async ({ context, data }): Promise<HiggsfieldActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { data: changed, error } = await db.from('media_connections').update({ monthly_cap_cents: centsOfUsd(data.monthlyCapUsd) }).eq('user_id', context.userId).select('id');
      if (error) return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: higgsfieldErrorMessage('not_connected') };
      await log(db, context.userId, 'Ajustes do Higgsfield salvos', `Teto mensal de US$ ${data.monthlyCapUsd}`);
      return { status: 'ok', message: 'Ajustes salvos.' };
    } catch (error) { return failure(error); }
  });

export const removeHiggsfield = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<HiggsfieldActionResult> => {
  try {
    const db = await admin();
    const { removeHiggsfieldConnection } = await import('./higgsfield.server');
    await removeHiggsfieldConnection(db, context.userId);
    await log(db, context.userId, 'Higgsfield desconectado', 'Chave removida');
    return { status: 'ok', message: 'Higgsfield desconectado e a chave foi apagada.' };
  } catch (error) { return failure(error); }
});