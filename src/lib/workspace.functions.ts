import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { requiresAdminMfa, settingsSchema } from './foundation';

export const getWorkspace = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabase, userId, claims } = context;
  const { data: roles, error: roleError } = await supabase.from('user_roles').select('role').eq('user_id', userId);
  if (roleError || !roles?.length) throw new Error('Não foi possível confirmar o acesso à sua conta.');
  const isAdmin = roles.some(r => r.role === 'admin');
  const needsMfa = requiresAdminMfa(isAdmin, claims['aal']);
  if (needsMfa) return { needsMfa: true, isAdmin, profile: null, settings: null, logs: [] };
  const [profile, settings, logs] = await Promise.all([
    supabase.from('profiles').select('name,timezone').eq('id', userId).single(),
    supabase.from('settings').select('*').eq('user_id', userId).single(),
    supabase.from('activity_log').select('id,action,result,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ]);
  if (profile.error || settings.error || logs.error) throw new Error('Não foi possível carregar sua conta. Tente novamente.');
  return { needsMfa: false, isAdmin, profile: profile.data, settings: settings.data, logs: logs.data ?? [] };
});

export const saveSettings = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => settingsSchema.parse(input)).handler(async ({ context, data }) => {
    const { data: allowed, error: accessError } = await context.supabase.rpc('private_access');
    if (accessError || !allowed) throw new Error('Confirme seu código de segurança antes de continuar.');
    const { error } = await context.supabase.rpc('save_foundation_settings', { payload: data });
    if (error) throw new Error('Não foi possível salvar. Revise os valores e tente novamente.');
    return { ok: true };
  });

export const recordAccess = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data: allowed } = await context.supabase.rpc('private_access');
  if (!allowed) throw new Error('Confirme seu código de segurança.');
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data: recent } = await context.supabase.from('activity_log').select('id').eq('action', 'Acesso confirmado').gte('created_at', new Date(Date.now() - 300000).toISOString()).limit(1);
  if (recent?.length) return { ok: true };
  const { error } = await supabaseAdmin.from('activity_log').insert({ user_id: context.userId, action: 'Acesso confirmado', result: 'Sucesso' });
  if (error) throw new Error('Não foi possível registrar o acesso.');
  return { ok: true };
});