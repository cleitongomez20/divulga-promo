import { describe, expect, it, vi } from 'vitest';
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  const builder = { middleware: () => builder, inputValidator: () => builder, handler: (handler: unknown) => handler }; return builder;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
import { getWorkspace } from '@/lib/workspace.functions';
const invoke = getWorkspace as unknown as (args: { context: unknown }) => Promise<{ isAdmin: boolean; profile: unknown }>;
describe('Authenticated access without second factor by owner decision', () => {
  it.each(['admin', 'user'])('loads private workspace for %s with aal1, ignoring any enrolled factor', async role => {
    const profile = { name: 'Owner', timezone: 'America/Sao_Paulo' };
    const client = { from: (table: string) => {
      const result = { data: table === 'user_roles' ? [{ role }] : table === 'profiles' ? profile : table === 'settings' ? { timezone: 'America/Sao_Paulo' } : [], error: null };
      const chain = { select: () => chain, eq: () => chain, order: () => chain, single: async () => result, limit: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) }; return chain;
    } };
    const result = await invoke({ context: { supabase: client, userId: 'owner', claims: { aal: 'aal1' } } });
    expect(result.profile).toEqual(profile);
    expect(result.isAdmin).toBe(role === 'admin');
  });
});