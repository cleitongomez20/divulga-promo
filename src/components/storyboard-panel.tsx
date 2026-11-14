import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Film, ImageIcon, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUsd } from '@/lib/claude';
import { SCENE_COUNT } from '@/lib/storyboard';
import { discardStoryboardNow, generateStoryboardScene, getStoryboard, getStoryboardProducts, getStoryboards, planStoryboardNow } from '@/lib/storyboard.functions';

const SCENE_STATUS: Record<string, string> = { pending: 'Aguardando', generating: 'Criando...', done: 'Pronta', failed: 'Falhou' };
const BOARD_STATUS: Record<string, string> = { planned: 'Planejado', generating: 'Criando imagens', ready: 'Pronto' };

/** Storyboard of six scenes: the AI plans it, OpenAI draws each scene from the real product photo, the user reviews the images. */
export function StoryboardPanel() {
  const queryClient = useQueryClient();
  const plan = useServerFn(planStoryboardNow); const draw = useServerFn(generateStoryboardScene); const discard = useServerFn(discardStoryboardNow);
  const { data: products } = useQuery({ queryKey: ['storyboard-products'], queryFn: () => getStoryboardProducts(), staleTime: 60_000 });
  const { data: boards } = useQuery({ queryKey: ['storyboards'], queryFn: () => getStoryboards(), staleTime: 0 });
  const [productId, setProductId] = useState('');
  const [withSpeech, setWithSpeech] = useState(true);
  const [openId, setOpenId] = useState('');
  const { data: board } = useQuery({ queryKey: ['storyboard', openId], queryFn: () => getStoryboard({ data: { id: openId } }), enabled: Boolean(openId), staleTime: 0 });
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const stop = useRef(false);

  const refresh = async (id = openId) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['storyboards'] }), id ? queryClient.invalidateQueries({ queryKey: ['storyboard', id] }) : Promise.resolve()]);
  };

  async function planNow() {
    if (!productId) { setNotice('Escolha um produto.'); return; }
    setBusy('plan'); setNotice('');
    try {
      const result = await plan({ data: { productId, withSpeech } });
      setNotice(result.message);
      if (result.status === 'ok' && result.storyboardId) { setOpenId(result.storyboardId); await refresh(result.storyboardId); }
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  /** One request per scene, in order, so a slow image never hits a time limit. It stops at the first failure. */
  async function drawAll() {
    if (!board) return;
    const todo = board.scenes.filter(scene => scene.status !== 'done');
    if (!todo.length) return;
    setBusy('draw'); setNotice(''); stop.current = false;
    let made = 0;
    try {
      for (const scene of todo) {
        if (stop.current) { setNotice('Parado. As imagens já criadas foram guardadas.'); break; }
        setProgress(`Criando a cena ${scene.position + 1} de ${SCENE_COUNT}...`);
        const result = await draw({ data: { sceneId: scene.id } });
        await refresh();
        if (result.status === 'error') { setNotice(`Cena ${scene.position + 1}: ${result.message}`); break; }
        made += 1;
        if (made === todo.length) setNotice('Todas as imagens foram criadas. Confira cada cena abaixo.');
      }
    } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); setProgress(''); await refresh(); }
  }

  async function discardNow() {
    if (!board) return;
    setBusy('discard');
    try { const result = await discard({ data: { id: board.id } }); setNotice(result.message); setOpenId(''); await refresh(board.id); }
    catch { setNotice('Não foi possível concluir agora. Tente de novo.'); }
    finally { setBusy(''); }
  }

  const remaining = board ? board.scenes.filter(scene => scene.status !== 'done').length : 0;
  const working = Boolean(busy);

  return <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="storyboard-title">
    <div className="flex items-center gap-3"><Film className="size-6 text-primary" /><h2 id="storyboard-title" className="text-lg font-semibold">Storyboard com imagens da IA</h2></div>
    <p className="mt-2 text-sm text-muted-foreground">A IA planeja {SCENE_COUNT} cenas para um Reels de 30 segundos e a OpenAI cria uma imagem por cena, a partir da foto real do produto. Nada é publicado aqui: é só para você conferir. Precisa da OpenAI conectada.</p>

    <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <div><label className="form-label" htmlFor="sb-product">Produto</label>
        <select id="sb-product" className="field" value={productId} disabled={working} onChange={e => setProductId(e.target.value)}>
          <option value="">Escolha um produto salvo</option>
          {(products ?? []).map(item => <option key={item.id} value={item.id}>{item.title.slice(0, 90)}</option>)}
        </select></div>
      <Button disabled={working || !productId} onClick={() => void planNow()}>{busy === 'plan' ? <LoaderCircle className="animate-spin" /> : <Film />}Planejar storyboard</Button>
    </div>
    <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={withSpeech} disabled={working} onChange={e => setWithSpeech(e.target.checked)} />Personagem falando (a IA cria a pessoa e as falas)</label>
    {busy === 'plan' && <p role="status" className="mt-3 text-sm text-muted-foreground">A IA está montando o storyboard (pode levar até 1 minuto)...</p>}

    {Boolean(boards?.length) && <div className="mt-5"><p className="text-sm font-medium">Seus storyboards</p>
      <ul className="mt-2 flex flex-wrap gap-2">{boards?.map(item => <li key={item.id}>
        <button type="button" disabled={working} onClick={() => { setOpenId(item.id); setNotice(''); }} className={`rounded-md border px-3 py-2 text-left text-xs ${item.id === openId ? 'border-primary bg-muted' : ''}`}>
          <span className="block max-w-56 truncate font-medium">{item.productTitle || 'Produto'}</span>
          <span className="text-muted-foreground">{BOARD_STATUS[item.status] ?? item.status} · {item.doneScenes}/{item.totalScenes} imagens</span></button></li>)}</ul></div>}

    {board && <div className="mt-6 border-t pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-medium">{board.productTitle}</p><p className="mt-1 text-sm text-muted-foreground">{board.concept}</p>
          {board.presenter && <p className="mt-1 text-xs text-muted-foreground">Personagem: {board.presenter}</p>}
          <p className="mt-1 text-xs text-muted-foreground">{BOARD_STATUS[board.status] ?? board.status} · gasto estimado até agora: {formatUsd(board.costMicros)}</p></div>
        <div className="flex flex-wrap gap-2">
          {remaining > 0 && !working && <Button onClick={() => void drawAll()}><ImageIcon />{remaining === board.scenes.length ? 'Gerar as imagens' : `Gerar as ${remaining} imagens que faltam`}</Button>}
          {busy === 'draw' && <Button variant="outline" onClick={() => { stop.current = true; }}>Parar</Button>}
          <Button variant="outline" disabled={working} onClick={() => void discardNow()}>{busy === 'discard' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Descartar</Button>
        </div>
      </div>
      {progress && <p role="status" className="mt-3 flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{progress}</p>}
      <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">{board.scenes.map(scene => <li key={scene.id} className="overflow-hidden rounded-md border">
        <div className="flex aspect-[2/3] items-center justify-center bg-muted">
          {scene.imageUrl ? <img src={scene.imageUrl} alt={`Cena ${scene.position + 1}: ${scene.title}`} className="size-full object-cover" /> : <span className="px-2 text-center text-xs text-muted-foreground">{SCENE_STATUS[scene.status] ?? scene.status}</span>}
        </div>
        <div className="space-y-1 p-2 text-xs"><p className="font-medium">{scene.position + 1}. {scene.title}</p><p className="text-muted-foreground">{scene.shot}</p>
          {scene.speech && <p>Fala: “{scene.speech}”</p>}
          {scene.onScreenText && <p className="text-muted-foreground">Texto na tela: {scene.onScreenText}</p>}
          {scene.status === 'failed' && scene.lastError && <p className="font-medium text-destructive">{scene.lastError}</p>}</div>
      </li>)}</ul>
    </div>}
    {notice && <p role="status" className="mt-4 break-words text-sm leading-relaxed">{notice}</p>}
  </section>;
}