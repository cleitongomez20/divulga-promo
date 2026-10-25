import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccount } from '@/lib/account-signup';

const { signUp } = vi.hoisted(() => ({ signUp: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signUp } } }));

describe('Account creation', () => {
  beforeEach(() => signUp.mockReset());

  it('creates credentials and profile metadata with the same-origin confirmation URL', async () => {
    signUp.mockResolvedValue({ data: { user: { id: 'owner' }, session: null }, error: null });
    const result = await createAccount(' Cleiton ', ' cleiton@example.com ', 'secure-password', 'https://divulga.example');
    expect(signUp).toHaveBeenCalledWith({ email: 'cleiton@example.com', password: 'secure-password', options: { data: { name: 'Cleiton' }, emailRedirectTo: 'https://divulga.example' } });
    expect(result.session).toBeNull();
  });

  it('does not report success when the provider rejects signup', async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: new Error('Signups not allowed') });
    await expect(createAccount('Cleiton', 'cleiton@example.com', 'secure-password', 'https://divulga.example')).rejects.toThrow('Signups not allowed');
  });
});