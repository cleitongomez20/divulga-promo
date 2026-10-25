import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ signInWithPassword: vi.fn(), insert: vi.fn(), from: vi.fn() }));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => ({ inputValidator: () => ({ handler: (handler: unknown) => handler }) }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { signInWithPassword: mocks.signInWithPassword } }) }));
vi.mock('@/integrations/supabase/client.server', () => ({ supabaseAdmin: { from: mocks.from } }));
import { passwordLogin } from '@/lib/password-login.functions';
const invoke = passwordLogin as unknown as (args: { data: { email: string; password: string } }) => Promise<unknown>;
describe('Server-observed password login', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.example'); vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'test-public-key');
    vi.clearAllMocks(); mocks.from.mockReturnValue({ insert: mocks.insert }); mocks.insert.mockResolvedValue({ error: null });
  });
  it('writes fixed access history for the authenticated user after password verification', async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { user: { id: 'verified-owner' }, session: { access_token: 'test-token', refresh_token: 'test-refresh' } }, error: null });
    await invoke({ data: { email: 'owner@example.com', password: 'test-password' } });
    expect(mocks.from).toHaveBeenCalledWith('activity_log');
    expect(mocks.insert).toHaveBeenCalledWith({ user_id: 'verified-owner', action: 'Acesso confirmado', result: 'Sucesso' });
    const verificationOrder = mocks.signInWithPassword.mock.invocationCallOrder[0];
    const auditOrder = mocks.insert.mock.invocationCallOrder[0];
    if (verificationOrder === undefined || auditOrder === undefined) throw new Error('Expected both password verification and audit recording');
    expect(verificationOrder).toBeLessThan(auditOrder);
  });
  it('does not write history for rejected credentials and conceals provider details', async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: new Error('Email does not exist') });
    await expect(invoke({ data: { email: 'owner@example.com', password: 'bad-password' } })).rejects.toThrow('Não foi possível entrar. Confira seus dados ou tente novamente em alguns minutos.');
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('does not release session tokens when audit recording fails', async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { user: { id: 'verified-owner' }, session: { access_token: 'test-token', refresh_token: 'test-refresh' } }, error: null });
    mocks.insert.mockResolvedValue({ error: new Error('Unavailable') });
    await expect(invoke({ data: { email: 'owner@example.com', password: 'test-password' } })).rejects.toThrow('Não foi possível concluir o acesso.');
  });
});