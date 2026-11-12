import { createFileRoute } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search, Star, Copy, Check, ExternalLink, LoaderCircle, FlaskConical, ShoppingBag, X } from 'lucide-react';
import { WorkspaceShell } from '@/components/workspace-shell';
import { Button } from '@/components/ui/button';
import { pageHead } from '@/lib/metadata';
import { searchProducts, createAffiliateLink } from '@/lib/products.functions';
import { SORTS, formatPercent, formatMoney, priceText, sortProducts, type ProductItem } from '@/lib/products';

export const Route = createFileRoute('/_authenticated/produtos')({
  head: () => pageHead('Produtos', 'Encontre produtos da Shopee e gere links de afiliado.'),
  component: ProductsPage,
});

type Criteria = { keyword: string; category: number | undefined };
type LinkState = { url?: string; error?: string };
type CopyState = 'busy' | 'copied';
type Cached = { items: ProductItem[]; pages: [string, number][]; page: number; hasNext: boolean; simulated: boolean; at: number };
const inputClass = 'h-11 w-full rounded-md border bg-background px-3 text-base';
const FRESH_MS = 10 * 60 * 1000;
// The recommended list is remembered for a few minutes, so coming back to this page does not call the Shopee again.
let recommendedCache: Cached | null = null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const LINK_GAP_MS = 3200; // the server keeps at least 3 seconds between link requests
// Affiliate links already made on click, remembered while the page stays open so nothing is generated twice.
const linkCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let linkChain: Promise<unknown> = Promise.resolve();
let lastLinkAt = 0;

function ProductsPage() {
  const search = useServerFn(searchProducts);
  const makeLinkFn = useServerFn(createAffiliateLink);
  const makeLinkRef = useRef(makeLinkFn);
  makeLinkRef.current = makeLinkFn;
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [sortType, setSortType] = useState(2);
  const [criteria, setCriteria] = useState<Criteria>({ keyword: '', category: undefined });
  const [items, setItems] = useState<ProductItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [simulated, setSimulated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [copyUi, setCopyUi] = useState<Record<string, CopyState>>({});
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(true);
  const stopped = useRef(false); // set after a failed page, so scrolling does not keep retrying by itself
  const itemsRef = useRef<ProductItem[]>([]);
  const started = useRef(false);
  const filtered = Boolean(criteria.keyword || criteria.category);
  const pageOf = useRef(new Map<string, number>()); // which page each product came from
  const [more, setMore] = useState(false); // a next page is being added below the list
  // The chosen order is applied inside each loaded page, and pages stay one after the other.
  // So new products always land below the ones already seen and the screen never jumps.
  const shown = useMemo(() => {
    const groups = new Map<number, ProductItem[]>();
    for (const item of items) { const n = pageOf.current.get(item.itemId) ?? 1; groups.set(n, [...(groups.get(n) ?? []), item]); }
    return [...groups.keys()].sort((a, b) => a - b).flatMap(n => sortProducts(groups.get(n) ?? [], sortType));
  }, [items, sortType]);

  async function run(nextPage: number, used: Criteria, sort: number, attempt = 0): Promise<void> {
    setLoading(true); loadingRef.current = true; setMessage(''); setMore(nextPage > 1); if (nextPage === 1) { stopped.current = false; pageOf.current = new Map(); }
    try {
      const result = await search({ data: { sortType: sort, page: nextPage, ...(used.keyword ? { keyword: used.keyword } : {}), ...(used.category ? { productCatId: used.category } : {}) } });
      if (result.status === 'ok') {
        const fresh = nextPage === 1 ? result.items : result.items.filter(item => !itemsRef.current.some(old => old.itemId === item.itemId));
        for (const item of fresh) pageOf.current.set(item.itemId, nextPage);
        const merged = nextPage === 1 ? fresh : [...itemsRef.current, ...fresh];
        itemsRef.current = merged;
        setItems(merged); setPage(result.page); setHasNext(result.hasNextPage); setSimulated(result.simulated); setLoaded(true);
        if (!used.keyword && !used.category) recommendedCache = { items: merged, pages: [...pageOf.current], page: result.page, hasNext: result.hasNextPage, simulated: result.simulated, at: Date.now() };
      } else if (result.status === 'wait' && attempt < 2) {
        setMessage('Só um instante, buscando os produtos...');
        await sleep((result.waitSeconds ?? 2) * 1000 + 300);
        return run(nextPage, used, sort, attempt + 1);
      } else { setMessage(result.message); stopped.current = true; }
    } catch { setMessage('Não foi possível buscar produtos agora. Tente de novo em instantes.'); stopped.current = true; }
    finally { setLoading(false); loadingRef.current = false; }
  }

  function showRecommended() {
    const used = { keyword: '', category: undefined };
    setCriteria(used); setLinks({});
    if (recommendedCache && Date.now() - recommendedCache.at < FRESH_MS) {
      itemsRef.current = recommendedCache.items; pageOf.current = new Map(recommendedCache.pages);
      setItems(recommendedCache.items); setPage(recommendedCache.page); setHasNext(recommendedCache.hasNext); setSimulated(recommendedCache.simulated); setLoaded(true); setLoading(false); loadingRef.current = false; setMessage('');
    } else void run(1, used, sortType);
  }
  // The recommended products are shown as soon as the page opens, without pressing any button.
  useEffect(() => { if (started.current) return; started.current = true; showRecommended(); }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cat = category.trim() ? Number(category) : undefined;
    if (cat !== undefined && (!Number.isInteger(cat) || cat <= 0)) { setMessage('O número da categoria deve conter apenas dígitos.'); return; }
    const used = { keyword: keyword.trim(), category: cat };
    if (!used.keyword && !used.category) { setKeyword(''); showRecommended(); return; }
    setCriteria(used); setLinks({}); void run(1, used, sortType);
  }
  function clear() { setKeyword(''); setCategory(''); showRecommended(); }
  function changeSort(value: number) {
    setSortType(value);
    // With a keyword or category the Shopee sorts the whole list; otherwise the order is applied here, to what is loaded.
    if (filtered) void run(1, criteria, value);
  }
  /** Makes the affiliate link for one product, only when the user asks for it. Requests go one at a time, with the pause the server requires. */
  function ensureLink(item: ProductItem): Promise<string | null> {
    const id = item.itemId;
    const cached = linkCache.get(id); if (cached) return Promise.resolve(cached);
    const running = inflight.get(id); if (running) return running;
    const job = linkChain.then(async () => {
      const ready = linkCache.get(id); if (ready) return ready;
      for (let attempt = 0; attempt < 3; attempt++) {
        const gap = LINK_GAP_MS - (Date.now() - lastLinkAt); if (gap > 0) await sleep(gap);
        lastLinkAt = Date.now();
        try {
          const result = await makeLinkRef.current({ data: { productLink: item.productLink, itemId: id } });
          if (result.status === 'ok') { linkCache.set(id, result.shortLink); setLinks(previous => ({ ...previous, [id]: { url: result.shortLink } })); return result.shortLink; }
          if (result.status === 'wait' && attempt < 2) { await sleep((result.waitSeconds ?? 3) * 1000); continue; }
          setLinks(previous => ({ ...previous, [id]: { error: result.message } })); return null;
        } catch { setLinks(previous => ({ ...previous, [id]: { error: 'Não foi possível gerar o link agora.' } })); return null; }
      }
      return null;
    }).finally(() => { inflight.delete(id); });
    linkChain = job.catch(() => null);
    inflight.set(id, job);
    return job;
  }
  async function copy(item: ProductItem) {
    const id = item.itemId;
    setLinks(previous => ({ ...previous, [id]: { ...(previous[id]?.url ? { url: previous[id]?.url } : {}) } })); // clears an old error
    let url = linkCache.get(id) ?? null;
    if (!url) { setCopyUi(previous => ({ ...previous, [id]: 'busy' })); url = await ensureLink(item); }
    if (!url) { setCopyUi(previous => { const { [id]: _drop, ...rest } = previous; return rest; }); return; }
    try {
      await navigator.clipboard.writeText(url);
      setCopyUi(previous => ({ ...previous, [id]: 'copied' }));
      setTimeout(() => setCopyUi(previous => { const { [id]: _drop, ...rest } = previous; return rest; }), 2000);
    } catch {
      setCopyUi(previous => { const { [id]: _drop, ...rest } = previous; return rest; });
      setLinks(previous => ({ ...previous, [id]: { url, error: 'Não foi possível copiar sozinho. Toque no link e copie manualmente.' } }));
    }
  }

  // Infinite scroll: when the end of the list gets close, the next page is loaded.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNext || loading) return;
    const watcher = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !loadingRef.current && !stopped.current) void run(page + 1, criteria, sortType);
    }, { rootMargin: '200px' });
    watcher.observe(node);
    return () => watcher.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNext, loading, page, items.length, criteria, sortType]);

  const heading = criteria.keyword ? `Resultados para “${criteria.keyword}”` : criteria.category ? `Produtos da categoria ${criteria.category}` : 'Recomendados pela Shopee';
  return <WorkspaceShell>
    <p className="text-xs font-semibold uppercase tracking-widest text-primary">Achadinhos</p>
    <h1 className="mt-3 text-3xl font-bold">Produtos</h1>
    <p className="mt-2 max-w-2xl text-muted-foreground">Veja produtos da Shopee e quanto cada um pode render de comissão. Para procurar algo específico, use a busca.</p>
    {simulated && <div role="status" className="mt-6 flex items-center gap-3 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground"><FlaskConical className="size-5 shrink-0" />Modo de teste (dados simulados)</div>}
    <form onSubmit={submit} className="mt-8 rounded-lg border bg-card p-5">
      <label htmlFor="keyword" className="text-sm font-medium">Buscar por palavra-chave</label>
      <div className="mt-1 flex flex-col gap-3 sm:flex-row">
        <input id="keyword" value={keyword} onChange={e => setKeyword(e.target.value)} maxLength={100} placeholder="Ex.: organizador de cozinha" className={inputClass} />
        <Button type="submit" disabled={loading} className="min-h-11 sm:w-auto">{loading && filtered ? <LoaderCircle className="animate-spin" /> : <Search />}Buscar</Button>
        {filtered && <Button type="button" variant="outline" onClick={clear} className="min-h-11 sm:w-auto"><X />Limpar busca</Button>}
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">Opções avançadas</summary>
        <label className="mt-3 grid max-w-xs gap-1 font-medium">Número da categoria (opcional)<input value={category} onChange={e => setCategory(e.target.value)} inputMode="numeric" placeholder="Ex.: 100001" className={inputClass} /></label>
        <p className="mt-2 text-xs text-muted-foreground">Os números das categorias estão no <a className="underline" href="https://seller.shopee.com.br/edu/category-guide" target="_blank" rel="noopener noreferrer">guia de categorias da Shopee</a>.</p>
      </details>
    </form>
    <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
      <h2 className="text-lg font-semibold">{heading}</h2>
      <label className="grid gap-1 text-sm font-medium">Ordenar por<select value={sortType} onChange={e => changeSort(Number(e.target.value))} className="h-11 rounded-md border bg-background px-3 text-base">{SORTS.map(sort => <option key={sort.value} value={sort.value} disabled={sort.value === 1 && !criteria.keyword}>{sort.label}</option>)}</select></label>
    </div>
    {!filtered && <p className="mt-2 text-xs text-muted-foreground">Sem palavra-chave, a Shopee mostra a lista de recomendados e não permite ordená-la. A ordem escolhida vale para os produtos carregados aqui. Para ordenar toda a lista da Shopee, busque por uma palavra-chave ou categoria.</p>}
    {message && <p role="status" className="mt-4 text-sm font-medium">{message}</p>}
    {loading && items.length === 0 && <p role="status" className="mt-8 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando produtos...</p>}
    {loaded && items.length === 0 && !loading && !message && <div className="py-12 text-center"><ShoppingBag className="mx-auto size-12 text-muted-foreground/60" /><h2 className="mt-4 font-semibold">Nenhum produto encontrado</h2><p className="mt-2 text-sm text-muted-foreground">Tente outra palavra-chave.</p></div>}
    {items.length > 0 && <>
      <p className="mt-4 text-xs text-muted-foreground">{items.length} {items.length === 1 ? 'produto' : 'produtos'}. A comissão mostrada é a taxa máxima; o valor final aparece na venda.</p>
      <ul className={`mt-3 grid gap-4 transition-opacity lg:grid-cols-2 ${loading && !more ? 'opacity-60' : ''}`}>{shown.map(item => {
        const link = links[item.itemId]; const ui = copyUi[item.itemId];
        return <li key={item.itemId} className="flex gap-4 rounded-lg border bg-card p-4">
          <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">{item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} className="size-full object-cover" /> : <ShoppingBag className="size-8 text-muted-foreground/60" />}</div>
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-semibold">{item.name}</h3>
            {item.shopName && <p className="mt-1 truncate text-xs text-muted-foreground">{item.shopName}</p>}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {item.ratingStar !== null && item.ratingStar > 0 ? <span className="inline-flex items-center gap-1"><Star className="size-3.5 fill-current text-primary" />{item.ratingStar.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</span> : <span className="text-muted-foreground">Sem avaliações</span>}
              {item.sales !== null && <span>{item.sales.toLocaleString('pt-BR')} vendidos</span>}
              {item.commissionRate !== null && <span className="font-semibold text-primary">Comissão até {formatPercent(item.commissionRate)}{item.commissionAmount !== null && ` (${formatMoney(item.commissionAmount)})`}</span>}
            </p>
            <p className="mt-1 text-sm font-semibold">{priceText(item)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="min-h-11" onClick={() => void copy(item)} disabled={ui === 'busy'}>{ui === 'busy' ? <LoaderCircle className="animate-spin" /> : ui === 'copied' ? <Check /> : <Copy />}{ui === 'busy' ? 'Gerando link...' : ui === 'copied' ? 'Link copiado' : 'Copiar link de afiliado'}</Button>
              <Button size="sm" variant="ghost" className="min-h-11" asChild><a href={item.productLink} target="_blank" rel="noopener noreferrer"><ExternalLink />Ver na Shopee</a></Button>
            </div>
            {link?.url && link.error && <input readOnly value={link.url} aria-label="Link de afiliado" onFocus={e => e.currentTarget.select()} className="mt-3 h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm" />}
            {link?.error && <p role="status" className="mt-2 text-xs font-medium">{link.error}</p>}
          </div>
        </li>;
      })}</ul>
      {hasNext && <div ref={sentinel} className="mt-6 flex h-16 items-center justify-center text-sm text-muted-foreground">{loading ? <span role="status" className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />Carregando mais produtos...</span> : stopped.current ? <Button variant="outline" className="min-h-11" onClick={() => { stopped.current = false; void run(page + 1, criteria, sortType); }}>Tentar de novo</Button> : null}</div>}
    </>}
  </WorkspaceShell>;
}