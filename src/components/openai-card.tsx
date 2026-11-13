import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Brain, LoaderCircle, PlugZap, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { connectOpenAi, getAiProvider, getOpenAiStatus, removeOpenAi, setAiProvider, testOpenAi, updateOpenAiSettings } from '@/lib/openai.functions';
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL, connectOpenAiSchema, openAiSettingsSchema, type OpenAiModelId } from '@/lib/openai';
import { capMicros, formatUsd } from '@/lib/claude';

/** Empty field means no limit. */
const capValue = (text: string): number | null => (text.trim() === '' ? null : Number(text.replace(',', '.')));

export function OpenAiCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['openai'], queryFn: () => getOpenAiStatus(), staleTime: 0 });
  const { data: provider } = useQuery({ queryKey: ['ai-provider'], queryFn: () => getAiProvider(), staleTime: 0 });
  const connect = useServerFn(connectOpenAi); const test = useServerFn(testOpenAi); const update = useServerFn(updateOpenAiSettings); const remove = useServerFn(removeOpenAi); const choose = useServerFn(setAiProvider);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState<OpenAiModelId>(DEFAULT_OPENAI_MODEL);
  const [cap, setCap] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  // Shows what is saved in the fields once the status arrives.
  useEffect(() => {
    if (!status?.connected) return;
    setModel((OPENAI_MODELS.find(item => item.id === status.model)?.id ?? DEFAULT_OPENAI_MODEL) as OpenAiModelId);
    setCap(status.monthlyCapCents === null ? '' : String(status.monthlyCapCents / 100));
  }, [status?.connected, status?.model, status?.monthlyCapCents]);

  async function act(name: string, work: () => Promise<{ status: string; message?: string }>) {
    setBusy(name); setNotice('');
    try {
      const result = await work();
      setNotice(result.message ?? (result.status === 'ok' ? 'Pronto.' : 'Não foi possível concluir agora.'));
      if (result.status === 'ok') { setApiKey(''); setReplacing(false); setConfirmRemove(false); }
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); await Promise.all([queryClient.invalidateQueries({ queryKey: ['openai'] }), queryClient.invalidateQueries({ queryKey: ['ai-provider'] }), queryClient.invalidateQueries({ queryKey: ['posts'] })]); }
  }
  function submitConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = connectOpenAiSchema.safeParse({ apiKey, model, monthlyCapUsd: capValue(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    setApiKey(''); // the key is never kept in the screen after sending
    void act('connect', () => connect({ data: sent }));
  }
  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = openAiSettingsSchema.safeParse({ model, monthlyCapUsd: capValue(cap) });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    const sent = parsed.data;
    void act('settings', () => update({ data: sent }));
  }

  const connected = Boolean(status?.connected);
  const showKeyForm = !connected || replacing;
  const spent = status?.spentMicros ?? 0; const hasCap = status?.monthlyCapCents !== null && status?.monthlyCapCents !== undefined; const limit = capMicros(status?.monthlyCapCents ?? 0);
  const percent = hasCap && limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const label = !connected ? 'Não conectada' : status?.status === 'invalid' ? 'Chave recusada' : 'Conectada';
  const active = provider?.active ?? 'anthropic';

  return <section className="rounded-lg border bg-card p-5 sm:p-7" aria-labelledby="openai-title">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><Brain className="size-7 text-primary" /><h2 id="openai-title" className="text-xl font-semibold">OpenAI (IA)</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{isLoading ? 'Carregando...' : label}</span></div>
    <p className="mt-3 text-sm text-muted-foreground">Vai substituir o Claude como cérebro do conteúdo. Enquanto você não trocar, o Claude continua criando tudo. A chave fica guardada protegida e nunca volta para a tela.</p>

    {connected && <div className="mt-5 rounded-md border bg-muted/40 p-4">
      <p className="text-sm font-medium">IA que cria o conteúdo agora: {active === 'openai' ? 'OpenAI' : 'Claude'}</p>
      <p className="mt-1 text-xs text-muted-foreground">Você pode voltar ao Claude a qualquer momento, desde que ele continue conectado.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {active === 'openai'
          ? <Button variant="outline" disabled={Boolean(busy) || !provider?.claudeConnected} onClick={() => void act('provider', () => choose({ data: { provider: 'anthropic' } }))}>{busy === 'provider' ? <LoaderCircle className="animate-spin" /> : null}Voltar para o Claude</Button>
          : <Button disabled={Boolean(busy) || status?.status !== 'connected'} onClick={() => void act('provider', () => choose({ data: { provider: 'openai' } }))}>{busy === 'provider' ? <LoaderCircle className="animate-spin" /> : null}Usar a OpenAI</Button>}
      </div>
    </div>}

    {showKeyForm
      ? <form onSubmit={submitConnect} className="mt-6 space-y-5">
        <div><label className="form-label" htmlFor="openai-key">Chave de API da OpenAI</label>
          <PasswordInput id="openai-key" required autoComplete="off" maxLength={300} value={apiKey} disabled={Boolean(busy)} resetKey={replacing} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." />
          <p className="mt-2 text-xs text-muted-foreground">Crie em platform.openai.com, em API keys. A conta precisa ter saldo.</p></div>
        <ModelAndCap model={model} cap={cap} setModel={setModel} setCap={setCap} disabled={Boolean(busy)} />
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={Boolean(busy)}>{busy === 'connect' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Conectar e testar</Button>
          {replacing && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(false); setApiKey(''); }}>Cancelar</Button>}</div>
      </form>
      : <form onSubmit={submitSettings} className="mt-6 space-y-5">
        <ModelAndCap model={model} cap={cap} setModel={setModel} setCap={setCap} disabled={Boolean(busy)} />
        <div>
          <div className="flex items-baseline justify-between text-sm"><span>Gasto estimado neste mês</span><span className="font-medium">{hasCap ? `${formatUsd(spent)} de ${formatUsd(limit)}` : `${formatUsd(spent)} (sem teto)`}</span></div>
          {hasCap && <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className={`h-full ${percent >= 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${percent}%` }} /></div>}
          <p className="mt-2 text-xs text-muted-foreground">Estimativa pelo preço de tabela. A cobrança oficial é a da plataforma da OpenAI.</p>
        </div>
        <Button type="submit" disabled={Boolean(busy)}>{busy === 'settings' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar ajustes</Button>
      </form>}

    {connected && !showKeyForm && <div className="mt-7 flex flex-wrap gap-3 border-t pt-6">
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => void act('test', () => test())}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Testar conexão</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => { setReplacing(true); setNotice(''); }}>Trocar chave</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}><Trash2 />Remover</Button>
    </div>}
    {confirmRemove && <div className="mt-5 border-t pt-5"><p className="text-sm">Remover a chave da OpenAI? {active === 'openai' ? 'O conteúdo volta a ser criado pelo Claude.' : 'O Claude continua criando o conteúdo.'}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={() => void act('remove', () => remove())}>{busy === 'remove' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Sim, remover</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmRemove(false)}>Cancelar</Button></div></div>}
    {status?.lastTestedAt && <p className="mt-5 text-xs text-muted-foreground">Último teste: {new Date(status.lastTestedAt).toLocaleString('pt-BR')}</p>}
    {status?.connected && status.lastError && <p className="mt-2 text-xs font-medium text-destructive">{status.lastError}</p>}
    {notice && <p role="status" className="mt-5 break-words text-sm leading-relaxed">{notice}</p>}
  </section>;
}

function ModelAndCap(props: { model: OpenAiModelId; cap: string; setModel: (value: OpenAiModelId) => void; setCap: (value: string) => void; disabled: boolean }) {
  return <>
    <div><label className="form-label" htmlFor="openai-model">Modelo</label>
      <select id="openai-model" className="field" value={props.model} disabled={props.disabled} onChange={e => props.setModel(e.target.value as OpenAiModelId)}>
        {OPENAI_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></div>
    <div><label className="form-label" htmlFor="openai-cap">Teto de gasto por mês (US$), opcional</label>
      <input id="openai-cap" className="field" inputMode="decimal" placeholder="Sem limite" value={props.cap} disabled={props.disabled} onChange={e => props.setCap(e.target.value)} />
      <p className="mt-2 text-xs text-muted-foreground">Deixe vazio para não ter limite. Se preencher, é uma trava do app: ao atingir esse valor estimado, a OpenAI para de ser chamada até o mês virar ou você mudar o teto.</p></div>
  </>;
}