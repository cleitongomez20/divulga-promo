import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), encrypt: vi.fn(async () => 'encrypted-only') }));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  const builder = { middleware: () => builder, inputValidator: () => builder, handler: (handler: unknown) => handler }; return builder;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/lib/connector-crypto.server', () => ({ encryptCredentials: mocks.encrypt }));
import { getConnections, saveShopeeCredentials, removeShopeeCredentials, testShopeeConnection } from '@/lib/connections.functions';
type Args = { context: { userId: string; supabase: unknown }; data?: unknown };
const invoke = (fn: unknown, args: Args) => (fn as (args: Args) => Promise<unknown>)(args);
function ownerClient(data: unknown) {
  const eq = vi.fn(() => chain); const chain = { select: vi.fn(() => chain), eq, maybeSingle: async () => ({ data, error: null }) };
  return { from: vi.fn(() => chain), eq };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CONNECTOR_ENCRYPTION_KEY', 'unit-test-key'); });
describe('Owner-scoped Shopee connections', () => {
  it('returns only safe metadata, never credentials or ciphertext', async () => {
    const client = ownerClient({ credential_id: 'private-row', status: 'saved', last_synced_at: null });
    expect(await invoke(getConnections, { context: { userId: 'owner', supabase: client } })).toEqual({ hasCredentials: true, status: 'saved', lastTestAt: null });
    expect(client.eq).toHaveBeenCalledWith('user_id', 'owner'); expect(client.eq).toHaveBeenCalledWith('marketplace', 'shopee');
  });
  it('saves encrypted credentials bound to the authenticated owner only', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ error: null });
    const data = { appId: '123456', secret: 'demo' };
    expect(await invoke(saveShopeeCredentials, { context: { userId: 'owner', supabase: {} }, data })).toEqual({ ok: true });
    expect(mocks.encrypt).toHaveBeenCalledWith(data, 'unit-test-key', 'owner');
    expect(mocks.rpc).toHaveBeenLastCalledWith('shopee_store_credentials', { p_user_id: 'owner', p_ciphertext: 'encrypted-only' });
  });
  it('removes only the authenticated owner credentials', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ error: null });
    await invoke(removeShopeeCredentials, { context: { userId: 'owner', supabase: {} } });
    expect(mocks.rpc).toHaveBeenCalledWith('shopee_remove_credentials', { p_user_id: 'owner' });
  });
  it('no credentials produces an explicitly simulated result and audit', async () => {
    const client = ownerClient(null); const insert = vi.fn(async () => ({ error: null }));
    mocks.rpc.mockResolvedValueOnce({ data: 0, error: null }); mocks.from.mockReturnValue({ insert });
    expect(await invoke(testShopeeConnection, { context: { userId: 'owner', supabase: client } })).toMatchObject({ status: 'simulated', simulated: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'owner', details: { simulated: true, errors: [] } }));
    expect(mocks.from).not.toHaveBeenCalledWith('connector_secrets');
  });
});