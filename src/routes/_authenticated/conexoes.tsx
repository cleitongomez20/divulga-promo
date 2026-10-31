import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useState, type FormEvent } from 'react';
import { ShoppingBag, Instagram, Save, PlugZap, Trash2, RefreshCw, LoaderCircle, FlaskConical, Stethoscope } from 'lucide-react';
import { WorkspaceShell } from '@/components/workspace-shell';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { pageHead } from '@/lib/metadata';
import { connectionsQuery } from '@/lib/connections-query';
import { credentialsSchema } from '@/lib/connections-schema';
import { saveShopeeCredentials, removeShopeeCredentials, testShopeeConnection, runNetworkDiagnostic } from '@/lib/connections.functions';

export const Route = createFileRoute('/_authenticated/conexoes')({
  head: () => pageHead('Conexões', 'Cuide da sua conexão com a Shopee com segurança.'),
  loader: ({ context }) => context.queryClient.ensureQueryData(connectionsQuery), component: ConnectionsPage,
});
function ConnectionsPage() {
  const { data } = useSuspenseQuery(connectionsQuery); const queryClient = useQueryClient();
  const save = useServerFn(saveShopeeCredentials); const remove = useServerFn(removeShopeeCredentials); const test = useServerFn(testShopeeConnection); const diagnose = useServerFn(runNetworkDiagnostic);
  const [steps, setSteps] = useState<{ step: string; ok: boolean; elapsedMs: number; httpStatus?: number; summary: string }[]>([]);
  const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(''); const [message, setMessage] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false); const [appId, setAppId] = useState(''); const [secret, setSecret] = useState('');
  async function refresh() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['connections'] }), queryClient.invalidateQueries({ queryKey: ['workspace'] })]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const parsed = credentialsSchema.safeParse({ appId, secret });
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? 'Confira seus dados.'); return; }
    setBusy('save'); setMessage('');
    // Clear the editable secret immediately; never retain it after submitting.
    setSecret('');
    try { await save({ data: parsed.data }); setAppId(''); setEditing(false); await refresh(); setMessage('Credenciais salvas. Você já pode testar a conexão.'); }
    catch { setMessage('Não foi possível salvar. Confira os dados e tente novamente.'); } finally { setBusy(''); }
  }
  async function testConnection() { setBusy('test'); setMessage(''); try { const result = await test(); await refresh(); setMessage(`${result.message}. ${result.detail}`); } catch { setMessage('Não foi possível testar agora. Tente novamente mais tarde.'); } finally { setBusy(''); } }
  async function diagnostic() { setBusy('diag'); setMessage(''); setSteps([]); try { const r = await diagnose(); await refresh(); setSteps(r.steps); setMessage(`${r.message}. ${r.detail}`); } catch { setMessage('Não foi possível rodar o diagnóstico agora.'); } finally { setBusy(''); } }
  async function removeConnection() { setBusy('remove'); setMessage(''); try { await remove(); setConfirmRemove(false); setEditing(false); setAppId(''); setSecret(''); await refresh(); setMessage('Conexão removida.'); } catch { setMessage('Não foi possível remover. Tente novamente.'); } finally { setBusy(''); } }
  const status = !data.hasCredentials ? 'Não conectada' : data.status === 'connected' ? 'Conectado' : data.status === 'invalid_credentials' ? 'Confira as credenciais' : data.status === 'temporary_error' ? 'Teste não concluído' : data.status === 'awaiting_access' ? 'Aguardando liberação' : data.status === 'account_problem' ? 'Problema na conta de afiliado' : 'Aguardando teste';
  return <WorkspaceShell><p className="text-xs font-semibold uppercase tracking-widest text-primary">Suas contas</p><h1 className="mt-3 text-3xl font-bold">Conexões</h1>
    {!data.hasCredentials && <div role="status" className="mt-6 flex items-center gap-3 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground"><FlaskConical className="size-5 shrink-0" />Modo de teste (dados simulados)</div>}
    <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
      <section className="rounded-lg border bg-card p-5 sm:p-7" aria-labelledby="shopee-title">
        <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><ShoppingBag className="size-7 text-primary" /><h2 id="shopee-title" className="text-xl font-semibold">Shopee</h2></div><span className="text-right text-sm text-muted-foreground">{status}</span></div>
        {data.hasCredentials && !editing ? <div className="mt-7 space-y-5">{data.maskedAppId && <div><label className="form-label" htmlFor="saved-app-id">AppId salvo</label><input id="saved-app-id" className="field" value={data.maskedAppId} readOnly /></div>}<div><label className="form-label" htmlFor="saved-secret">Secret salvo</label><input id="saved-secret" className="field" value="••••••••" readOnly aria-label="Secret salvo e protegido" /></div><Button variant="outline" disabled={Boolean(busy)} onClick={() => { setEditing(true); setMessage(''); }}><RefreshCw />Substituir credenciais</Button></div> : <form className="mt-7 space-y-5" onSubmit={submit}>
          <div><label className="form-label" htmlFor="shopee-app-id">AppId</label><input id="shopee-app-id" className="field" inputMode="numeric" autoComplete="off" required maxLength={64} pattern="[0-9]+" value={appId} disabled={Boolean(busy)} onChange={e => setAppId(e.target.value)} /></div>
          <div><label className="form-label" htmlFor="shopee-secret">Secret</label><PasswordInput id="shopee-secret" required autoComplete="off" maxLength={2048} value={secret} disabled={Boolean(busy)} resetKey={editing} onChange={e => setSecret(e.target.value)} /></div>
          <div className="flex flex-wrap gap-3"><Button type="submit" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar credenciais</Button>{data.hasCredentials && <Button variant="ghost" type="button" disabled={Boolean(busy)} onClick={() => { setEditing(false); setAppId(''); setSecret(''); }}>Cancelar</Button>}</div>
        </form>}
        <div className="mt-7 flex flex-wrap gap-3 border-t pt-6"><Button variant="outline" disabled={Boolean(busy) || editing} onClick={testConnection}>{busy === 'test' ? <LoaderCircle className="animate-spin" /> : <PlugZap />}Testar conexão</Button><Button variant="outline" disabled={Boolean(busy) || editing} onClick={diagnostic}>{busy === 'diag' ? <LoaderCircle className="animate-spin" /> : <Stethoscope />}Diagnóstico de rede</Button>{data.hasCredentials && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}><Trash2 />Remover</Button>}</div>
        {confirmRemove && <div className="mt-5 border-t pt-5"><p className="text-sm">Remover as credenciais da Shopee?</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="destructive" disabled={Boolean(busy)} onClick={removeConnection}>Sim, remover</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirmRemove(false)}>Cancelar</Button></div></div>}
        {data.lastTestAt && <p className="mt-5 text-xs text-muted-foreground">Último teste: {new Date(data.lastTestAt).toLocaleString('pt-BR')}</p>}
        {message && <p role="status" className="mt-5 break-words text-sm leading-relaxed">{message}</p>}
        {steps.length > 0 && <ol className="mt-4 space-y-3 border-t pt-4 text-sm">{steps.map(st => <li key={st.step}><p className="font-semibold">{st.ok ? '✓' : '✗'} {st.step} <span className="font-normal text-muted-foreground">({st.elapsedMs} ms{st.httpStatus ? ` · HTTP ${st.httpStatus}` : ''})</span></p><pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{st.summary}</pre></li>)}</ol>}
      </section>
      <section className="rounded-lg border bg-card p-5 sm:p-7"><div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><Instagram className="size-7 text-muted-foreground" /><h2 className="text-xl font-semibold">Instagram</h2></div><span className="text-sm text-muted-foreground">Em breve</span></div></section>
    </div>
  </WorkspaceShell>;
}