import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { LoaderCircle, PlugZap, Save, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { connectClaude, getClaudeStatus, removeClaude, testClaude, updateClaudeSettings } from '@/lib/claude.functions';
import { CLAUDE_MODELS, DEFAULT_MODEL, capMicros, capUsdFromText, claudeSettingsSchema, connectClaudeSchema, formatUsd, type ClaudeModelId } from '@/lib/claude';

export function ClaudeCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['claude'], queryFn: () => getClaudeStatus(), staleTime: 0 });
  const connect = useServerFn(connectClaude); const test = useServerFn(testClaude); const update = useServerFn(updateClaudeSettings); const remove = useServerFn(removeClaude);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState<ClaudeModelId>(DEFAULT_MODEL);
  const [cap, setCap] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  // Shows what is saved in the fields once the status arrives.
  useEffect(() => {
    if (!status?.connected) return;
    setModel((CLAUDE_MODELS.find(item => item.id === status.model)?.id ?? DEFAULT_MODEL) as ClaudeModelId);
    setCap(status.monthlyCapCents === null ? '' : String(status.monthlyCapCents / 100));
  }, [status?.connected, status?.model, status?.monthlyCapCents]);

  async function act(name: string, work: () => Promise<{ status: string; message?: string }>) {
    setBusy(name); setNotice('');
    try {
      const result = await work();
      setNotice(result.message ?? (result.status === 'ok' ? 'Pronto.' : 'Não foi possível concluir agora.'));
      if (result.status === 'ok') { setApiKey(''); setReplacing(false); setConfirmRemove(false); }
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); await queryClient.invalidateQueries({ queryKey: ['claude'] }); }
  }
  function submitConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = connectClaudeSchema.safeParse({ apiKey, model, monthlyCapUsd: capUsdFromText(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    setApiKey(''); // the key is never kept in the screen after sending
    void act('connect', () => connect({ data: sent }));
  }
  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = claudeSettingsSchema.safeParse({ model, monthlyCapUsd: capUsdFromText(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    void act('settings', () => update({ data: sent }));
  }

  const connected = Boolean(status?.connected);
  const showKeyForm = !connected || replacing;
  const spent = status?.spentMicros ?? 0; const hasCap = status?.monthlyCapCents !== null && status?.monthlyCapCents !== undefined; const limit = capMicros(status?.monthlyCapCents ?? 0);
  const percent = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const label = !connected ? 'Não conectado' : status?.status === 'invalid' ? 'Chave recusada' : 'Conectado';

  return <section className="rounded-lg border bg-card p-5 sm:p-7" aria-labelledby="claude-title">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><Sparkles className="size-7 text-primary" /><h2 id="claude-title" className="text-xl font-semibold">Claude (IA)</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{isLoading ? 'Carregando...' : label}</span></div>
    <p className="mt-3 text-sm text-muted-foreground">É o cérebro do conteúdo: escolhe o produto e escreve a legenda e o roteiro. A chave fica guardada protegida e nunca volta para a tela.</p>

    {showKeyForm
      ? <form onSubmit={submitConnect} className="mt-6 space-y-5">
        <div><label className="form-label" htmlFor="claude-key">Chave de API do Claude</label>
          <PasswordInput id="claude-key" required autoComplete="off" maxLength={300} value={apiKey} disabled={Boolean(busy)} resetKey={replacing} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-..." />
          <p className="mt-2 text-xs text-muted-foreground">Crie em platform.claude.com, em Settings, API keys. A conta precisa ter saldo.</p></div>
        <ModelAndCap model={model} cap={cap} setModel={setModel} setCap={setCap} disabled={Boolean(busy)} />
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={Boolean(busy)}>{busy === 'connect' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Conectar e testar</Button>
          {replacing && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(false); setApiKey(''); }}>Cancelar</Button>}</div>
      </form>
      : <form onSubmit={submitSettings} className="mt-6 space-y-5">
        <ModelAndCap model={model} cap={cap} setModel={setModel} setCap={setCap} disabled={Boolean(busy)} />
        <div>
          <div className="flex items-baseline justify-between text-sm"><span>Gasto estimado neste mês</span><span className="font-medium">{hasCap ? `${formatUsd(spent)} de ${formatUsd(limit)}` : `${formatUsd(spent)} (sem teto)`}</span></div>
          {hasCap && <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className={`h-full ${percent >= 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${percent}%` }} /></div>}
          <p className="mt-2 text-xs text-muted-foreground">Estimativa pelo preço de tabela. A cobrança oficial é a do Claude Console. Ao chegar no teto, o Claude para de ser chamado até você aumentar o valor ou o mês virar.</p>
        </div>
        <Button type="submit" disabled={Boolean(busy)}>{busy === 'settings' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar ajustes</Button>
      </form>}

    {connected && !showKeyForm && <div className="mt-7 flex flex-wrap gap-3 border-t pt-6">
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => void act('test', () => test())}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Testar conexão</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(true); setNotice(''); }}>Trocar chave</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}><Trash2 />Remover</Button>
    </div>}
    {confirmRemove && <div className="mt-5 border-t pt-5"><p className="text-sm">Remover a chave do Claude? A criação automática de conteúdo para de funcionar.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void act('remove', () => remove())}>{busy === 'remove' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Sim, remover</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(false)}>Cancelar</Button></div></div>}
    {status?.lastTestedAt && <p className="mt-5 text-xs text-muted-foreground">Último teste: {new Date(status.lastTestedAt).toLocaleString('pt-BR')}</p>}
    {status?.connected && status.lastError && <p className="mt-2 text-xs font-medium text-destructive">{status.lastError}</p>}
    {notice && <p role="status" className="mt-5 break-words text-sm leading-relaxed">{notice}</p>}
  </section>;
}

function ModelAndCap(props: { model: ClaudeModelId; cap: string; setModel: (value: ClaudeModelId) => void; setCap: (value: string) => void; disabled: boolean }) {
  return <>
    <div><label className="form-label" htmlFor="claude-model">Modelo</label>
      <select id="claude-model" className="field" value={props.model} disabled={props.disabled} onChange={e => props.setModel(e.target.value as ClaudeModelId)}>
        {CLAUDE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></div>
    <div><label className="form-label" htmlFor="claude-cap">Teto de gasto por mês (US$), opcional</label>
      <input id="claude-cap" className="field" inputMode="decimal" placeholder="Sem limite" value={props.cap} disabled={props.disabled} onChange={e => props.setCap(e.target.value)} />
      <p className="mt-2 text-xs text-muted-foreground">Deixe vazio para não ter limite. Se preencher, é uma trava do app: ao atingir esse valor estimado, o Claude para de ser chamado até o mês virar ou você mudar o teto.</p></div>
  </>;
}