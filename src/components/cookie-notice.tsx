import { useEffect, useState } from 'react';
import { Cookie } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { COOKIE_NOTICE_KEY } from '@/lib/legal';

const read = () => { try { return window.localStorage.getItem(COOKIE_NOTICE_KEY); } catch { return 'unavailable'; } };

/** Notice about the browser storage the app uses. Only what is needed to work is used (login session, menu state), so there is one button. */
export function CookieNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setVisible(read() === null); }, []);
  if (!visible) return null;
  const accept = () => { try { window.localStorage.setItem(COOKIE_NOTICE_KEY, new Date().toISOString()); } catch { /* storage blocked: the notice just shows again next time */ } setVisible(false); };
  return <div role="dialog" aria-label="Aviso de cookies" aria-live="polite" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-lg border bg-card p-4 shadow-lg sm:p-5">
    <div className="flex items-start gap-3">
      <Cookie className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Usamos só o necessário</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Guardamos no seu navegador apenas a sessão do seu acesso e o estado do menu. Não usamos cookies de publicidade nem de análise. <a href="/privacidade#cookies" className="font-medium text-primary underline">Saiba mais</a></p>
        <div className="mt-3"><Button type="button" size="sm" onClick={accept}>Entendi</Button></div>
      </div>
    </div>
  </div>;
}
