import { createFileRoute, Link } from '@tanstack/react-router';
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useEffect, useState, useTransition } from 'react';
import { CircleDollarSign, MousePointer2, ShoppingBag, Film, ArrowUpRight, CalendarDays, ChevronDown, PackageOpen, Check, ShieldCheck, FlaskConical } from 'lucide-react';
import { workspaceQuery } from '@/lib/workspace-query';
import { salesQuery } from '@/lib/sales-query';
import { syncSalesStep } from '@/lib/sales.functions';
import { PERIODS, type PeriodKey } from '@/lib/conversions';
import { pageHead } from '@/lib/metadata';
import { WorkspaceShell } from '@/components/workspace-shell';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import image from '@/assets/home-products.jpg';

export const Route = createFileRoute('/_authenticated/painel')({
  head: () => pageHead('Meu painel', 'Seu espaço privado para acompanhar ganhos, pedidos e divulgações.'),
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(workspaceQuery), context.queryClient.ensureQueryData(salesQuery('month'))]),
  component: Dashboard,
});

const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const statusLabel = { completed: 'Concluído', pending: 'Pendente', cancelled: 'Cancelado' } as const;

function Dashboard() {
  const { data } = useSuspenseQuery(workspaceQuery);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [switching, startSwitch] = useTransition();
  const [custom, setCustom] = useState<{ from: string; to: string } | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const { data: sales } = useSuspenseQuery(salesQuery(period, period === 'custom' ? custom : undefined));
  const queryClient = useQueryClient();
  const syncStep = useServerFn(syncSalesStep);
  const [progress, setProgress] = useState('');
  const tz = sales.timezone;
  const isoDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  const todayIso = isoDay(Date.now());
  const oldestIso = isoDay(Date.now() - 92 * 86_400_000); // the Shopee only informs the last 3 months
  const brDate = (iso: string) => iso.split('-').reverse().join('/');
  const triggerLabel = period === 'custom' && custom ? `${brDate(custom.from)} a ${brDate(custom.to)}` : sales.periodLabel;
  const chooseCustom = () => { setDraftFrom(custom?.from ?? todayIso); setDraftTo(custom?.to ?? todayIso); setCustomOpen(true); };
  const applyCustom = () => {
    const [first, last] = draftFrom <= draftTo ? [draftFrom, draftTo] : [draftTo, draftFrom];
    startSwitch(() => { setCustom({ from: first, to: last }); setPeriod('custom'); setMenuOpen(false); });
  };
  const when = (iso: string | null) => iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : '—';
  const day = (iso: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: tz }).format(new Date(iso));
  const dayFull = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: tz }).format(new Date(iso));
  const simulated = sales.simulated, intervalMinutes = sales.syncIntervalMinutes;
  /** Keeps the Shopee sales up to date on its own: first the history (one 7-day window at a time, with the 31s pause Shopee requires),
   *  then a refresh every few minutes. The server decides what each step fetches and pauses itself after errors. */
  useEffect(() => {
    if (simulated) return;
    let stopped = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(() => { timers.delete(t); resolve(); }, ms); timers.add(t); });
    const refreshSales = () => queryClient.invalidateQueries({ queryKey: ['sales'] });
    (async () => {
      while (!stopped) {
        let r;
        try { r = await syncStep(); } catch { await sleep(60_000); continue; }
        if (stopped) return;
        if (r.status === 'simulated') return;
        if (r.status === 'wait') { await sleep(((r.waitSeconds ?? 30) + 1) * 1000); continue; }
        if (r.status === 'busy') { await sleep(15_000); continue; }
        if (r.status === 'restart') { await sleep(5_000); continue; }
        if (r.status === 'done') {
          await refreshSales();
          if (r.remaining) { setProgress(`Buscando seu histórico de vendas: faltam ${r.remaining} ${r.remaining === 1 ? 'etapa' : 'etapas'}, cerca de ${Math.max(1, Math.ceil(r.remaining * 31 / 60))} min.`); continue; }
          setProgress('');
          await sleep(Math.max(5, intervalMinutes) * 60_000);
          continue;
        }
        setProgress(''); // paused or error: the server already backs off, so just check again later
        await sleep(5 * 60_000);
      }
    })();
    return () => { stopped = true; timers.forEach(clearTimeout); };
  }, [simulated, intervalMinutes, queryClient, syncStep]);
  // Same wording as the period filter, e.g. "Nos últimos 7 dias", "Neste mês", "Hoje".
  const periodFoot = sales.periodPhrase.charAt(0).toUpperCase() + sales.periodPhrase.slice(1);
  const cards = [
    { icon: CircleDollarSign, title: 'Quanto você ganhou', value: money(sales.earnedCents), foot: sales.pendingCents ? `${money(sales.pendingCents)} ainda pendente` : `Vendas concluídas ${sales.periodPhrase}` },
    { icon: MousePointer2, title: 'Cliques no Link', value: '0', foot: 'A contagem chega numa próxima etapa' },
    { icon: ShoppingBag, title: 'Pedidos realizados', value: String(sales.ordersCount), foot: periodFoot },
    { icon: Film, title: 'Publicações de hoje', value: String(sales.publishedToday), foot: sales.publishedToday ? `${sales.publishedToday === 1 ? 'Publicação feita' : 'Publicações feitas'} hoje` : 'Nenhuma publicação ainda' },
  ];
  return <WorkspaceShell><>
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">Meu painel</p><h1 className="text-3xl font-bold">Olá{data.profile?.name ? `, ${data.profile.name}` : ''}! Que bom te ver.</h1><p className="mt-3 text-muted-foreground">Veja aqui o que suas indicações já renderam.</p></div><Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild><Button variant="outline" className="min-h-11 gap-2" aria-label="Escolher período"><CalendarDays className="size-4" />{triggerLabel}<ChevronDown className="size-4" /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <ul role="listbox" aria-label="Período" className="flex flex-col">
          {PERIODS.map(p => <li key={p.key}><button type="button" role="option" aria-selected={period === p.key} onClick={() => startSwitch(() => { setPeriod(p.key); setCustomOpen(false); setMenuOpen(false); })} className={`flex min-h-11 w-full items-center justify-between rounded-md px-3 text-sm hover:bg-accent ${period === p.key ? 'font-semibold text-primary' : ''}`}>{p.label}{period === p.key && <Check className="size-4" />}</button></li>)}
          <li><button type="button" role="option" aria-selected={period === 'custom'} onClick={chooseCustom} className={`flex min-h-11 w-full items-center justify-between rounded-md px-3 text-sm hover:bg-accent ${period === 'custom' ? 'font-semibold text-primary' : ''}`}>Personalizado{period === 'custom' && <Check className="size-4" />}</button></li>
        </ul>
        {customOpen && <div className="mt-2 grid gap-3 border-t p-3">
          <label className="grid gap-1 text-xs font-medium">De<input type="date" value={draftFrom} min={oldestIso} max={todayIso} onChange={e => setDraftFrom(e.target.value)} className="h-11 rounded-md border bg-background px-3 text-sm" /></label>
          <label className="grid gap-1 text-xs font-medium">Até<input type="date" value={draftTo} min={oldestIso} max={todayIso} onChange={e => setDraftTo(e.target.value)} className="h-11 rounded-md border bg-background px-3 text-sm" /></label>
          <p className="text-xs text-muted-foreground">A Shopee informa as vendas dos últimos 3 meses.</p>
          <Button onClick={applyCustom} disabled={!draftFrom || !draftTo}>Aplicar</Button>
        </div>}
      </PopoverContent>
    </Popover></div>
    {sales.simulated && <div role="status" className="mb-6 flex items-center gap-3 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground"><FlaskConical className="size-5 shrink-0" />Modo de teste: estes números são exemplos. Conecte a Shopee para ver suas vendas reais.</div>}
    <div className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-4 transition-opacity ${switching ? 'opacity-60' : ''}`}>{cards.map(({ icon: Icon, title, value, foot }) => <div className="rounded-lg border bg-card p-5" key={title}><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">{title}</span><Icon className="size-5 text-primary" /></div><p className="my-4 text-3xl font-semibold">{value}</p><p className="text-xs text-muted-foreground">{foot}</p></div>)}</div>
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><h2 className="text-lg font-semibold">Vendas do período</h2><p className="mt-1 text-xs text-muted-foreground">{sales.periodLabel}: de {period === 'custom' ? dayFull(sales.rangeFrom) : day(sales.rangeFrom)} a {period === 'custom' ? dayFull(sales.rangeTo) : day(sales.rangeTo)} · Última atualização: {sales.simulated ? 'exemplo' : when(sales.lastSyncAt)}</p></div></div>
      {progress && <p role="status" className="mt-3 text-sm font-medium">{progress}</p>}
      {sales.latest.length === 0 ? <div className="py-12 text-center"><PackageOpen className="mx-auto size-12 text-muted-foreground/60" /><h3 className="mt-4 font-semibold">Nenhuma venda {sales.periodPhrase}</h3><p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{sales.simulated || sales.historyLoaded ? 'Quando alguém comprar pelo seu link, a venda aparece nesta lista.' : 'Estamos trazendo suas vendas da Shopee. Elas aparecem aqui automaticamente.'}</p></div> :
        <><p className="mt-3 text-xs text-muted-foreground">{sales.totalInPeriod > sales.latest.length ? `Mostrando as ${sales.latest.length} mais recentes de ${sales.totalInPeriod} itens.` : `${sales.totalInPeriod} ${sales.totalInPeriod === 1 ? 'item' : 'itens'} no período.`}</p><ul className="divide-y">{sales.latest.map(s => <li key={s.id} className="flex items-center gap-4 py-4">
          {s.image ? <img src={s.image} alt="" width={56} height={56} loading="lazy" className="size-14 shrink-0 rounded-md object-cover" /> : <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted"><ShoppingBag className="size-5 text-muted-foreground" /></div>}
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{s.product}</p><p className="mt-1 text-xs text-muted-foreground">{when(s.date)} · {s.store}</p></div>
          <div className="text-right"><p className={`text-sm font-semibold ${s.status === 'cancelled' || s.fraud ? 'text-muted-foreground line-through' : ''}`}>{money(s.commissionCents)}</p><p className="mt-1 text-xs text-muted-foreground">{s.fraud ? 'Não contabilizado' : statusLabel[s.status as keyof typeof statusLabel] ?? 'Pendente'}</p></div>
        </li>)}</ul></>}
    </section>
    <section className="relative my-10 min-h-56 overflow-hidden bg-accent"><img src={image} alt="Acessórios para casa" width={1024} height={1024} className="absolute right-0 top-0 h-full w-1/2 object-cover opacity-50 md:opacity-100" loading="lazy" /><div className="relative z-10 max-w-md p-7 md:p-9"><span className="text-xs font-semibold uppercase tracking-widest text-primary">Uma etapa de cada vez</span><h2 className="mt-3 text-2xl font-semibold">Tudo começa com<br />uma conta bem cuidada.</h2><p className="mt-3 text-sm text-muted-foreground">Confira sua conexão com a Shopee e seus horários.</p><Button asChild className="mt-5"><Link to="/conexoes">Ver minhas conexões<ArrowUpRight /></Link></Button></div></section>
    <section><h2 className="border-b pb-4 text-lg font-semibold">Sua conta, no caminho certo</h2><div className="flex gap-3 border-b py-5"><Check className="size-5 text-primary" /><div><p className="text-sm font-semibold">Espaço privado criado</p><p className="mt-1 text-xs text-muted-foreground">Seus dados pertencem somente à sua conta.</p></div></div><div className="flex gap-3 border-b py-5"><ShieldCheck className="size-5 text-primary" /><div><p className="text-sm font-semibold">Acesso protegido</p><p className="mt-1 text-xs text-muted-foreground">Seu acesso é feito com e-mail e senha.</p></div></div><Button asChild variant="link" className="mt-3 px-0"><Link to="/historico">Ver histórico da conta<ArrowUpRight /></Link></Button></section>
  </></WorkspaceShell>;
}
