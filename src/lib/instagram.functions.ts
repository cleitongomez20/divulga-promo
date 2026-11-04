import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { CALLBACK_URL, META_APP_ID, META_CONFIG_ID, instagramSecretSchema, instagramErrorMessage } from './instagram';

export type InstagramStatus = {
  appConfigured: boolean; redirectUri: string;
  account: { username: string | null; expired: boolean } | null;
};
export type ActionResult = { status: 'ok'; message?: string } | { status: 'error'; message: string };

const masterKey = () => {
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
  return key;
};
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin; }
const failure = async (error: unknown): Promise<ActionResult> => {
  const { InstagramError } = await import('./instagram.server');
  return { status: 'error', message: error instanceof InstagramError ? `${instagramErrorMessage(error.code)}${error.code === 'salvar' ? ` (etapa: ${error.detail.step})` : ''}` : error instanceof Error && error.message ? error.message : 'Não foi possível concluir agora. Tente de novo.' };
};
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: Awaited<ReturnType<typeof admin>>, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `instagram-edit:${userId}`, p_interval_ms: 3000 });
  // Only a real "wait" answer (a positive number of milliseconds) blocks. If the spacing check itself fails, the action goes ahead.
  if (error) return false;
  return typeof data === 'number' && data > 0;
}

export const getInstagramStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<InstagramStatus> => {
  const db = await admin();
  const server = await import('./instagram.server');
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  let appConfigured = false;
  if (key) { try { appConfigured = (await server.loadAppCredentials(db, context.userId, key)) !== null; } catch { appConfigured = false; } }
  const account = await server.loadAccount(db, context.userId);
  return { appConfigured, redirectUri: CALLBACK_URL, account: account ? { username: account.username, expired: account.status === 'expired' } : null };
});

/** The app id and the login configuration are fixed in the code; only the secret key is typed and kept sealed. */
export const saveInstagramSecret = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => instagramSecretSchema.parse(input)).handler(async ({ context, data }): Promise<ActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { saveAppCredentials } = await import('./instagram.server');
      await saveAppCredentials(db, context.userId, masterKey(), { appId: META_APP_ID, appSecret: data.appSecret, configId: META_CONFIG_ID });
      await db.from('activity_log').insert({ user_id: context.userId, action: 'App da Meta salvo', result: 'Chave secreta do app da Meta salva', details: {} });
      return { status: 'ok', message: 'Chave secreta salva.' };
    } catch (error) { return failure(error); }
  });

export const startInstagramLogin = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<{ status: 'ok'; url: string } | { status: 'error'; message: string }> => {
  try {
    const db = await admin(); const key = masterKey();
    const server = await import('./instagram.server');
    const app = await server.loadAppCredentials(db, context.userId, key);
    if (!app) return { status: 'error', message: instagramErrorMessage('app') };
    const state = await server.signState(context.userId, key);
    return { status: 'ok', url: server.buildAuthorizeUrl({ appId: META_APP_ID, configId: META_CONFIG_ID, redirectUri: CALLBACK_URL, state }) };
  } catch (error) { const result = await failure(error); return { status: 'error', message: result.status === 'error' ? result.message : '' }; }
});

export const checkInstagramConnection = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { checkAccount, InstagramError } = await import('./instagram.server');
    try {
      const { username } = await checkAccount(db, context.userId, masterKey());
      await db.from('activity_log').insert({ user_id: context.userId, action: 'Teste do Instagram', result: 'Conexão funcionando', details: {} });
      return { status: 'ok', message: username ? `Conexão funcionando com @${username}.` : 'Conexão funcionando.' };
    } catch (error) {
      if (error instanceof InstagramError) await db.from('activity_log').insert({ user_id: context.userId, action: 'Teste do Instagram', result: `Falha: ${error.code}`, details: error.detail as never });
      throw error;
    }
  } catch (error) { return failure(error); }
});

export const disconnectInstagram = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ActionResult> => {
  try {
    const db = await admin();
    const { disconnectAccount } = await import('./instagram.server');
    await disconnectAccount(db, context.userId);
    await db.from('activity_log').insert({ user_id: context.userId, action: 'Instagram desconectado', result: 'Conta desconectada', details: {} });
    return { status: 'ok', message: 'Instagram desconectado.' };
  } catch (error) { return failure(error); }
});

export const removeInstagramApp = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ActionResult> => {
  try {
    const db = await admin();
    const { removeAppCredentials } = await import('./instagram.server');
    await removeAppCredentials(db, context.userId);
    await db.from('activity_log').insert({ user_id: context.userId, action: 'App da Meta removido', result: 'Dados do app removidos', details: {} });
    return { status: 'ok', message: 'Dados do app removidos.' };
  } catch (error) { return failure(error); }
});