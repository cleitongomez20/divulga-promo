import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Bot, LoaderCircle, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAutomation, saveAutomation } from '@/lib/automation.functions';
import { MODE_LABELS, type AutomationMode } from '@/lib/automation';

const MODE_HINTS: Record<AutomationMode, string> = {
  approval: 'os vídeos prontos ficam como rascunho até você aprovar. Recomendado no começo.',
  auto: 'os vídeos prontos são agendados sozinhos, sem a sua aprovação.',
};

/** The automation: switches, mode, Story and the character option. It lives on the Configurações screen. */
export function AutomationCard() {
  const queryClient = useQueryClient();
  const { data: automation } = useQuery({ queryKey: ['automation'], queryFn: () => getAutomation(), staleTime: 0, refetchInterval: 60_000 });
  const save = useServerFn(saveAutomation);
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<AutomationMode>('approval');
  const [story, setStory] = useState(true);
  const [speech, setSpeech] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // Shows what is saved once it arrives.
  useEffect(() => {
    if (automation) { setOn(automation.enabled); setMode(automation.mode); setStory(automation.storyAfterReel); setSpeech(automation.storyboardSpeech); }
  }, [automation?.enabled, automation?.mode, automation?.storyAfterReel, automation?.storyboardSpeech]);

  async function submit() {
    setBusy(true); setMessage('');
    try {
      const result = await save({ data: { enabled: on, mode, storyAfterReel: story, storyboardSpeech: speech } });
      setMessage(result.message);
      await queryClient.invalidateQueries({ queryKey: ['automation'] });
    } catch { setMessage('Não foi possível salvar a automação agora. Tente de novo.'); }
    finally { setBusy(false); }
  }

  return <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="auto-title">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Bot className="size-6 text-primary" /><h2 id="auto-title" className="text-lg font-semibold">Automação</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{automation?.enabled ? 'Ligada' : 'Desligada'}</span>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">Todo dia a automação cria os Reels, um de cada vez, espalhados dentro do seu horário de postagem (acima, em Ritmo de divulgação). Cada Reels vira, algumas horas depois, um Story com o mesmo vídeo. Os tetos de gasto da IA e do Higgsfield, quando existirem, continuam valendo.</p>
    <div className="mt-4 space-y-4">
      <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" className="size-5" checked={on} disabled={busy} onChange={e => setOn(e.target.checked)} />Ligar a automação</label>
      <fieldset><legend className="form-label">Modo</legend>
        <div className="grid gap-2">{(['approval', 'auto'] as const).map(item => <label key={item} className="flex items-start gap-3 text-sm">
          <input type="radio" name="auto-mode" className="mt-1 size-4" checked={mode === item} disabled={busy} onChange={() => setMode(item)} />
          <span><span className="font-medium">{MODE_LABELS[item]}:</span> {MODE_HINTS[item]}</span></label>)}</div>
      </fieldset>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="size-5" checked={story} disabled={busy} onChange={e => setStory(e.target.checked)} />Postar um Story com o mesmo vídeo algumas horas depois do Reels</label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-5" checked={speech} disabled={busy} onChange={e => setSpeech(e.target.checked)} />
        <span><span className="font-medium">Personagem falando nos vídeos (experimental).</span> Desmarcado, os vídeos são em formato POV: só as mãos de uma pessoa aparecem, em primeira pessoa e sem fala. Marcado, a IA cria uma pessoa que fala. Vale para a automação e para o botão Gerar conteúdo com a IA.</span></label>
    </div>
    <div className="mt-4"><Button type="button" className="h-11" disabled={busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar automação</Button></div>
    {automation?.enabled && <div className="mt-4 text-sm"><p className="font-medium">Hoje: {automation.madeToday} de {automation.targetToday} Reels criados.{automation.pending > 0 ? ` ${automation.pending} esperando você.` : ''}</p>{automation.message && <p className="mt-1 text-muted-foreground">{automation.message}</p>}</div>}
    {message && <p role="status" className="mt-4 break-words text-sm font-medium">{message}</p>}
  </section>;
}
