import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

// The server observes the password exchange itself; callers cannot supply audit fields.
export const passwordLogin = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(4096) }))
  .handler(async ({ data }) => {
    const url = process.env['SUPABASE_URL'];
    const key = process.env['SUPABASE_PUBLISHABLE_KEY'];
    if (!url || !key) throw new Error('Não foi possível entrar. Tente novamente em alguns minutos.');
    const { createClient } = await import('@supabase/supabase-js');
    const authClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith('sb_') && headers.get('Authorization') === `Bearer ${key}`) headers.delete('Authorization');
        headers.set('apikey', key);
        return fetch(input, { ...init, headers });
      } },
    });
    const { data: login, error } = await authClient.auth.signInWithPassword(data);
    if (error || !login.session || !login.user) throw new Error('Não foi possível entrar. Confira seus dados ou tente novamente em alguns minutos.');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error: auditError } = await supabaseAdmin.from('activity_log').insert({ user_id: login.user.id, action: 'Acesso confirmado', result: 'Sucesso' });
    if (auditError) throw new Error('Não foi possível concluir o acesso. Tente novamente em alguns minutos.');
    return { access_token: login.session.access_token, refresh_token: login.session.refresh_token };
  });