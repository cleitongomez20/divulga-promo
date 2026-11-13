import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Clapperboard, LoaderCircle, PlugZap, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { connectHiggsfield, getHiggsfieldStatus, removeHiggsfield, testHiggsfield, updateHiggsfieldSettings } from '@/lib/higgsfield.functions';
import { connectHiggsfieldSchema, higgsfieldSettingsSchema } from '@/lib/higgsfield';
import { capMicros, capUsdFromText, formatUsd } from '@/lib/claude';

export function HiggsfieldCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['higgsfield'], queryFn: () => getHiggsfieldStatus(), staleTime: 0 });
  const connect = useServerFn(connectHiggsfield); const test = useServerFn(testHiggsfield); const update = useServerFn(updateHiggsfieldSettings); const remove = useServerFn(removeHiggsfield);
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [cap, setCap] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  // Shows what is saved in the fields once the status arrives.
  useEffect(() => { if (status?.connected) setCap(status.monthlyCapCents === null ? '' : String(status.monthlyCapCents / 100)); }, [status?.connected, status?.monthlyCapCents]);

  async function act(name: string, work: () => Promise<{ status: string; message?: string }>) {
    setBusy(name); setNotice('');
    try {
      const result = await work();
      setNotice(result.message ?? (result.status === 'ok' ? 'Pronto.' : 'Não foi possível concluir agora.'));
      if (result.status === 'ok') { setKeyId(''); setKeySecret(''); setReplacing(false); setConfirmRemove(false); }
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); await queryClient.invalidateQueries({ queryKey: ['higgsfield'] }); }
  }
  function submitConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = connectHiggsfieldSchema.safeParse({ keyId, keySecret, monthlyCapUsd: capUsdFromText(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    setKeyId(''); setKeySecret(''); // the key is never kept on the screen after sending
    void act('connect', () => connect({ data: sent }));
  }
  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: capUsdFromText(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    void act('settings', () => update({ data: sent }));
  }

  const connected = Boolean(status?.connected);
  const showKeyForm = !connected || replacing;
  const spent = status?.spentMicros ?? 0; const hasCap = status?.monthlyCapCents !== null && status?.monthlyCapCents !== undefined; const limit = capMicros(status?.monthlyCapCents ?? 0);
  const percent = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const label = !connected ? 'Não conectado' : status?.status === 'invalid' ? 'Chave recusada' : 'Conectado';

  return <section className="rounded-lg border bg-card p-5 sm:p-7" aria-labelledby="higgsfield-title">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><Clapperboard className="size-7 text-primary" /><h2 id="higgsfield-title" className="text-xl font-semibold">Higgsfield (imagens e vídeos)</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{isLoading ? 'Carregando...' : label}</span></div>
    <p className="mt-3 text-sm text-muted-foreground">Cria as imagens do carrossel e os vídeos que a IA pede. A chave fica guardada protegida e nunca volta para a tela.</p>

    {showKeyForm
      ? <form onSubmit={submitConnect} className="mt-6 space-y-5">
        <div><label className="form-label" htmlFor="hf-key-id">ID da chave</label>
          <input id="hf-key-id" className="field" required autoComplete="off" spellCheck={false} maxLength={300} value={keyId} disabled={Boolean(busy)} onChange={e => setKeyId(e.target.value)} /></div>
        <div><label className="form-label" htmlFor="hf-key-secret">Segredo da chave</label>
          <PasswordInput id="hf-key-secret" required autoComplete="off" maxLength={300} value={keySecret} disabled={Boolean(busy)} resetKey={replacing} onChange={e => setKeySecret(e.target.value)} />
          <p className="mt-2 text-xs text-muted-foreground">Crie a chave em console.higgsfield.ai. É uma conta separada do site, com saldo próprio. Os dois valores aparecem juntos na criação da chave.</p></div>
        <CapField cap={cap} setCap={setCap} disabled={Boolean(busy)} />
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={Boolean(busy)}>{busy === 'connect' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Conectar e testar</Button>
          {replacing && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(false); setKeyId(''); setKeySecret(''); }}>Cancelar</Button>}</div>
      </form>
      : <form onSubmit={submitSettings} className="mt-6 space-y-5">
        <CapField cap={cap} setCap={setCap} disabled={Boolean(busy)} />
        <div>
          <div className="flex items-baseline justify-between text-sm"><span>Gasto estimado neste mês</span><span className="font-medium">{hasCap ? `${formatUsd(spent)} de ${formatUsd(limit)}` : `${formatUsd(spent)} (sem teto)`}</span></div>
          {hasCap && <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className={`h-full ${percent >= 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${percent}%` }} /></div>}
          <p className="mt-2 text-xs text-muted-foreground">Estimativa. O valor real de cada geração e o seu saldo estão no Console do Higgsfield. Quando a estimativa chegar no teto, as gerações param até você aumentar o valor ou o mês virar.</p>
        </div>
        <Button type="submit" disabled={Boolean(busy)}>{busy === 'settings' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar ajustes</Button>
      </form>}

    {connected && !showKeyForm && <div className="mt-7 flex flex-wrap gap-3 border-t pt-6">
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => void act('test', () => test())}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Testar conexão</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(true); setNotice(''); }}>Trocar chave</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}><Trash2 />Remover</Button>
    </div>}
    {confirmRemove && <div className="mt-5 border-t pt-5"><p className="text-sm">Remover a chave do Higgsfield? A criação de imagens e vídeos para de funcionar.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void act('remove', () => remove())}>{busy === 'remove' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Sim, remover</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(false)}>Cancelar</Button></div></div>}
    {status?.lastTestedAt && <p className="mt-5 text-xs text-muted-foreground">Último teste: {new Date(status.lastTestedAt).toLocaleString('pt-BR')}</p>}
    {status?.connected && status.lastError && <p className="mt-2 text-xs font-medium text-destructive">{status.lastError}</p>}
    {notice && <p role="status" className="mt-5 break-words text-sm leading-relaxed">{notice}</p>}
  </section>;
}

function CapField(props: { cap: string; setCap: (value: string) => void; disabled: boolean }) {
  return <div><label className="form-label" htmlFor="hf-cap">Teto de gasto por mês (US$), opcional</label>
    <input id="hf-cap" className="field" inputMode="decimal" placeholder="Sem limite" value={props.cap} disabled={props.disabled} onChange={e => props.setCap(e.target.value)} />
    <p className="mt-2 text-xs text-muted-foreground">Deixe vazio para não ter limite. Se preencher, é uma trava do app: ao atingir esse valor estimado, o app para de pedir imagens e vídeos até o mês virar ou você mudar o teto.</p></div>;
}