import { createFileRoute } from '@tanstack/react-router';

function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Scheduler entry point: only callers holding PUBLISH_CRON_SECRET may run it. Returns counts only, never post or account data.
async function handle(request: Request) {
  const secret = process.env['PUBLISH_CRON_SECRET'];
  const given = request.headers.get('x-cron-token') ?? '';
  if (!secret || secret.length < 32) return new Response('Not configured', { status: 503 });
  if (!sameSecret(given, secret)) return new Response('Unauthorized', { status: 401 });
  const masterKey = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!masterKey) return new Response('Not configured', { status: 503 });
  try {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { runPublishTick } = await import('@/lib/publisher.server');
    const counts = await runPublishTick(supabaseAdmin as never, { masterKey });
    // Videos being made at Higgsfield are followed on the same visit; a problem there never stops the publishing above.
    let videos: unknown = null;
    try { const { advanceVideoJobs } = await import('@/lib/video-jobs.server'); videos = await advanceVideoJobs(supabaseAdmin as never, { masterKey }); } catch { videos = null; }
    return Response.json({ ok: true, counts, videos }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const Route = createFileRoute('/api/public/publish-due')({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) } },
});
