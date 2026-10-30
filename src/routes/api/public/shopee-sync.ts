import { createFileRoute } from '@tanstack/react-router';

function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Scheduler entry point: only callers holding SHOPEE_SYNC_SECRET may run it. Returns counts only.
export const Route = createFileRoute('/api/public/shopee-sync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env['SHOPEE_SYNC_SECRET'];
        const given = request.headers.get('x-sync-token') ?? '';
        if (!secret || secret.length < 32) return new Response('Not configured', { status: 503 });
        if (!sameSecret(given, secret)) return new Response('Unauthorized', { status: 401 });
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const { runSyncTick } = await import('@/lib/shopee-sync.server');
        const { data } = await supabaseAdmin.from('marketplace_connections').select('user_id').eq('marketplace', 'shopee').not('credential_id', 'is', null).limit(25);
        const counts: Record<string, number> = {};
        for (const row of data ?? []) {
          const r = await runSyncTick(supabaseAdmin, row.user_id, false);
          counts[r.status] = (counts[r.status] ?? 0) + 1;
        }
        return Response.json({ ok: true, counts }, { headers: { 'Cache-Control': 'no-store' } });
      },
    },
  },
});
