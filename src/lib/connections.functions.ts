import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { credentialsSchema } from './connections-schema';

export const getConnections = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data, error } = await context.supabase.from('marketplace_connections').select('status,credential_id,last_synced_at').eq('user_id', context.userId).eq('marketplace', 'shopee').maybeSingle();
  if (error) throw new Error('Não foi possível carregar suas conexões.');
  return { hasCredentials: Boolean(data?.credential_id), status: data?.status ?? 'disconnected', lastTestAt: data?.last_synced_at ?? null };
});

export const saveShopeeCredentials = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => credentialsSchema.parse(input)).handler(async ({ context, data }) => {
    const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
    if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: pause, error: rateError } = await supabaseAdmin.rpc('reserve_connector_slot', { p_scope: `shopee-edit:${context.userId}`, p_interval_ms: 3000 });
    if (rateError || pause !== 0) throw new Error('Aguarde um pouco antes de salvar novamente.');
    const { encryptCredentials } = await import('./connector-crypto.server');
    const ciphertext = await encryptCredentials(data, key, context.userId);
    const { error } = await supabaseAdmin.rpc('shopee_store_credentials', { p_user_id: context.userId, p_ciphertext: ciphertext });
    if (error) throw new Error('Não foi possível salvar a conexão. Tente novamente.');
    return { ok: true };
  });

export const removeShopeeCredentials = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { error } = await supabaseAdmin.rpc('shopee_remove_credentials', { p_user_id: context.userId });
  if (error) throw new Error('Não foi possível remover a conexão.');
  return { ok: true };
});

export const testShopeeConnection = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  // Ownership is checked through RLS before the privileged credential store is touched.
  const { data: connection, error: readError } = await context.supabase.from('marketplace_connections').select('credential_id').eq('user_id', context.userId).eq('marketplace', 'shopee').maybeSingle();
  if (readError) throw new Error('Não foi possível carregar sua conexão.');
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data: pause, error: rateError } = await supabaseAdmin.rpc('reserve_connector_slot', { p_scope: `shopee-test:${context.userId}`, p_interval_ms: 60000 });
  if (rateError || pause !== 0) return { status: 'temporary_error', message: 'Erro temporário, tente de novo', detail: 'Aguarde um minuto antes de testar novamente.', simulated: !connection?.credential_id };
  const { ShopeeConnector, SimulatedMarketplaceConnector } = await import('./shopee.server');
  const credentialId = connection?.credential_id ?? null;
  let status = 'simulated'; let message = 'Modo de teste (dados simulados)'; let detail = 'Teste simulado concluído.';
  let errors: { message: string; path: (string | number)[]; extensions: { code: number; message: string } }[] = [];
  if (credentialId) {
    const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
    if (!key) throw new Error('O armazenamento seguro ainda não está disponível.');
    const { data: stored, error: secretError } = await supabaseAdmin.from('connector_secrets').select('ciphertext,key_version').eq('id', credentialId).eq('user_id', context.userId).single();
    if (secretError || !stored || stored.key_version !== 1) throw new Error('Não foi possível abrir a conexão. Salve suas credenciais novamente.');
    const { decryptCredentials } = await import('./connector-crypto.server');
    let credentials;
    try { credentials = await decryptCredentials(stored.ciphertext, key, context.userId); }
    catch { throw new Error('Não foi possível abrir a conexão. Salve suas credenciais novamente.'); }
    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const client = new ShopeeConnector(credentials, {
      acquire: async () => {
        for (let i = 0; i < 3; i++) {
          const { data: delay, error } = await supabaseAdmin.rpc('reserve_connector_slot', { p_scope: 'shopee', p_interval_ms: 3000 });
          if (error || delay == null || delay > 15000) return false;
          if (delay === 0) return true;
          await wait(delay);
        }
        return false;
      },
      slowDown: async () => { const { error } = await supabaseAdmin.rpc('slow_shopee_requests'); if (error) throw new Error('Não foi possível aplicar a pausa de segurança.'); },
    });
    const result = await client.testConnection();
    if (result.ok) { status = 'connected'; message = 'Conectado'; detail = 'A Shopee confirmou o acesso.'; }
    else { errors = result.errors; status = result.invalidCredentials ? 'invalid_credentials' : 'temporary_error'; message = result.invalidCredentials ? 'Credenciais inválidas ou ainda não liberadas' : 'Erro temporário, tente de novo'; detail = result.message; }
  } else await new SimulatedMarketplaceConnector().testConnection();
  const { error: auditError } = await supabaseAdmin.rpc('shopee_record_test', { p_user_id: context.userId, p_credential_id: credentialId, p_status: status, p_result: message, p_details: { simulated: !credentialId, errors } });
  if (auditError) throw new Error('O teste terminou, mas não foi possível registrar o resultado. Tente novamente mais tarde.');
  return { status, message, detail, simulated: !credentialId };
});