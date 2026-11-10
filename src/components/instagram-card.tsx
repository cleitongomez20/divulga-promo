import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Instagram, LoaderCircle, Trash2, Save, Stethoscope, KeyRound, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { getInstagramStatus, saveInstagramSecret, connectOwnInstagram, startInstagramLogin, checkInstagramConnection, disconnectInstagram, removeInstagramApp } from '@/lib/instagram.functions';
import { instagramSecretSchema, ownAccountSchema, instagramErrorMessage } from '@/lib/instagram';

const fieldClass = 'h-11 w-full rounded-md border bg-background px-3 text-base';

export function InstagramCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['instagram'], queryFn: () => getInstagramStatus(), staleTime: 0 });
  const saveSecret = useServerFn(saveInstagramSecret);
  const connectOwn = useServerFn(connectOwnInstagram);
  const start = useServerFn(startInstagramLogin);
  const check = useServerFn(checkInstagramConnection);
  const disconnect = useServerFn(disconnectInstagram);
  const removeApp = useServerFn(removeInstagramApp);
  const [appSecret, setAppSecret] = useState('');
  const [ownToken, setOwnToken] = useState('');
  const [ownId, setOwnId] = useState('');
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

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
    const parsed = instagramSecretSchema.safeParse({ appSecret });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira a chave.'); return; }
    if (await act('save', () => saveSecret({ data: parsed.data }))) { setAppSecret(''); setEditing(false); }
  }
  async function submitOwn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ownAccountSchema.safeParse({ accessToken: ownToken, igUserId: ownId });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    if (await act('own', () => connectOwn({ data: parsed.data }))) { setOwnToken(''); setOwnId(''); }
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

  const account = status?.account ?? null;
  const secretSaved = Boolean(status?.appConfigured);
  const needsConnect = !account || account.expired || switching;
  const showSecretForm = Boolean(status) && needsConnect && (!secretSaved || editing);
  const label = account ? (account.expired ? 'Precisa conectar de novo' : 'Conectado') : 'Pronto para conectar';

  return <section aria-labelledby="instagram-title" className="rounded-lg border bg-card p-5 sm:p-7">
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3"><Instagram className="size-7 text-muted-foreground" /><h2 id="instagram-title" className="text-xl font-semibold">Instagram</h2></div>
      <span className="text-sm text-muted-foreground">{isLoading ? 'Carregando...' : label}</span>
    </div>

    {account && <div className="mt-6 space-y-1 text-sm">
      <p className="font-medium">{account.username ? `@${account.username}` : 'Conta conectada'}</p>
      <p className="text-muted-foreground">{account.expired ? 'O acesso deixou de valer. Conecte de novo.' : 'Este acesso não tem prazo de validade. Se um dia parar de funcionar, o app avisa e você conecta de novo.'}</p>
    </div>}

    {status && needsConnect && <div className="mt-6 space-y-3">
      <p className="text-sm text-muted-foreground">Entre com o Instagram ou com o Facebook, escolha o portfólio empresarial e a conta do Instagram profissional que será usada. Não é preciso ter Página do Facebook.</p>
      <Button size="lg" className="min-h-12 w-full text-base font-semibold sm:w-auto" onClick={() => void connect()} disabled={busy !== ''}>
        {busy === 'connect' ? <LoaderCircle className="animate-spin" /> : <Instagram />}{account ? 'Conectar de novo com Instagram ou Facebook' : 'Conectar com Instagram ou Facebook'}
      </Button>
      <details className="rounded-md border p-4 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 font-medium"><Building2 className="size-4" />Conta própria do portfólio (token do usuário do sistema)</summary>
        <form onSubmit={e => void submitOwn(e)} className="mt-3 space-y-3">
          <p className="text-muted-foreground">Para a conta da própria empresa, dona do portfólio, que não consegue usar o login acima. Gere o token em <strong>Configurações do Business Suite &gt; Usuários &gt; Usuários do sistema</strong> (com o app e a conta do Instagram atribuídos, e as permissões <strong>instagram_basic</strong> e <strong>instagram_content_publish</strong>). O app acha a conta sozinho e guarda o token criptografado.</p>
          <label className="grid gap-1 font-medium">Token do usuário do sistema<PasswordInput value={ownToken} onChange={e => setOwnToken(e.target.value)} autoComplete="off" placeholder="Cole o token completo" /></label>
          <label className="grid gap-1 font-medium">ID da conta do Instagram (opcional)<input value={ownId} onChange={e => setOwnId(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="Só se a busca automática não achar (17841...)" className={fieldClass} /></label>
          <Button type="submit" disabled={busy !== ''} className="min-h-11">{busy === 'own' ? <LoaderCircle className="animate-spin" /> : <Save />}Conectar conta própria</Button>
        </form>
      </details>
    </div>}

    {showSecretForm && <form onSubmit={e => void submit(e)} className="mt-6 space-y-3 rounded-md border p-4">
      <p className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4" />Chave secreta do app da Meta</p>
      <p className="text-sm text-muted-foreground">A Meta exige esta chave para concluir a conexão. Copie em <a className="underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">developers.facebook.com</a> &gt; seu app &gt; <strong>Configurações do app &gt; Básico</strong> &gt; Chave secreta do app (clique em Mostrar). Ela fica guardada de forma criptografada e só no servidor.</p>
      <PasswordInput value={appSecret} onChange={e => setAppSecret(e.target.value)} autoComplete="off" placeholder="Letras e números" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== ''} className="min-h-11">{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar chave secreta</Button>
        {editing && <Button type="button" variant="ghost" className="min-h-11" onClick={() => setEditing(false)}>Cancelar</Button>}
      </div>
    </form>}

    {status && <div className="mt-6 flex flex-wrap gap-2">
      {account && !account.expired && !switching && <Button variant="outline" className="min-h-11" onClick={() => setSwitching(true)} disabled={busy !== ''}>Trocar conta</Button>}
      {switching && <Button variant="ghost" className="min-h-11" onClick={() => setSwitching(false)} disabled={busy !== ''}>Cancelar troca</Button>}
      {account && !account.expired && <Button variant="outline" className="min-h-11" onClick={() => void act('check', () => check())} disabled={busy !== ''}>{busy === 'check' ? <LoaderCircle className="animate-spin" /> : <Stethoscope />}Testar conexão</Button>}
      {account && <Button variant="outline" className="min-h-11" onClick={() => void act('disconnect', () => disconnect()).then(() => setSwitching(false))} disabled={busy !== ''}>{busy === 'disconnect' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Desconectar</Button>}
      {secretSaved && needsConnect && !editing && <Button variant="ghost" className="min-h-11" onClick={() => setEditing(true)} disabled={busy !== ''}>Trocar chave secreta</Button>}
      {secretSaved && needsConnect && <Button variant="ghost" className="min-h-11" onClick={() => void act('removeApp', () => removeApp())} disabled={busy !== ''}>Remover chave</Button>}
    </div>}
    {notice && <p role="status" className="mt-5 text-sm font-medium">{notice}</p>}
  </section>;
}