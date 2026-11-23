import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { CircleAlert, CircleCheck, LoaderCircle, MessageCircleReply, RadioTower, Save, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkReplySetupFn, getReplyStatus, saveReplySettingsFn, subscribeCommentsFn } from '@/lib/comment-reply.functions';
import { DEFAULT_TEMPLATE, DEFAULT_TRIGGER, buildDm, replySettingsSchema } from '@/lib/comment-reply';
import type { SetupCheck } from '@/lib/comment-reply.server';

const STATUS_LABELS: Record<string, string> = { detected: 'Na fila', sending: 'Enviando', sent: 'Enviada', failed: 'Falhou', expired: 'Expirou', skipped: 'Ignorada' };

export function CommentReplyCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({ queryKey: ['comment-reply'], queryFn: () => getReplyStatus(), staleTime: 0, refetchInterval: 60_000 });
  const save = useServerFn(saveReplySettingsFn); const check = useServerFn(checkReplySetupFn); const subscribe = useServerFn(subscribeCommentsFn);
  const [enabled, setEnabled] = useState(false);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<SetupCheck | null>(null);

  // Shows what is saved once it arrives.
  useEffect(() => { if (status) { setEnabled(status.enabled); setTemplate(status.template); } }, [status?.enabled, status?.template]);

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name); setNotice('');
    try { await work(); } catch { setNotice('Não foi possível concluir agora. Tente de novo.'); } finally { setBusy(''); await queryClient.invalidateQueries({ queryKey: ['comment-reply'] }); }
  }
  const saveSettings = () => run('save', async () => {
    const parsed = replySettingsSchema.safeParse({ enabled, template });
    if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Confira a mensagem.'); return; }
    const outcome = await save({ data: parsed.data }); setNotice(outcome.message);
  });
  const subscribeNow = () => run('subscribe', async () => { const outcome = await subscribe(); setNotice(outcome.message); });
  const checkNow = () => run('check', async () => {
    const outcome = await check();
    if (outcome.status === 'ok') { setResult(outcome.check); setNotice(''); } else { setResult(null); setNotice(outcome.message); }
  });

  const preview = buildDm(template || DEFAULT_TEMPLATE, 'https://shope.ee/exemplo');
  return <section className="rounded-lg border bg-card p-5 sm:p-7 lg:col-span-2" aria-labelledby="reply-title">
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><MessageCircleReply className="size-7 text-primary" /><h2 id="reply-title" className="text-xl font-semibold">Resposta automática "{DEFAULT_TRIGGER}"</h2></div>
      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{isLoading ? 'Carregando...' : status?.enabled ? 'Ligada' : 'Desligada'}</span></div>
    <p className="mt-3 text-sm text-muted-foreground">Quando alguém comenta "{DEFAULT_TRIGGER}" num post publicado, o link do produto vai por mensagem privada para essa pessoa. O Instagram permite uma resposta privada por comentário, até 7 dias depois.</p>

    <div className="mt-6 rounded-md border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><RadioTower className="size-4" />Configuração na Meta (uma vez só)</h3>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
        <li>No painel do seu app na Meta, abra <strong>Webhooks</strong>, escolha o produto <strong>Instagram</strong> e clique em editar a assinatura.</li>
        <li>Em <strong>URL de callback</strong>, cole: <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{status?.webhookUrl ?? '...'}</code></li>
        <li>Em <strong>Token de verificação</strong>, use o mesmo valor do segredo <code className="rounded bg-muted px-1.5 py-0.5 text-xs">META_WEBHOOK_VERIFY_TOKEN</code> que você cria no Lovable (Cloud, Secrets). {status && !status.verifyTokenConfigured && <strong className="text-destructive">Ainda não encontrei esse segredo no app.</strong>}</li>
        <li>Verifique e salve, e ative o campo <strong>comments</strong>.</li>
        <li>Volte aqui, clique em <strong>Ativar recebimento</strong> e depois em <strong>Verificar configuração</strong>.</li>
      </ol>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void subscribeNow()}>{busy === 'subscribe' ? <LoaderCircle className="animate-spin" /> : <RadioTower />}Ativar recebimento</Button>
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void checkNow()}>{busy === 'check' ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}Verificar configuração</Button>
      </div>
      {result && <ul className="mt-4 space-y-2 text-sm">
        <li className="flex items-start gap-2">{result.permissions.ok ? <CircleCheck className="mt-0.5 size-4 text-primary" /> : <CircleAlert className="mt-0.5 size-4 text-destructive" />}
          <span>{result.permissions.ok ? 'As permissões de comentários e mensagens estão liberadas.' : `Faltam permissões na conexão: ${result.permissions.missing.join(', ')}. Gere o token de novo com essas permissões e reconecte.`}</span></li>
        <li className="flex items-start gap-2">{result.subscription?.ok ? <CircleCheck className="mt-0.5 size-4 text-primary" /> : <CircleAlert className="mt-0.5 size-4 text-destructive" />}
          <span>{result.subscription === null ? 'Não consegui ler o recebimento de comentários. A conexão precisa de uma Página do Facebook ligada ao Instagram.' : result.subscription.ok ? 'A Meta está enviando os comentários desta conta para o app.' : 'A Meta ainda não está enviando os comentários. Clique em "Ativar recebimento".'}</span></li>
      </ul>}
    </div>

    <div className="mt-6 space-y-4">
      <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" className="size-5" checked={enabled} disabled={Boolean(busy)} onChange={e => setEnabled(e.target.checked)} />Ligar a resposta automática</label>
      <div><label className="form-label" htmlFor="reply-template">Mensagem enviada</label>
        <textarea id="reply-template" className="field min-h-32" maxLength={600} value={template} disabled={Boolean(busy)} onChange={e => setTemplate(e.target.value)} />
        <p className="mt-1 text-xs text-muted-foreground">Use <code>{'{link}'}</code> onde o link de afiliado do produto deve entrar. Como vai chegar:</p>
        <p className="mt-2 whitespace-pre-line rounded-md bg-muted p-3 text-sm">{preview}</p></div>
      <Button type="button" disabled={Boolean(busy)} onClick={() => void saveSettings()}>{busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Save />}Salvar</Button>
    </div>
    {notice && <p role="status" className="mt-4 break-words text-sm leading-relaxed">{notice}</p>}
    {status?.enabled && status.lastMessage && <p className="mt-4 text-sm font-medium text-destructive">{status.lastMessage}</p>}

    {status && status.recent.length > 0 && <div className="mt-6 border-t pt-5">
      <h3 className="text-sm font-semibold">Últimos comentários atendidos</h3>
      <p className="mt-1 text-xs text-muted-foreground">Enviadas: {status.counts.sent} · Na fila: {status.counts.waiting} · Falharam: {status.counts.failed} (entre os últimos 30)</p>
      <ul className="mt-3 divide-y text-sm">{status.recent.map(item => <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
        <span>{item.username ? `@${item.username}` : 'Alguém'} <span className="text-xs text-muted-foreground">{new Date(item.at).toLocaleString('pt-BR')}</span></span>
        <span className={item.status === 'failed' ? 'font-medium text-destructive' : 'text-muted-foreground'}>{STATUS_LABELS[item.status] ?? item.status}{item.error && item.status !== 'sent' ? `: ${item.error}` : ''}</span></li>)}</ul>
    </div>}
  </section>;
}
