import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { CALLBACK_PATH, instagramAppSchema, instagramErrorMessage, maskId } from './instagram';

export type InstagramStatus = {
  appConfigured: boolean; maskedAppId: string | null; configId: string | null; redirectUri: string;
  account: { username: string | null; expired: boolean } | null;
};
export type ActionResult = { status: 'ok'; message?: string } | { status: 'error'; message: string };

const masterKey = () => {
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
  return key;
};
async function origin() {
  const { getRequest } = await import('@tanstack/react-start/server');
  return new URL(getRequest().url).origin;
}
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin; }
const failure = async (error: unknown): Promise<ActionResult> => {
  const { InstagramError } = await import('./instagram.server');
  return { status: 'error', message: error instanceof InstagramError ? instagramErrorMessage(error.code) : error instanceof Error && error.message ? error.message : 'Não foi possível concluir agora. Tente de novo.' };
};
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: Awaited<ReturnType<typeof admin>>, userId: string) {
  const { data } = await db.rpc('reserve_connector_slot', { p_scope: `instagram-edit:${userId}`, p_interval_ms: 3000 });
  return data !== 0;
}

export const getInstagramStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<InstagramStatus> => {
  const db = await admin();
  const server = await import('./instagram.server');
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  let maskedAppId: string | null = null; let configId: string | null = null;
  if (key) {
    try { const app = await server.loadAppCredentials(db, context.userId, key); maskedAppId = app ? maskId(app.appId) : null; configId = app ? app.configId : null; } catch { maskedAppId = null; }
  }
  const account = await server.loadAccount(db, context.userId);
  return {
    appConfigured: maskedAppId !== null, maskedAppId, configId, redirectUri: `${await origin()}${CALLBACK_PATH}`,
    account: account ? { username: account.username, expired: account.status === 'expired' } : null,
  };
});

export const saveInstagramApp = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => instagramAppSchema.parse(input)).handler(async ({ context, data }): Promise<ActionResult> => {
    try {
      const db = await admin();
      if (!(await tooSoon(db, context.userId))) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { saveAppCredentials } = await import('./instagram.server');
      await saveAppCredentials(db, context.userId, masterKey(), data);
      await db.from('activity_log').insert({ user_id: context.userId, action: 'App da Meta salvo', result: 'Dados do app da Meta salvos', details: {} });
      return { status: 'ok', message: 'Dados do app salvos.' };
    } catch (error) { return failure(error); }
  });

export const startInstagramLogin = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<{ status: 'ok'; url: string } | { status: 'error'; message: string }> => {
  try {
    const db = await admin(); const key = masterKey();
    const server = await import('./instagram.server');
    const app = await server.loadAppCredentials(db, context.userId, key);
    if (!app) return { status: 'error', message: instagramErrorMessage('app') };
    const state = await server.signState(context.userId, key);
    return { status: 'ok', url: server.buildAuthorizeUrl({ appId: app.appId, configId: app.configId, redirectUri: `${await origin()}${CALLBACK_PATH}`, state }) };
  } catch (error) { const result = await failure(error); return { status: 'error', message: result.status === 'error' ? result.message : '' }; }
});

export const checkInstagramConnection = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<ActionResult> => {
  try {
    const db = await admin();
    if (!(await tooSoon(db, context.userId))) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
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