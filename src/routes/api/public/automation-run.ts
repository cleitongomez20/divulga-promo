import { createFileRoute } from '@tanstack/react-router';

function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Second scheduler entry point, for the automation (ordering the day's videos, creating Stories). It is separate from the publishing visit so that
// the slower work of ordering a video can never delay a publication. Same secret and header as the publishing visit. Returns counts only.
async function handle(request: Request) {
  const secret = process.env['PUBLISH_CRON_SECRET'];
  const given = request.headers.get('x-cron-token') ?? '';
  if (!secret || secret.length < 32) return new Response('Not configured', { status: 503 });
  if (!sameSecret(given, secret)) return new Response('Unauthorized', { status: 401 });
  const masterKey = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!masterKey) return new Response('Not configured', { status: 503 });
  try {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { runAutomation } = await import('@/lib/automation.server');
    const { makeLinkFor } = await import('@/lib/shopee-link.server');
    const counts = await runAutomation(supabaseAdmin as never, { masterKey, makeLinkFor: userId => makeLinkFor(supabaseAdmin, supabaseAdmin as never, userId) });
    return Response.json({ ok: true, counts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const Route = createFileRoute('/api/public/automation-run')({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) } },
});