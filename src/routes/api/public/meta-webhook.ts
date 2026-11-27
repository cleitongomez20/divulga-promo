import { createFileRoute } from '@tanstack/react-router';

// Where Meta sends the comments of the connected Instagram accounts. Meta checks this address once (GET) and then sends every comment (POST).
// Every notification is believed only if it is signed with the app secret of the account's owner; the work itself is in comment-reply.server.ts.
// Each call leaves a trace in the activity log (comment-reply.trace.server.ts) so a silent failure can be located.
async function handle(request: Request) {
  const masterKey = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!masterKey) return new Response('Not configured', { status: 503 });
  try {
    const rawBody = request.method === 'POST' ? await request.text() : '';
    if (rawBody.length > 1_000_000) return new Response('Too large', { status: 413 });
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { handleWebhookRequest } = await import('@/lib/comment-reply.server');
    const result = await handleWebhookRequest(supabaseAdmin as never, {
      method: request.method, query: new URL(request.url).searchParams, signature: request.headers.get('x-hub-signature-256'), rawBody, verifyToken: process.env['META_WEBHOOK_VERIFY_TOKEN'], masterKey,
    });
    try {
      const { traceWebhook } = await import('@/lib/comment-reply.trace.server');
      await traceWebhook(supabaseAdmin as never, { method: request.method, rawBody, status: result.status });
    } catch {
      // The trace is only a diagnostic aid.
    }
    return new Response(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch {
    return new Response('Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const Route = createFileRoute('/api/public/meta-webhook')({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) } },
});
