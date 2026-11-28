import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { LoaderCircle, MessageCircle, QrCode, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { disconnectWhatsApp, getWhatsAppStatus, refreshWhatsAppStatus, startWhatsAppConnection, type WhatsAppResult, type WhatsAppSnapshot } from '@/lib/whatsapp.functions';

const POLL_MS = 4000; // pergunta ao servidor se já conectou
const QR_EVERY = 6; // a cada 6 perguntas (cerca de 24 s) pede um QR novo
const MAX_TICKS = 75; // desiste depois de uns 5 minutos

export function WhatsAppCard() {
  const queryClient = useQueryClient();
  const { data: saved, isLoading } = useQuery({ queryKey: ['whatsapp'], queryFn: () => getWhatsAppStatus(), staleTime: 0 });
  const start = useServerFn(startWhatsAppConnection); const refresh = useServerFn(refreshWhatsAppStatus); const disconnect = useServerFn(disconnectWhatsApp);
  const [live, setLive] = useState<WhatsAppSnapshot | null>(null);
  const [busy, setBusy] = useState(''); const [notice, setNotice] = useState(''); const [confirmRemove, setConfirmRemove] = useState(false);
  const snap = live ?? saved;
  const connection = snap?.connection ?? 'disconnected';

  function apply(result: WhatsAppResult) {
    if (!result.ok) { setNotice(result.message); return false; }
    setLive(prev => ({ ...result.snapshot, qr: result.snapshot.qr ?? (result.snapshot.connection === 'waiting_qr' ? prev?.qr ?? null : null) }));
    return true;
  }
  async function act(name: string, work: () => Promise<WhatsAppResult>, done?: string) {
    setBusy(name); setNotice('');
    try { if (apply(await work()) && done) setNotice(done); }
    catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); await queryClient.invalidateQueries({ queryKey: ['whatsapp'] }); }
  }

  // Enquanto o QR está na tela, confere sozinho se o WhatsApp já foi conectado.
  useEffect(() => {
    if (connection !== 'waiting_qr') return;
    let stopped = false; let ticks = 0;
    const timer = setInterval(async () => {
      ticks += 1;
      if (ticks > MAX_TICKS) { setLive(prev => (prev ? { ...prev, connection: 'disconnected', qr: null } : prev)); setNotice('O QR code expirou. Clique em Conectar WhatsApp para gerar outro.'); clearInterval(timer); return; }
      try {
        const result = await refresh({ data: { wantQr: ticks % QR_EVERY === 0 } });
        if (stopped) return;
        if (apply(result) && result.ok && result.snapshot.connection === 'connected') { setNotice('WhatsApp conectado.'); await queryClient.invalidateQueries({ queryKey: ['whatsapp'] }); }
      } catch { /* tenta de novo na próxima volta */ }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const label = isLoading ? 'Carregando...' : connection === 'connected' ? 'Conectado' : connection === 'waiting_qr' ? 'Aguardando leitura do QR' : 'Não conectado';
  return <section className="rounded-lg border bg-card p-5 sm:p-7" aria-labelledby="whatsapp-title">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><MessageCircle className="size-7 text-primary" /><h2 id="whatsapp-title" className="text-xl font-semibold">WhatsApp (grupos de ofertas)</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{label}</span></div>
    <p className="mt-3 text-sm text-muted-foreground">Conecte um número dedicado, como no WhatsApp Web, para o Divulga Promo postar as ofertas nos seus grupos. Evite usar o seu número pessoal.</p>

    {snap && !snap.configured && <p role="status" className="mt-5 border-l-4 border-primary bg-accent p-3 text-sm text-accent-foreground">O servidor do WhatsApp ainda não foi configurado no app. Cadastre os segredos EVOLUTION_API_URL e EVOLUTION_API_KEY e publique de novo.</p>}

    {connection === 'disconnected' && <div className="mt-6"><Button disabled={Boolean(busy) || (snap ? !snap.configured : true)} onClick={() => act('start', () => start())}>{busy === 'start' ? <LoaderCircle className="animate-spin" /> : <QrCode />}Conectar WhatsApp</Button></div>}

    {connection === 'waiting_qr' && <div className="mt-6 space-y-4">
      {snap?.qr ? <img src={snap.qr} alt="QR code para conectar o WhatsApp" className="size-64 max-w-full rounded-lg border bg-white p-2" /> : <div className="flex size-64 max-w-full items-center justify-center rounded-lg border text-sm text-muted-foreground"><LoaderCircle className="mr-2 animate-spin" />Gerando o QR code...</div>}
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>No celular do número dedicado, abra o WhatsApp.</li>
        <li>Toque em Aparelhos conectados e depois em Conectar aparelho.</li>
        <li>Aponte a câmera para este QR code. Ele se renova sozinho.</li>
      </ol>
      <Button variant="ghost" disabled={Boolean(busy)} onClick={() => act('cancel', () => disconnect(), 'Conexão cancelada.')}><X />Cancelar</Button>
    </div>}

    {connection === 'connected' && <div className="mt-6 space-y-4">
      <div className="text-sm"><p className="font-medium">{snap?.profileName ?? 'WhatsApp conectado'}</p>{snap?.phoneMasked && <p className="text-muted-foreground">Número {snap.phoneMasked}</p>}{snap?.connectedAt && <p className="text-xs text-muted-foreground">Conectado em {new Date(snap.connectedAt).toLocaleString('pt-BR')}</p>}</div>
      {!confirmRemove ? <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}><Trash2 />Desconectar</Button>
        : <div><p className="text-sm">Desconectar o WhatsApp? As postagens nos grupos vão parar.</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => { setConfirmRemove(false); void act('remove', () => disconnect(), 'WhatsApp desconectado.'); }}>{busy === 'remove' && <LoaderCircle className="animate-spin" />}Sim, desconectar</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRemove(false)}>Cancelar</Button></div></div>}
    </div>}

    {notice && <p role="status" className="mt-5 break-words text-sm leading-relaxed">{notice}</p>}
  </section>;
}
