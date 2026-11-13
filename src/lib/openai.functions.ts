import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { centsOfUsd } from './claude';
import { AI_PROVIDER_LABELS, aiProviderSchema, connectOpenAiSchema, openAiErrorMessage, openAiSettingsSchema, type AiProvider } from './openai';
import type { OpenAiStatusData } from './openai.server';

export type OpenAiStatus = OpenAiStatusData;
export type OpenAiActionResult = { status: 'ok'; message?: string } | { status: 'error'; message: string };
export type AiProviderView = { active: AiProvider; claudeConnected: boolean; openaiConnected: boolean };

const STORAGE_UNAVAILABLE = 'O armazenamento seguro ainda não está disponível.';
const masterKey = () => {
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) throw new Error(STORAGE_UNAVAILABLE);
  return key;
};
// The generated database types do not know the new AI tables yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
/** Spacing between actions for one user, so the buttons cannot be hammered. */
async function tooSoon(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `openai-edit:${userId}`, p_interval_ms: 3000 });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const failure = async (error: unknown): Promise<OpenAiActionResult> => {
  const { OpenAiError } = await import('./openai.server');
  if (error instanceof OpenAiError) return { status: 'error', message: openAiErrorMessage(error.kind, error.detail) };
  return { status: 'error', message: error instanceof Error && error.message === STORAGE_UNAVAILABLE ? error.message : 'Não foi possível concluir agora. Tente de novo.' };
};
const log = (db: SupabaseClient, userId: string, action: string, result: string) => db.from('activity_log').insert({ user_id: userId, action, result, details: {} });
const capText = (usd: number | null) => (usd === null ? 'sem teto de gasto' : `teto mensal de US$ ${usd}`);

export const getOpenAiStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<OpenAiStatus> => {
  const { loadOpenAiStatus } = await import('./openai.server');
  return loadOpenAiStatus(await admin(), context.userId, Date.now());
});

/** Which AI creates the content now, and which ones are connected. */
export const getAiProvider = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<AiProviderView> => {
  const { activeProviderOf, providerConnected } = await import('./ai.server');
  const db = await admin();
  const [active, claudeConnected, openaiConnected] = await Promise.all([activeProviderOf(db, context.userId), providerConnected(db, context.userId, 'anthropic'), providerConnected(db, context.userId, 'openai')]);
  return { active, claudeConnected, openaiConnected };
});

/** The key is checked with a real (tiny) call first; it is saved only when OpenAI accepts it. */
export const connectOpenAi = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => connectOpenAiSchema.parse(input)).handler(async ({ context, data }): Promise<OpenAiActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { connectOpenAiKey } = await import('./openai.server');
      await connectOpenAiKey(db, { userId: context.userId, masterKey: masterKey(), apiKey: data.apiKey, model: data.model, capCents: data.monthlyCapUsd === null ? null : centsOfUsd(data.monthlyCapUsd) });
      await log(db, context.userId, 'OpenAI conectada', `Modelo ${data.model}, ${capText(data.monthlyCapUsd)}`);
      return { status: 'ok', message: 'OpenAI conectada e testada com sucesso. O Claude continua sendo a IA ativa até você trocar.' };
    } catch (error) { return failure(error); }
  });

export const testOpenAi = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<OpenAiActionResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { testStoredOpenAi } = await import('./openai.server');
    await testStoredOpenAi(db, { userId: context.userId, masterKey: masterKey() });
    return { status: 'ok', message: 'A OpenAI respondeu. A conexão está funcionando.' };
  } catch (error) { return failure(error); }
});

export const updateOpenAiSettings = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => openAiSettingsSchema.parse(input)).handler(async ({ context, data }): Promise<OpenAiActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { data: changed, error } = await db.from('openai_connections').update({ model: data.model, monthly_cap_cents: data.monthlyCapUsd === null ? null : centsOfUsd(data.monthlyCapUsd) }).eq('user_id', context.userId).select('id');
      if (error) return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: openAiErrorMessage('not_connected') };
      await log(db, context.userId, 'Ajustes da OpenAI salvos', `Modelo ${data.model}, ${capText(data.monthlyCapUsd)}`);
      return { status: 'ok', message: 'Ajustes salvos.' };
    } catch (error) { return failure(error); }
  });

/** Removing the key of the AI that is active first hands the work back to Claude, so the app is never left without an AI. */
export const removeOpenAi = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<OpenAiActionResult> => {
  try {
    const db = await admin();
    const { activeProviderOf } = await import('./ai.server');
    if ((await activeProviderOf(db, context.userId)) === 'openai') await db.from('ai_settings').upsert({ user_id: context.userId, active_provider: 'anthropic' }, { onConflict: 'user_id' });
    const { removeOpenAiConnection } = await import('./openai.server');
    await removeOpenAiConnection(db, context.userId);
    await log(db, context.userId, 'OpenAI desconectada', 'Chave removida');
    return { status: 'ok', message: 'OpenAI desconectada e a chave foi apagada. O conteúdo volta a ser criado pelo Claude.' };
  } catch (error) { return failure(error); }
});

/** Chooses which AI creates the content. Switching back and forth is always possible while both are connected. */
export const setAiProvider = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => aiProviderSchema.parse(input)).handler(async ({ context, data }): Promise<OpenAiActionResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, context.userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const { switchProvider } = await import('./ai.server');
      const result = await switchProvider(db, context.userId, data.provider);
      if (!result.ok) return { status: 'error', message: result.message };
      await log(db, context.userId, 'IA ativa trocada', `Agora o conteúdo é criado pela ${AI_PROVIDER_LABELS[data.provider]}`);
      return { status: 'ok', message: `Agora o conteúdo é criado pela ${AI_PROVIDER_LABELS[data.provider]}.` };
    } catch (error) { return failure(error); }
  });