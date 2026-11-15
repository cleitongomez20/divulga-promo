import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { CalendarClock, LoaderCircle, Pencil, Send, Sparkles } from 'lucide-react';
import { WorkspaceShell } from '@/components/workspace-shell';
import { StoryboardPanel } from '@/components/storyboard-panel';
import { Button } from '@/components/ui/button';
import { pageHead } from '@/lib/metadata';
import { workspaceQuery } from '@/lib/workspace-query';
import { cancelPost, getPostsOverview, queuePostNow, schedulePostAt, updateDraftCaption, type PostView } from '@/lib/posts.functions';
import { GENERATE_FORMATS, generateAiContent, type GenerateFormat } from '@/lib/brain.functions';
import { HEARTBEAT_STALE_MS } from '@/lib/publishing';
import { FORMAT_LABELS, STATUS_LABELS, CANCELABLE_STATUSES, checkSchedule, formatInZone, zonedTimeToUtcIso, MAX_CAPTION, type PostFormat } from '@/lib/posts';

export const Route = createFileRoute('/_authenticated/publicacoes')({
  head: () => pageHead('Publicações', 'Crie e acompanhe suas publicações para o Instagram.'),
  loader: ({ context }) => context.queryClient.ensureQueryData(workspaceQuery),
  component: PostsPage,
});

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground', rendering: 'bg-accent text-accent-foreground', scheduled: 'bg-accent text-accent-foreground', publishing: 'bg-accent text-accent-foreground',
  published: 'bg-primary text-primary-foreground', failed: 'bg-destructive text-destructive-foreground', canceled: 'bg-muted text-muted-foreground',
};
/** The four Instagram formats the manual button can create, with what each one is. */
const GENERATE_OPTIONS: Record<GenerateFormat, { label: string; hint: string; needsVideo: boolean }> = {
  reel: { label: 'Reels', hint: 'A IA cria o storyboard, as 6 imagens e depois o vídeo de 30 segundos no Higgsfield, tudo sozinha. Leva alguns minutos e é agendado quando ficar pronto.', needsVideo: true },
  story: { label: 'Story', hint: 'A IA cria o storyboard, as imagens e o vídeo vertical de Story no Higgsfield, tudo sozinha. Leva alguns minutos e é agendado quando ficar pronto.', needsVideo: true },
  photo: { label: 'Feed', hint: 'Uma foto real do produto com a legenda escrita pela IA. Fica pronto na hora e já é agendado.', needsVideo: false },
  carousel: { label: 'Carrossel', hint: '6 imagens criadas pela OpenAI a partir da foto real do produto, com a legenda escrita pela IA. Leva alguns minutos e é agendado quando ficar pronto. Precisa da OpenAI conectada.', needsVideo: false },
};

function PostsPage() {
  const { data: workspace } = useSuspenseQuery(workspaceQuery);
  const timezone = workspace.settings?.timezone ?? 'America/Sao_Paulo';
  const queryClient = useQueryClient();
  const { data: overview, isLoading, isError } = useQuery({
    queryKey: ['posts'], queryFn: () => getPostsOverview(), staleTime: 0,
    refetchInterval: query => (query.state.data?.posts.some(post => post.status === 'rendering') ? 15_000 : query.state.data?.posts.some(post => post.status === 'scheduled' || post.status === 'publishing') ? 30_000 : false),
  });
  const cancel = useServerFn(cancelPost);
  const queue = useServerFn(queuePostNow);
  const generateFn = useServerFn(generateAiContent);
  const saveCaption = useServerFn(updateDraftCaption);
  const schedule = useServerFn(schedulePostAt);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [scheduling, setScheduling] = useState<{ id: string; when: string } | null>(null);
  const [genFormat, setGenFormat] = useState<GenerateFormat>('reel');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [listMessage, setListMessage] = useState('');

  const connected = overview?.account?.status === 'connected';

  async function cancelOne(post: PostView) {
    if (!window.confirm('Cancelar esta publicação?')) return;
    setBusy('Cancelando...'); setListMessage('');
    try {
      const result = await cancel({ data: { postId: post.id } });
      setListMessage(result.status === 'ok' ? (result.message ?? 'Publicação cancelada.') : result.message);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setListMessage('Não foi possível cancelar agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  async function sendNow(post: PostView) {
    setBusy('Colocando na fila...'); setListMessage('');
    try {
      const result = await queue({ data: { postId: post.id } });
      setListMessage(result.status === 'ok' ? (result.message ?? 'Na fila.') : result.message);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setListMessage('Não foi possível colocar na fila agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy('Salvando legenda...'); setListMessage('');
    try {
      const result = await saveCaption({ data: { postId: editing.id, caption: editing.text } });
      setListMessage(result.status === 'ok' ? (result.message ?? 'Legenda salva.') : result.message);
      if (result.status === 'ok') setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setListMessage('Não foi possível salvar a legenda agora. Tente de novo.'); }
    finally { setBusy(''); }
  }
  async function confirmSchedule() {
    if (!scheduling) return;
    const at = scheduling.when ? zonedTimeToUtcIso(scheduling.when, timezone) : null;
    const problem = at ? checkSchedule(at) : 'Escolha a data e a hora da publicação.';
    if (problem || !at) { setListMessage(problem ?? 'Escolha a data e a hora da publicação.'); return; }
    setBusy('Agendando...'); setListMessage('');
    try {
      const result = await schedule({ data: { postId: scheduling.id, scheduledAt: at } });
      setListMessage(result.status === 'ok' ? (result.message ?? 'Publicação agendada.') : result.message);
      if (result.status === 'ok') setScheduling(null);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setListMessage('Não foi possível agendar agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  /** The manual start: one click creates the format chosen above, from the product to the scheduled post. */
  async function generateNow() {
    setBusy(`A IA está criando ${GENERATE_OPTIONS[genFormat].needsVideo ? 'e pedindo o vídeo ao Higgsfield (pode levar até 1 minuto)' : 'o conteúdo (pode levar até 1 minuto)'}...`); setMessage('');
    try {
      const result = await generateFn({ data: { format: genFormat } });
      setMessage(result.message);
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
    } catch { setMessage('Não foi possível gerar o conteúdo agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  const waiting = overview?.posts.some(post => post.status === 'scheduled' || post.status === 'rendering') ?? false;
  const lastVisit = overview?.scheduler.lastVisitAt ? Date.parse(overview.scheduler.lastVisitAt) : null;
  const schedulerSilent = waiting && (lastVisit === null || Date.now() - lastVisit > HEARTBEAT_STALE_MS);
  const option = GENERATE_OPTIONS[genFormat];
  const generating = busy.startsWith('A IA está');
  const blocked = !overview?.account || !overview.ai.connected || (option.needsVideo && !overview.ai.videoReady);

  return <WorkspaceShell>
    <p className="text-xs font-semibold uppercase tracking-widest text-primary">Instagram</p>
    <h1 className="mt-3 text-3xl font-bold">Publicações</h1>
    <p className="mt-2 max-w-2xl text-muted-foreground">Gere conteúdo com a IA e acompanhe tudo o que foi criado. As publicações agendadas saem sozinhas no horário, pelo agendador que visita o app a cada minuto. Respeitamos o limite diário, o aquecimento da conta e o intervalo mínimo entre publicações da tela Configurações, então uma publicação pode sair um pouco depois do horário ou ir para o dia seguinte.</p>

    {overview && !overview.account && <div role="status" className="mt-6 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground">Conecte o seu Instagram na tela <Link to="/conexoes" className="underline">Conexões</Link> para criar publicações.</div>}
    {overview?.account && !connected && <div role="status" className="mt-6 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground">A conexão com o Instagram precisa ser refeita na tela <Link to="/conexoes" className="underline">Conexões</Link>.</div>}
    {schedulerSilent && <div role="status" className="mt-6 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground">O agendador não visitou o app nos últimos minutos, então as publicações agendadas não vão sair. Confira se o trabalho no cron-job.org está ativo.</div>}
    {isError && <p role="status" className="mt-6 text-sm font-medium">Não foi possível carregar suas publicações. Atualize a página.</p>}

    <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="ai-title">
      <div className="flex items-center gap-3"><Sparkles className="size-6 text-primary" /><h2 id="ai-title" className="text-lg font-semibold">Gerar com a IA</h2></div>
      <p className="mt-2 text-sm text-muted-foreground">Escolha o formato e clique em gerar. A IA escolhe o produto, escreve a legenda, cria a foto, o carrossel ou o vídeo e agenda sozinha, sem pedir aprovação. O agendamento respeita o limite diário, o aquecimento da conta e o intervalo mínimo entre publicações. Se o personagem fala ou não, você define em <Link to="/configuracoes" className="underline">Configurações</Link>.</p>
      {overview && !overview.ai.connected && <p className="mt-3 text-sm font-medium">Conecte o Claude ou a OpenAI na tela <Link to="/conexoes" className="underline">Conexões</Link> para usar.</p>}
      <fieldset className="mt-4"><legend className="form-label">Formato</legend>
        <div className="flex flex-wrap gap-2">{GENERATE_FORMATS.map(item => <Button key={item} type="button" variant={genFormat === item ? 'default' : 'outline'} className="min-h-11" disabled={generating} aria-pressed={genFormat === item} onClick={() => { setGenFormat(item); setMessage(''); }}>{GENERATE_OPTIONS[item].label}</Button>)}</div>
        <p className="mt-2 text-xs text-muted-foreground">{option.hint}</p>
      </fieldset>
      {overview?.ai.connected && option.needsVideo && !overview.ai.videoReady && <p className="mt-3 text-sm font-medium">Para criar vídeos, conecte o Higgsfield na tela <Link to="/conexoes" className="underline">Conexões</Link>.</p>}
      <Button type="button" className="mt-4 h-11" disabled={Boolean(busy) || blocked} onClick={() => void generateNow()}>{generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Gerar conteúdo com a IA</Button>
      {generating && <p role="status" className="mt-3 text-sm text-muted-foreground">{busy}</p>}
      {message && <p role="status" className="mt-3 break-words text-sm font-medium">{message}</p>}
    </section>

    <StoryboardPanel />

    <h2 className="mt-10 text-lg font-semibold">Suas publicações</h2>
    {listMessage && <p role="status" className="mt-3 break-words text-sm font-medium">{listMessage}</p>}
    {isLoading && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando...</p>}
    {overview && !overview.posts.length && <div className="mt-4 border-y py-12 text-center"><Send className="mx-auto size-10 text-muted-foreground/60" /><h3 className="mt-4 font-semibold">Nenhuma publicação ainda</h3></div>}
    {overview && overview.posts.length > 0 && <ul className="mt-4 grid gap-4">{overview.posts.map(post => <li key={post.id} className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{FORMAT_LABELS[post.format as PostFormat] ?? post.format}</span><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[post.status] ?? 'bg-muted text-muted-foreground'}`}>{STATUS_LABELS[post.status] ?? post.status}</span>
        {post.scheduledAt && <span className="text-xs text-muted-foreground">{post.status === 'published' && post.publishedAt ? `Publicada em ${formatInZone(post.publishedAt, timezone)}` : `Para ${formatInZone(post.scheduledAt, timezone)}`}</span>}</div>
      <p className="mt-2 line-clamp-2 text-sm">{post.productTitle}</p>
      {(post.source === 'ai' || post.source === 'auto') && post.aiPlan && <div className="mt-2 rounded-md bg-accent p-3 text-xs text-accent-foreground"><p className="flex items-center gap-1.5 font-semibold"><Sparkles className="size-3.5" />{post.source === 'auto' ? 'Criado pela automação' : 'Criado pela IA'}{post.aiPlan.angle ? `: ${post.aiPlan.angle}` : ''}</p>{post.aiPlan.reason && <p className="mt-1">Por que este produto: {post.aiPlan.reason}</p>}{post.aiPlan.linkMissing && <p className="mt-1 font-medium">Ainda sem link de afiliado. Conecte a Shopee e gere de novo antes de publicar.</p>}</div>}
      {editing?.id === post.id
        ? <div className="mt-2"><label className="form-label" htmlFor={`caption-${post.id}`}>Legenda</label><textarea id={`caption-${post.id}`} className="field min-h-48" maxLength={MAX_CAPTION} value={editing.text} onChange={e => setEditing({ id: post.id, text: e.target.value })} /><p className="mt-1 text-right text-xs text-muted-foreground">{editing.text.length}/{MAX_CAPTION}</p>
          <div className="mt-2 flex flex-wrap gap-2"><Button type="button" size="sm" className="min-h-11" disabled={Boolean(busy)} onClick={() => void saveEdit()}>Salvar legenda</Button><Button type="button" variant="outline" size="sm" className="min-h-11" disabled={Boolean(busy)} onClick={() => setEditing(null)}>Cancelar</Button></div></div>
        : post.caption && <p className={`mt-1 text-xs text-muted-foreground ${post.status === 'draft' ? 'whitespace-pre-line' : 'line-clamp-2'}`}>{post.caption}</p>}
      {post.error && <p className={`mt-1 text-xs font-medium ${post.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{post.status === 'failed' ? post.error : `Aviso: ${post.error}`}</p>}
      {post.status === 'rendering' && <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />O Higgsfield está gerando o vídeo. Leva alguns minutos e ele aparece aqui como rascunho.</p>}
      {post.media.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{post.media.slice(0, 5).map((media, index) => <div key={index} className={`overflow-hidden rounded bg-muted ${media.kind === 'video' && post.status === 'draft' ? 'w-40' : 'size-16'}`}>{media.kind === 'image' ? <img src={media.url} alt="" loading="lazy" className="size-full object-cover" /> : <video src={media.url} muted={post.status !== 'draft'} controls={post.status === 'draft'} playsInline preload="metadata" className="size-full object-cover" />}</div>)}{post.media.length > 5 && <span className="self-center text-xs text-muted-foreground">+{post.media.length - 5}</span>}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {post.status === 'draft' && post.format !== 'story' && editing?.id !== post.id && <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={Boolean(busy)} onClick={() => setEditing({ id: post.id, text: post.caption })}><Pencil />Editar legenda</Button>}
        {['draft', 'scheduled'].includes(post.status) && <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={Boolean(busy) || !connected} onClick={() => setScheduling(scheduling?.id === post.id ? null : { id: post.id, when: '' })}><CalendarClock />Agendar</Button>}
        {['draft', 'scheduled', 'failed'].includes(post.status) && !(post.status === 'failed' && post.media.length === 0) && <Button type="button" size="sm" className="min-h-11" disabled={Boolean(busy) || !connected} onClick={() => void sendNow(post)}><Send />{post.status === 'failed' ? 'Tentar de novo' : 'Publicar agora'}</Button>}
        {(CANCELABLE_STATUSES as readonly string[]).includes(post.status) && <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={Boolean(busy)} onClick={() => void cancelOne(post)}>Cancelar</Button>}
      </div>
      {scheduling?.id === post.id && <div className="mt-3 flex flex-wrap items-end gap-2"><div><label className="form-label" htmlFor={`when-${post.id}`}>Data e hora (fuso da sua conta)</label><input id={`when-${post.id}`} type="datetime-local" className="field" value={scheduling.when} onChange={e => setScheduling({ id: post.id, when: e.target.value })} /></div><Button type="button" size="sm" className="min-h-11" disabled={Boolean(busy)} onClick={() => void confirmSchedule()}>Confirmar agendamento</Button></div>}
    </li>)}</ul>}
  </WorkspaceShell>;
}