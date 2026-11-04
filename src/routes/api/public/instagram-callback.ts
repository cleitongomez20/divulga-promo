import { createFileRoute } from '@tanstack/react-router';
import { CALLBACK_URL } from '@/lib/instagram';

// The Instagram sends the user back here after the authorization window. There is no login session in this request,
// so the user is identified by the signed "state" created when the connection started (valid for 15 minutes).
export const Route = createFileRoute('/api/public/instagram-callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const back = (query: string) => new Response(null, { status: 302, headers: { Location: `/conexoes?${query}`, 'Cache-Control': 'no-store' } });
        const masterKey = process.env['CONNECTOR_ENCRYPTION_KEY'];
        if (!masterKey) return back('instagram=erro&motivo=salvar');
        const { verifyState, completeInstagramLogin } = await import('@/lib/instagram.server');
        const userId = await verifyState(url.searchParams.get('state') ?? '', masterKey);
        if (!userId) return back('instagram=erro&motivo=estado');
        if (url.searchParams.get('error')) return back('instagram=erro&motivo=negado');
        const code = url.searchParams.get('code');
        if (!code) return back('instagram=erro&motivo=troca');
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const result = await completeInstagramLogin({ admin: supabaseAdmin, userId, masterKey, code, redirectUri: CALLBACK_URL });
        return back(result.ok ? 'instagram=ok' : `instagram=erro&motivo=${result.code}`);
      },
    },
  },
});