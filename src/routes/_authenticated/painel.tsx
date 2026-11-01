import { createFileRoute, Link } from '@tanstack/react-router';
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { useState, useTransition } from 'react';
import { CircleDollarSign, MousePointer2, ShoppingBag, Film, ArrowUpRight, CalendarDays, PackageOpen, Check, ShieldCheck, RefreshCw, LoaderCircle, FlaskConical, History } from 'lucide-react';
import { workspaceQuery } from '@/lib/workspace-query';
import { salesQuery } from '@/lib/sales-query';
import { syncSalesNow, syncHistoryStep } from '@/lib/sales.functions';
import { PERIODS, type PeriodKey } from '@/lib/conversions';
import { pageHead } from '@/lib/metadata';
import { WorkspaceShell } from '@/components/workspace-shell';
import { Button } from '@/components/ui/button';
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
  const { data: sales } = useSuspenseQuery(salesQuery(period));
  const queryClient = useQueryClient();
  const sync = useServerFn(syncSalesNow);
  const syncHistory = useServerFn(syncHistoryStep);
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const tz = sales.timezone;
  const when = (iso: string | null) => iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : '—';
  async function refresh() {
    setBusy(true); setNotice('');
    try { const r = await sync(); setNotice(r.message); await queryClient.invalidateQueries({ queryKey: ['sales'] }); }
    catch { setNotice('Não foi possível atualizar agora. Tente de novo em instantes.'); }
    finally { setBusy(false); }
  }
  const day = (iso: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: tz }).format(new Date(iso));
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  /** Loads the 90-day history one 7-day window at a time, respecting the 30s pause Shopee requires between queries. */
  async function loadHistory() {
    setHistoryBusy(true); setNotice(''); setProgress('Preparando a busca do histórico...');
    try {
      for (let step = 0; step < 40; step++) {
        const r = await syncHistory();
        if (r.status === 'wait') { const seconds = r.waitSeconds ?? 30; setProgress(`Aguardando ${seconds} segundos, uma pausa exigida pela Shopee...`); await sleep((seconds + 1) * 1000); continue; }
        if (r.status === 'done') {
          await queryClient.invalidateQueries({ queryKey: ['sales'] });
          if (!r.remaining) { setNotice('Histórico carregado. Suas vendas dos últimos 90 dias já estão na lista.'); return; }
          setProgress(`Buscando seu histórico: faltam ${r.remaining} etapas, cerca de ${Math.ceil(r.remaining * 31 / 60)} minutos. Mantenha esta página aberta.`);
          continue;
        }
        if (r.status === 'restart') { setProgress('A consulta demorou demais. Tentando de novo...'); continue; }
        setNotice(r.message); return;
      }
      setNotice('A busca foi pausada. Clique em Buscar histórico para continuar de onde parou.');
    } catch { setNotice('Não foi possível buscar o histórico agora. Tente de novo em instantes.'); }
    finally { setHistoryBusy(false); setProgress(''); }
  }
  const cards = [
    { icon: CircleDollarSign, title: 'Quanto você ganhou', value: money(sales.earnedCents), foot: sales.pendingCents ? `${money(sales.pendingCents)} ainda pendente` : `Vendas concluídas ${sales.periodPhrase}` },
    { icon: MousePointer2, title: 'Pessoas que clicaram', value: '0', foot: 'A contagem chega numa próxima etapa' },
    { icon: ShoppingBag, title: 'Pedidos recebidos', value: String(sales.ordersCount), foot: `Pedidos feitos ${sales.periodPhrase}` },
    { icon: Film, title: 'Publicações de hoje', value: '0', foot: 'Nenhuma publicação ainda' },
  ];
  return <WorkspaceShell><>
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">Meu painel</p><h1 className="text-3xl font-bold">Olá{data.profile?.name ? `, ${data.profile.name}` : ''}! Que bom te ver.</h1><p className="mt-3 text-muted-foreground">Veja aqui o que suas indicações já renderam.</p></div><span className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarDays className="size-4" />{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: tz }).format(new Date())}</span></div>
    {sales.simulated && <div role="status" className="mb-6 flex items-center gap-3 border-l-4 border-primary bg-accent p-4 text-sm font-medium text-accent-foreground"><FlaskConical className="size-5 shrink-0" />Modo de teste: estes números são exemplos. Conecte a Shopee para ver suas vendas reais.</div>}
    <div role="group" aria-label="Período" className="mb-6 flex flex-wrap gap-2">{PERIODS.map(p => <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => startSwitch(() => setPeriod(p.key))} className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors ${period === p.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'}`}>{p.label}</button>)}</div>
    <div className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-4 transition-opacity ${switching ? 'opacity-60' : ''}`}>{cards.map(({ icon: Icon, title, value, foot }) => <div className="rounded-lg border bg-card p-5" key={title}><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">{title}</span><Icon className="size-5 text-primary" /></div><p className="my-4 text-3xl font-semibold">{value}</p><p className="text-xs text-muted-foreground">{foot}</p></div>)}</div>
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><h2 className="text-lg font-semibold">Vendas do período</h2><p className="mt-1 text-xs text-muted-foreground">{sales.periodLabel}: de {day(sales.rangeFrom)} a {day(sales.rangeTo)} · Última atualização: {sales.simulated ? 'exemplo' : when(sales.lastSyncAt)}</p></div>
        <div className="flex flex-wrap gap-2">{!sales.simulated && !sales.historyLoaded && <Button variant="outline" onClick={loadHistory} disabled={busy || historyBusy}>{historyBusy ? <LoaderCircle className="animate-spin" /> : <History />}Buscar histórico</Button>}<Button variant="outline" onClick={refresh} disabled={busy || historyBusy}>{busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}Atualizar agora</Button></div></div>
      <p className="mt-3 text-xs text-muted-foreground">“Atualizar agora” busca os últimos 7 dias. Para trazer vendas mais antigas, use “Buscar histórico” (últimos 90 dias).</p>
      {progress && <p role="status" className="mt-3 text-sm font-medium">{progress}</p>}
      {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
      {sales.latest.length === 0 ? <div className="py-12 text-center"><PackageOpen className="mx-auto size-12 text-muted-foreground/60" /><h3 className="mt-4 font-semibold">Nenhuma venda {sales.periodPhrase}</h3><p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{sales.simulated || sales.historyLoaded ? 'Quando alguém comprar pelo seu link, a venda aparece nesta lista.' : 'Se você já tinha vendas antes, clique em “Buscar histórico” para trazê-las.'}</p></div> :
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
