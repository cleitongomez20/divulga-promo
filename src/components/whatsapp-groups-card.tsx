import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { ChevronDown, LoaderCircle, Save, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getWhatsAppStatus } from '@/lib/whatsapp.functions';
import { loadWhatsAppGroups, saveGroupRules, type GroupsResult, type WhatsAppGroup } from '@/lib/whatsapp-groups.functions';
import { INTERVAL_OPTIONS, WEEKDAYS, describeRules, groupRulesSchema } from '@/lib/whatsapp-groups';

export function WhatsAppGroupsCard() {
  const queryClient = useQueryClient();
  const { data: wa } = useQuery({ queryKey: ['whatsapp'], queryFn: () => getWhatsAppStatus(), staleTime: 0 });
  const connected = wa?.connection === 'connected';
  const load = useServerFn(loadWhatsAppGroups);
  // Os grupos carregam sozinhos. Logo após conectar a lista pode vir vazia; nesse caso tenta de novo algumas vezes.
  const { data: list, isLoading } = useQuery({
    queryKey: ['whatsapp-groups'], queryFn: () => load(), enabled: connected, staleTime: 60_000,
    refetchInterval: query => { const d = query.state.data; const empty = !d || !d.ok || d.groups.length === 0; return empty && query.state.dataUpdateCount < 8 ? 8000 : false; },
  });
  if (!connected) return null;

  const groups = list?.ok ? list.groups : [];
  return <section className="min-w-0 rounded-lg border bg-card p-4 sm:p-7 lg:col-span-2" aria-labelledby="wa-groups-title">
    <div className="flex items-center gap-3"><Users className="size-7 shrink-0 text-primary" /><h2 id="wa-groups-title" className="text-xl font-semibold">Grupos de ofertas</h2></div>
    <p className="mt-3 text-sm text-muted-foreground">Os grupos do número conectado são carregados automaticamente sempre que você abre esta tela. Escolha em quais o Divulga Promo pode postar e defina, para cada um, a categoria, os dias, o horário e o intervalo.</p>
    {isLoading && <p role="status" className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Carregando seus grupos, isso pode levar alguns segundos...</p>}
    {list && !list.ok && <p role="status" className="mt-5 text-sm">{list.message}</p>}
    {list?.ok && groups.length === 0 && <p role="status" className="mt-5 text-sm text-muted-foreground">Nenhum grupo encontrado ainda. Se o número acabou de conectar, aguarde alguns segundos. Se ele não participa de nenhum grupo, adicione-o a um e recarregue a página.</p>}
    <ul className="mt-5 space-y-3">{groups.map(group => <GroupItem key={group.id} group={group} onSaved={result => queryClient.setQueryData(['whatsapp-groups'], result)} />)}</ul>
  </section>;
}

function GroupItem({ group, onSaved }: { group: WhatsAppGroup; onSaved: (result: GroupsResult) => void }) {
  const save = useServerFn(saveGroupRules);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [enabled, setEnabled] = useState(group.enabled);
  const [category, setCategory] = useState(group.categoryId === null ? '' : String(group.categoryId));
  const [keyword, setKeyword] = useState(group.keyword);
  const [days, setDays] = useState<number[]>(group.days);
  const [start, setStart] = useState(group.windowStart); const [end, setEnd] = useState(group.windowEnd);
  const [interval, setIntervalMinutes] = useState(group.intervalMinutes);
  const toggleDay = (value: number) => setDays(prev => (prev.includes(value) ? prev.filter(d => d !== value) : [...prev, value]));

  async function submit() {
    const parsed = groupRulesSchema.safeParse({ groupId: group.id, enabled, categoryId: category.trim() ? Number(category) : null, keyword, days, windowStart: start, windowEnd: end, intervalMinutes: interval });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira os dados.'); return; }
    setBusy(true); setNotice('');
    try {
      const result = await save({ data: parsed.data });
      if (result.ok) { onSaved(result); setNotice('Regras salvas.'); } else setNotice(result.message);
    } catch { setNotice('Não foi possível salvar agora. Tente de novo.'); }
    finally { setBusy(false); }
  }

  return <li className="min-w-0 rounded-lg border">
    <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 p-3 text-left sm:p-4" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="min-w-0"><span className="block truncate font-medium">{group.name}</span><span className="block break-words text-xs text-muted-foreground">{group.size !== null ? `${group.size} participantes · ` : ''}{describeRules(group)}</span></span>
      <ChevronDown className={`size-5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
    </button>
    {open && <div className="space-y-5 border-t p-3 sm:p-4">
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium"><input type="checkbox" className="size-5" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Postar ofertas neste grupo</label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className="form-label" htmlFor={`cat-${group.id}`}>ID da categoria da Shopee</label><input id={`cat-${group.id}`} className="field" inputMode="numeric" autoComplete="off" placeholder="Exemplo: 100017" value={category} onChange={e => setCategory(e.target.value.replace(/\D/g, '').slice(0, 10))} /></div>
        <div><label className="form-label" htmlFor={`kw-${group.id}`}>Palavra-chave (opcional)</label><input id={`kw-${group.id}`} className="field" autoComplete="off" maxLength={60} value={keyword} onChange={e => setKeyword(e.target.value)} /></div>
      </div>
      <fieldset><legend className="form-label">Dias da semana</legend><div className="mt-2 flex flex-wrap gap-2">{WEEKDAYS.map(d => <button key={d.value} type="button" aria-pressed={days.includes(d.value)} aria-label={d.long} onClick={() => toggleDay(d.value)} className={`min-h-11 min-w-12 rounded-md border px-3 text-sm font-medium ${days.includes(d.value) ? 'border-primary bg-primary text-primary-foreground' : 'bg-background'}`}>{d.short}</button>)}</div></fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <div><label className="form-label" htmlFor={`from-${group.id}`}>Começa às</label><input id={`from-${group.id}`} type="time" className="field" value={start} onChange={e => setStart(e.target.value)} /></div>
        <div><label className="form-label" htmlFor={`to-${group.id}`}>Termina às</label><input id={`to-${group.id}`} type="time" className="field" value={end} onChange={e => setEnd(e.target.value)} /></div>
        <div><label className="form-label" htmlFor={`int-${group.id}`}>Intervalo entre ofertas</label><select id={`int-${group.id}`} className="field" value={interval} onChange={e => setIntervalMinutes(Number(e.target.value))}>{INTERVAL_OPTIONS.map(m => <option key={m} value={m}>{m} minutos</option>)}</select></div>
      </div>
      <Button className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={submit}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar regras</Button>
      {notice && <p role="status" className="break-words text-sm">{notice}</p>}
    </div>}
  </li>;
}
