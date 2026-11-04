import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Instagram, LoaderCircle, Trash2, Save, Stethoscope, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { getInstagramStatus, saveInstagramSecret, startInstagramLogin, checkInstagramConnection, disconnectInstagram, removeInstagramApp } from '@/lib/instagram.functions';
import { instagramSecretSchema, instagramErrorMessage } from '@/lib/instagram';

export function InstagramCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['instagram'], queryFn: () => getInstagramStatus(), staleTime: 0 });
  const saveSecret = useServerFn(saveInstagramSecret);
  const start = useServerFn(startInstagramLogin);
  const check = useServerFn(checkInstagramConnection);
  const disconnect = useServerFn(disconnectInstagram);
  const removeApp = useServerFn(removeInstagramApp);
  const [appSecret, setAppSecret] = useState('');
  const [editing, setEditing] = useState(false);
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
  const showSecretForm = Boolean(status) && (!secretSaved || editing);
  const needsConnect = !account || account.expired;
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
      {account && !account.expired && <Button variant="outline" className="min-h-11" onClick={() => void act('check', () => check())} disabled={busy !== ''}>{busy === 'check' ? <LoaderCircle className="animate-spin" /> : <Stethoscope />}Testar conexão</Button>}
      {account && <Button variant="outline" className="min-h-11" onClick={() => void act('disconnect', () => disconnect())} disabled={busy !== ''}>{busy === 'disconnect' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Desconectar</Button>}
      {secretSaved && !editing && <Button variant="ghost" className="min-h-11" onClick={() => setEditing(true)} disabled={busy !== ''}>Trocar chave secreta</Button>}
      {secretSaved && <Button variant="ghost" className="min-h-11" onClick={() => void act('removeApp', () => removeApp())} disabled={busy !== ''}>Remover chave</Button>}
    </div>}
    {notice && <p role="status" className="mt-5 text-sm font-medium">{notice}</p>}
  </section>;
}