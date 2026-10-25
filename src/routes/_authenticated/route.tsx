import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';
export const Route = createFileRoute('/_authenticated')({ ssr: false, beforeLoad: async () => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw redirect({ to: '/auth' });
}, component: Outlet });