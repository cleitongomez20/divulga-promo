import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { settingsSchema } from './foundation';

export const getWorkspace = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { supabase, userId } = context;
  const { data: roles, error: roleError } = await supabase.from('user_roles').select('role').eq('user_id', userId);
  if (roleError) throw new Error('Não foi possível confirmar o acesso à sua conta.');
  const isAdmin = roles?.some(r => r.role === 'admin') ?? false;
  const [profile, settings, logs] = await Promise.all([
    supabase.from('profiles').select('name,timezone').eq('id', userId).single(),
    supabase.from('settings').select('*').eq('user_id', userId).single(),
    supabase.from('activity_log').select('id,action,result,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
  ]);
  if (profile.error || settings.error || logs.error) throw new Error('Não foi possível carregar sua conta. Tente novamente.');
  return { isAdmin, profile: profile.data, settings: settings.data, logs: logs.data ?? [] };
});

export const saveSettings = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => settingsSchema.parse(input)).handler(async ({ context, data }) => {
    const { data: allowed, error: accessError } = await context.supabase.rpc('private_access');
    if (accessError || !allowed) throw new Error('Entre na sua conta antes de continuar.');
    const { error } = await context.supabase.rpc('save_foundation_settings', { payload: data });
    if (error) throw new Error('Não foi possível salvar. Revise os valores e tente novamente.');
    return { ok: true };
  });
