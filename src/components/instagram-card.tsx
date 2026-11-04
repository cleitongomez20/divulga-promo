import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Instagram, Copy, Check, LoaderCircle, Trash2, Link2, Save, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { getInstagramStatus, saveInstagramApp, startInstagramLogin, checkInstagramConnection, disconnectInstagram, removeInstagramApp } from '@/lib/instagram.functions';
import { instagramAppSchema, instagramErrorMessage } from '@/lib/instagram';

const fieldClass = 'h-11 w-full rounded-md border bg-background px-3 text-base';

export function InstagramCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['instagram'], queryFn: () => getInstagramStatus(), staleTime: 0 });
  const save = useServerFn(saveInstagramApp);
  const start = useServerFn(startInstagramLogin);
  const check = useServerFn(checkInstagramConnection);
  const disconnect = useServerFn(disconnectInstagram);
  const removeApp = useServerFn(removeInstagramApp);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [configId, setConfigId] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  // Message left by the return from the login window (the address is cleaned afterwards).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('instagram');
    if (!result) return;
    setNotice(result === 'ok' ? 'Instagram conectado com sucesso.' : instagramErrorMessage(params.get('motivo')));
    window.history.replaceState(null, '', window.location.pathname);
    void queryClient.invalidateQueries({ queryKey: ['instagram'] });
  }, [queryClient]);

  async function act(name: string, work: () => Promise<{ status: string; message?: string }>) {
    setBusy(name); setNotice('');
    try {
      const result = await work();
      if (result.message) setNotice(result.message);
      await queryClient.invalidateQueries({ queryKey: ['instagram'] });
      return result.status === 'ok';
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); return false; }
    finally { setBusy(''); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = instagramAppSchema.safeParse({ appId, appSecret, configId });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    if (await act('save', () => save({ data: parsed.data }))) { setAppId(''); setAppSecret(''); setConfigId(''); setEditing(false); }
  }
  async function connect() {
    setBusy('connect'); setNotice('');
    try {
      const result = await start();
      if (result.status === 'ok') { window.location.assign(result.url); return; }
      setNotice(result.message);
    } catch { setNotice('Não foi possível iniciar a conexão agora. Tente de novo.'); }
    setBusy('');
  }
  async function copyRedirect() {
    if (!status) return;
    try { await navigator.clipboard.writeText(status.redirectUri); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setNotice('Não foi possível copiar sozinho. Selecione o endereço e copie manualmente.'); }
  }

  const account = status?.account ?? null;
  const showForm = Boolean(status) && (!status?.appConfigured || editing);
  const label = account ? (account.expired ? 'Precisa conectar de novo' : 'Conectado') : status?.appConfigured ? 'Pronto para conectar' : 'Falta configurar';

  return <section aria-labelledby="instagram-title" className="rounded-lg border bg-card p-5 sm:p-7">
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3"><Instagram className="size-7 text-muted-foreground" /><h2 id="instagram-title" className="text-xl font-semibold">Instagram</h2></div>
      <span className="text-sm text-muted-foreground">{isLoading ? 'Carregando...' : label}</span>
    </div>

    {account && <div className="mt-6 space-y-1 text-sm">
      <p className="font-medium">{account.username ? `@${account.username}` : 'Conta conectada'}</p>
      <p className="text-muted-foreground">{account.expired ? 'O acesso deixou de valer. Conecte de novo.' : 'Este acesso não tem prazo de validade. Se um dia parar de funcionar, o app avisa e você conecta de novo.'}</p>
    </div>}

    {showForm && status && <div className="mt-6 space-y-5">
      <details className="rounded-md border p-4 text-sm" open={!status.appConfigured}>
        <summary className="cursor-pointer font-medium">Como preparar o app na Meta (passo a passo)</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>Em <a className="underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">developers.facebook.com</a>, abra o seu app e vá em <strong>Configurações do app &gt; Básico</strong>. Copie o <strong>ID do app</strong> e a <strong>Chave secreta do app</strong> (clique em Mostrar).</li>
          <li>Vá em <strong>Casos de uso</strong>, abra <strong>Gerenciar mensagens e conteúdo no Instagram &gt; Personalizar</strong> e entre em <strong>Configuração da API com login unificado</strong>.</li>
          <li>Crie uma <strong>configuração de login</strong> com as permissões <strong>instagram_basic</strong> e <strong>instagram_content_publish</strong>. Copie o <strong>ID da configuração</strong>.</li>
          <li>Cadastre o endereço abaixo como <strong>URI de redirecionamento OAuth válido</strong>.</li>
          <li>O Instagram precisa ser <strong>profissional</strong>. <strong>Não é preciso Página do Facebook.</strong> Na tela da Meta, entre com Instagram ou Facebook, selecione o <strong>portfólio empresarial</strong> e a <strong>conta do Instagram</strong> a compartilhar e aprove as permissões.</li>
        </ol>
        <p className="mt-3 font-medium">Endereço de retorno (URI de redirecionamento)</p>
        <div className="mt-1 flex gap-2"><input readOnly value={status.redirectUri} aria-label="Endereço de retorno" onFocus={e => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" /><Button type="button" variant="outline" className="min-h-11" onClick={() => void copyRedirect()}>{copied ? <Check /> : <Copy />}{copied ? 'Copiado' : 'Copiar'}</Button></div>
      </details>
      <form onSubmit={e => void submit(e)} className="space-y-4">
        <label className="grid gap-1 text-sm font-medium">ID do app (Meta)<input value={appId} onChange={e => setAppId(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="Só números" className={fieldClass} /></label>
        <label className="grid gap-1 text-sm font-medium">Chave secreta do app (Meta)<PasswordInput value={appSecret} onChange={e => setAppSecret(e.target.value)} autoComplete="off" placeholder="Letras e números" /></label>
        <label className="grid gap-1 text-sm font-medium">ID da configuração de login<input value={configId} onChange={e => setConfigId(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="Só números" className={fieldClass} /></label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy !== ''} className="min-h-11">{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar dados do app</Button>
          {editing && <Button type="button" variant="ghost" className="min-h-11" onClick={() => setEditing(false)}>Cancelar</Button>}
        </div>
      </form>
    </div>}

    {!showForm && status && <div className="mt-6 space-y-4">
      {status.maskedAppId && <p className="text-sm text-muted-foreground">App da Meta: {status.maskedAppId} · configuração {status.configId} (segredo salvo)</p>}
      <div className="flex flex-wrap gap-2">
        {(!account || account.expired) && <Button className="min-h-11" onClick={() => void connect()} disabled={busy !== ''}>{busy === 'connect' ? <LoaderCircle className="animate-spin" /> : <Link2 />}{account ? 'Conectar de novo' : 'Conectar Instagram'}</Button>}
        {account && !account.expired && <Button variant="outline" className="min-h-11" onClick={() => void act('check', () => check())} disabled={busy !== ''}>{busy === 'check' ? <LoaderCircle className="animate-spin" /> : <Stethoscope />}Testar conexão</Button>}
        {account && <Button variant="outline" className="min-h-11" onClick={() => void act('disconnect', () => disconnect())} disabled={busy !== ''}>{busy === 'disconnect' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Desconectar</Button>}
        <Button variant="ghost" className="min-h-11" onClick={() => setEditing(true)} disabled={busy !== ''}>Trocar dados do app</Button>
        <Button variant="ghost" className="min-h-11" onClick={() => void act('removeApp', () => removeApp())} disabled={busy !== ''}>Remover app</Button>
      </div>
    </div>}
    {notice && <p role="status" className="mt-5 text-sm font-medium">{notice}</p>}
  </section>;
}