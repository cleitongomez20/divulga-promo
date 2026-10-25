import { supabase } from '@/integrations/supabase/client';

export async function createAccount(name: string, email: string, password: string, origin: string) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { name: name.trim() }, emailRedirectTo: origin },
  });
  if (error) throw error;
  return data;
}