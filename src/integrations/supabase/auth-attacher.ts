import { createMiddleware } from '@tanstack/react-start';
import { supabase } from './client';
export const attachSupabaseAuth = createMiddleware({ type: 'function' }).client(async ({ next }) => {
  const { data: { session } } = await supabase.auth.getSession();
  return next({ headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} });
});