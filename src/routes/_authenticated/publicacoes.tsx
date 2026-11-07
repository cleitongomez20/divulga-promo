import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, LoaderCircle, Send, Upload, X } from 'lucide-react';
import { WorkspaceShell } from '@/components/workspace-shell';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { pageHead } from '@/lib/metadata';
import { workspaceQuery } from '@/lib/workspace-query';
import { cancelPost, createManualPost, getPostsOverview, type PostView } from '@/lib/posts.functions';
import { prepareFile, removeUploads, uploadPrepared } from '@/lib/media-upload';
import { FORMAT_LABELS, FORMAT_RULES, MAX_CAPTION, POST_FORMATS, STATUS_LABELS, CANCELABLE_STATUSES, checkSchedule, formatInZone, validateMedia, zonedTimeToUtcIso, type PostFormat } from '@/lib/posts';

export const Route = createFileRoute('/_authenticated/publicacoes')({
  head: () => pageHead('Publicações', 'Crie e acompanhe suas publicações para o Instagram.'),
  loader: ({ context }) => context.queryClient.ensureQueryData(workspaceQuery),
  component: PostsPage,
});

type Picked = { id: string; file: File; previewUrl: string; isImage: boolean };
const ACCEPT: Record<PostFormat, string> = {
  reel: 'video/mp4,video/quicktime,.mp4,.mov',
  story: 'image/*,video/mp4,video/quicktime,.mp4,.mov',
  photo: 'image/*',
  carousel: 'image/*,video/mp4,video/quicktime,.mp4,.mov',
};
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground', scheduled: 'bg-accent text-accent-foreground', publishing: 'bg-accent text-accent-foreground',
  published: 'bg-primary text-primary-foreground', failed: 'bg-destructive text-destructive-foreground', canceled: 'bg-muted text-muted-foreground',
};
const isImageFile = (file: File) => file.type.startsWith('image/');

function PostsPage() {
  const { data: workspace } = useSuspenseQuery(workspaceQuery);
  const timezone = workspace.settings?.timezone ?? 'America/Sao_Paulo';
  const queryClient = useQueryClient();
  const { data: overview, isLoading, isError } = useQuery({ queryKey: ['posts'], queryFn: () => getPostsOverview(), staleTime: 0 });
  const create = useServerFn(createManualPost);
  const cancel = useServerFn(cancelPost);

  const [format, setFormat] = useState<PostFormat>('reel');
  const [productId, setProductId] = useState('');
  const [caption, setCaption] = useState('');
  const [link, setLink] = useState('');
  const [mode, setMode] = useState<'draft' | 'schedule'>('draft');
  const [when, setWhen] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const filesRef = useRef<Picked[]>([]);
  filesRef.current = files;
  useEffect(() => () => { filesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl)); }, []);

  const rule = FORMAT_RULES[format];
  const connected = overview?.account?.status === 'connected';

  function changeFormat(next: PostFormat) {
    setFormat(next); setMessage('');
    files.forEach(item => URL.revokeObjectURL(item.previewUrl)); setFiles([]);
  }
  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setMessage('');
    const picked = [...list].map(file => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), isImage: isImageFile(file) }));
    if (rule.max === 1) { files.forEach(item => URL.revokeObjectURL(item.previewUrl)); setFiles(picked.slice(0, 1)); return; }
    const room = rule.max - files.length;
    if (picked.length > room) setMessage(`Cabem no máximo ${rule.max} arquivos. Os que passaram do limite foram ignorados.`);
    picked.slice(room).forEach(item => URL.revokeObjectURL(item.previewUrl));
    setFiles([...files, ...picked.slice(0, Math.max(0, room))]);
  }
  function removeFile(id: string) {
    const gone = files.find(item => item.id === id); if (gone) URL.revokeObjectURL(gone.previewUrl);
    setFiles(files.filter(item => item.id !== id));
  }
  function move(index: number, delta: number) {
    const target = index + delta; if (target < 0 || target >= files.length) return;
    const next = [...files]; const [item] = next.splice(index, 1); next.splice(target, 0, item as Picked); setFiles(next);
  }
  function resetForm() {
    files.forEach(item => URL.revokeObjectURL(item.previewUrl));
    setFiles([]); setCaption(''); setLink(''); setWhen(''); setMode('draft'); setRequestId(crypto.randomUUID());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!productId) { setMessage('Escolha o produto da publicação.'); return; }
    if (!files.length) { setMessage('Escolha os arquivos da publicação.'); return; }
    let scheduledAt: string | null = null;
    if (mode === 'schedule') {
      scheduledAt = when ? zonedTimeToUtcIso(when, timezone) : null;
      const problem = scheduledAt ? checkSchedule(scheduledAt) : 'Escolha a data e a hora da publicação.';
      if (problem) { setMessage(problem); return; }
    }
    const uploaded: string[] = [];
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setMessage('Entre na sua conta de novo para continuar.'); return; }
      const prepared = [];
      for (const [index, item] of files.entries()) {
        setBusy(`Preparando arquivo ${index + 1} de ${files.length}...`);
        const result = await prepareFile(item.file);
        if ('error' in result) { setMessage(result.error); return; }
        prepared.push(result);
      }
      const problem = validateMedia(format, prepared.map(item => item.kind));
      if (problem) { setMessage(problem); return; }
      for (const [index, item] of prepared.entries()) {
        setBusy(`Enviando arquivo ${index + 1} de ${prepared.length}...`);
        const result = await uploadPrepared(user.id, item);
        if ('error' in result) { setMessage(result.error); await removeUploads(uploaded); return; }
        uploaded.push(result.path);
      }
      setBusy('Salvando publicação...');
      const result = await create({ data: { requestId, format, productId, caption, affiliateLink: link, scheduledAt, media: uploaded.map(path => ({ path })) } });
      if (result.status === 'error') { setMessage(result.message); await removeUploads(uploaded); return; }
      setMessage(result.message ?? 'Publicação salva.');
      resetForm();
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch {
      setMessage('Não foi possível concluir agora. Tente de novo.'); await removeUploads(uploaded);
    } finally { setBusy(''); }
  }

  async function cancelOne(post: PostView) {
    if (!window.confirm('Cancelar esta publicação?')) return;
    setBusy('Cancelando...'); setMessage('');
    try {
      const result = await cancel({ data: { postId: post.id } });
      setMessage(result.status === 'ok' ? (result.message ?? 'Publicação cancelada.') : result.message);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setMessage('Não foi possível cancelar agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  return <WorkspaceShell>
    <p className="text-xs font-semibold uppercase tracking-widest text-primary">Instagram</p>
    <h1 className="mt-3 text-3xl font-bold">Publicações</h1>
    <p className="mt-2 max-w-2xl text-muted-foreground">Envie um vídeo, uma foto ou um carrossel e deixe pronto para publicar. O envio automático ao Instagram ainda não está ligado: por enquanto as publicações ficam guardadas aqui.</p>

    {overview && !overview.account && <div role="status" className="mt-6 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground">Conecte o seu Instagram na tela <Link to="/conexoes" className="underline">Conexões</Link> para criar publicações.</div>}
    {overview?.account && !connected && <div role="status" className="mt-6 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground">A conexão com o Instagram precisa ser refeita na tela <Link to="/conexoes" className="underline">Conexões</Link>.</div>}
    {isError && <p role="status" className="mt-6 text-sm font-medium">Não foi possível carregar suas publicações. Atualize a página.</p>}

    <form onSubmit={submit} className="mt-8 rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">Nova publicação</h2>
      <fieldset className="mt-5"><legend className="form-label">Formato</legend>
        <div className="flex flex-wrap gap-2">{POST_FORMATS.map(item => <Button key={item} type="button" variant={format === item ? 'default' : 'outline'} className="min-h-11" onClick={() => changeFormat(item)} aria-pressed={format === item}>{FORMAT_LABELS[item]}</Button>)}</div>
        <p className="mt-2 text-xs text-muted-foreground">{FORMAT_LABELS[format]}: {rule.hint}. Fotos PNG são convertidas para JPEG automaticamente. Tamanho máximo de 50 MB por arquivo.</p>
      </fieldset>

      <div className="mt-5"><label className="form-label" htmlFor="product">Produto</label>
        <select id="product" className="field" value={productId} onChange={e => setProductId(e.target.value)} required>
          <option value="">{overview?.products.length ? 'Escolha um produto' : 'Nenhum produto salvo ainda'}</option>
          {overview?.products.map(item => <option key={item.id} value={item.id}>{item.title.slice(0, 90)}</option>)}
        </select>
        {overview && !overview.products.length && <p className="mt-2 text-xs text-muted-foreground">Os produtos aparecem aqui depois que você os busca na tela <Link to="/produtos" className="underline">Produtos</Link>.</p>}
      </div>

      <div className="mt-5"><label className="form-label" htmlFor="files">Arquivos</label>
        <input id="files" type="file" accept={ACCEPT[format]} multiple={rule.max > 1} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} className="field" />
        {files.length > 0 && <ul className="mt-3 grid gap-2">{files.map((item, index) => <li key={item.id} className="flex items-center gap-3 rounded-md border p-2">
          <div className="size-14 shrink-0 overflow-hidden rounded bg-muted">{item.isImage ? <img src={item.previewUrl} alt="" className="size-full object-cover" /> : <video src={item.previewUrl} muted playsInline preload="metadata" className="size-full object-cover" />}</div>
          <span className="min-w-0 flex-1 truncate text-sm">{rule.max > 1 && <span className="mr-2 font-semibold">{index + 1}.</span>}{item.file.name}</span>
          {rule.max > 1 && <><Button type="button" size="icon" variant="ghost" title="Subir" aria-label="Subir" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button><Button type="button" size="icon" variant="ghost" title="Descer" aria-label="Descer" disabled={index === files.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button></>}
          <Button type="button" size="icon" variant="ghost" title="Remover" aria-label="Remover" onClick={() => removeFile(item.id)}><X /></Button>
        </li>)}</ul>}
      </div>

      <div className="mt-5"><label className="form-label" htmlFor="caption">Legenda (opcional)</label>
        <textarea id="caption" className="field min-h-28" value={caption} maxLength={MAX_CAPTION} onChange={e => setCaption(e.target.value)} />
        <p className="mt-1 text-right text-xs text-muted-foreground">{caption.length}/{MAX_CAPTION}</p>
      </div>

      <div className="mt-5"><label className="form-label" htmlFor="link">Link de afiliado (opcional)</label>
        <input id="link" className="field" inputMode="url" placeholder="https://shope.ee/..." value={link} onChange={e => setLink(e.target.value)} maxLength={600} />
      </div>

      <fieldset className="mt-5"><legend className="form-label">Quando</legend>
        <div className="flex flex-wrap gap-2"><Button type="button" variant={mode === 'draft' ? 'default' : 'outline'} className="min-h-11" aria-pressed={mode === 'draft'} onClick={() => setMode('draft')}>Salvar como rascunho</Button><Button type="button" variant={mode === 'schedule' ? 'default' : 'outline'} className="min-h-11" aria-pressed={mode === 'schedule'} onClick={() => setMode('schedule')}><CalendarClock />Agendar</Button></div>
        {mode === 'schedule' && <div className="mt-3 max-w-xs"><input type="datetime-local" className="field" value={when} onChange={e => setWhen(e.target.value)} aria-label="Data e hora" /><p className="mt-1 text-xs text-muted-foreground">No fuso configurado na sua conta.</p></div>}
      </fieldset>

      {message && <p role="status" className="mt-5 text-sm font-medium">{message}</p>}
      <Button type="submit" disabled={Boolean(busy) || !connected} className="mt-5 h-11">{busy ? <LoaderCircle className="animate-spin" /> : mode === 'schedule' ? <CalendarClock /> : <Upload />}{busy || (mode === 'schedule' ? 'Agendar publicação' : 'Salvar rascunho')}</Button>
    </form>

    <h2 className="mt-10 text-lg font-semibold">Suas publicações</h2>
    {isLoading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando...</p>}
    {overview && !overview.posts.length && <div className="mt-4 border-y py-12 text-center"><Send className="mx-auto size-10 text-muted-foreground/60" /><h3 className="mt-4 font-semibold">Nenhuma publicação ainda</h3></div>}
    {overview && overview.posts.length > 0 && <ul className="mt-4 grid gap-4">{overview.posts.map(post => <li key={post.id} className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{FORMAT_LABELS[post.format as PostFormat] ?? post.format}</span><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[post.status] ?? 'bg-muted text-muted-foreground'}`}>{STATUS_LABELS[post.status] ?? post.status}</span>
        {post.scheduledAt && <span className="text-xs text-muted-foreground">{post.status === 'published' && post.publishedAt ? `Publicada em ${formatInZone(post.publishedAt, timezone)}` : `Para ${formatInZone(post.scheduledAt, timezone)}`}</span>}</div>
      <p className="mt-2 line-clamp-2 text-sm">{post.productTitle}</p>
      {post.caption && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{post.caption}</p>}
      {post.error && <p className="mt-1 text-xs font-medium text-destructive">{post.error}</p>}
      {post.media.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{post.media.slice(0, 5).map((media, index) => <div key={index} className="size-16 overflow-hidden rounded bg-muted">{media.kind === 'image' ? <img src={media.url} alt="" loading="lazy" className="size-full object-cover" /> : <video src={media.url} muted playsInline preload="metadata" className="size-full object-cover" />}</div>)}{post.media.length > 5 && <span className="self-center text-xs text-muted-foreground">+{post.media.length - 5}</span>}</div>}
      {(CANCELABLE_STATUSES as readonly string[]).includes(post.status) && <Button type="button" variant="outline" size="sm" className="mt-3 min-h-11" disabled={Boolean(busy)} onClick={() => void cancelOne(post)}>Cancelar</Button>}
    </li>)}</ul>}
  </WorkspaceShell>;
}
