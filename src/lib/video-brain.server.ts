// Server-only: the video director. The code decides what the AI may choose from and checks everything it writes; the AI picks a product,
// a video tool from our catalog and writes the plan. The code then orders the video and follows it until it is ready (see video-jobs.server.ts).
// Nothing is published here: a finished video always lands as a draft for the user to approve.
import type { SupabaseClient } from '@supabase/supabase-js';
import { askAi } from './ai.server';
import type { ClaudeMessage } from './claude.server';
import { TRIGGER_WORD, feedbackMessage, subIdOf, type ProductCandidate } from './content-brain';
import { BrainError, loadCandidatePool, storeProductPhoto } from './content-brain.server';
import { HiggsfieldError, credentialsForJob, errorForStatus, hfCall, markInvalid, recordMediaUsage } from './higgsfield.server';
import type { AutomationMode } from './automation';
import { MEDIA_BUCKET } from './posts';
import { encodeSubIds } from './products';
import {
  MAX_CONCURRENT_VIDEOS, VIDEO_TOOLS, buildHiggsfieldBody, buildVideoPrompt, estimateVideoMicros, judgeVideoAnswer, videoCaption, type VideoFormat, type VideoJob, type VideoOutput,
} from './video-brain';

type Db = SupabaseClient;
type Fetcher = typeof fetch;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

export type VideoDraftResult = { postId: string; productTitle: string; tool: string; duration: number; costMicros: number; estimatedMicros: number; linkMissing: boolean };

export async function startVideoDraft(db: Db, p: {
  userId: string; masterKey: string; format: VideoFormat; fetcher?: Fetcher; now?: () => number;
  /** Turns a Shopee product address into a tracked affiliate link. Returns null when it cannot (the post is then created without a link). */
  makeLink?: (productUrl: string, subIds: string[]) => Promise<string | null>;
  /** Set by the automation: the post is marked as made by it, remembers the planned time, and (in automatic mode) is scheduled by itself when the video is ready. */
  auto?: { mode: AutomationMode; scheduledAt: string };
}): Promise<VideoDraftResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now; const at = now();

  // Cheap checks first, before any money is spent: Higgsfield connected and accepted, monthly cap not already used up, few videos in progress.
  await credentialsForJob(db, { userId: p.userId, masterKey: p.masterKey, estimateMicros: 0, now });
  const running = await db.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', p.userId).eq('status', 'rendering');
  if ((running.count ?? 0) >= MAX_CONCURRENT_VIDEOS) throw new BrainError(`Já há ${MAX_CONCURRENT_VIDEOS} vídeos sendo gerados. Espere um terminar para pedir outro.`);
  const { accountId, candidates } = await loadCandidatePool(db, p.userId, at);

  // The AI answers, the code checks. One correction round at most, with the problems sent back as feedback.
  const { system, user } = buildVideoPrompt(p.format, candidates);
  const ids = new Set(candidates.map(item => item.id));
  const messages: ClaudeMessage[] = [{ role: 'user', content: user }];
  let claudeMicros = 0; let output: VideoOutput | null = null; let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2 && !output; attempt++) {
    const reply = await askAi(db, { userId: p.userId, masterKey: p.masterKey, purpose: 'video', system, messages, maxTokens: 1800, timeoutMs: 60_000, fetcher, now });
    claudeMicros += reply.costMicros;
    const verdict = judgeVideoAnswer(reply.text, p.format, ids);
    if (verdict.ok) { output = verdict.output; break; }
    lastProblems = verdict.problems;
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: feedbackMessage(verdict.problems) });
  }
  if (!output) {
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Vídeo recusado pelas regras', result: 'A IA não escreveu dentro das regras', details: { problems: lastProblems } });
    throw new BrainError('A IA não conseguiu planejar o vídeo dentro das regras desta vez. Tente de novo.');
  }
  const product = candidates.find(item => item.id === output?.chosen_product_id) as ProductCandidate;
  const tool = VIDEO_TOOLS[output.tool];
  const estimatedMicros = estimateVideoMicros(tool, output.duration);
  const credentials = await credentialsForJob(db, { userId: p.userId, masterKey: p.masterKey, estimateMicros: estimatedMicros, now });

  // The first frame of the video is the real product photo, stored where Higgsfield can fetch it by its public address.
  const frame = await storeProductPhoto(db, { userId: p.userId, fetcher, imageUrl: product.imageUrl });
  const frameUrl = db.storage.from(MEDIA_BUCKET).getPublicUrl(frame.path).data.publicUrl;
  const removeFrame = async () => { await db.storage.from(MEDIA_BUCKET).remove([frame.path]); };

  const postId = crypto.randomUUID(); const subId = subIdOf(postId);
  let affiliateLink: string | null = null;
  try { affiliateLink = (await p.makeLink?.(product.url, encodeSubIds([subId, 'ia']))) ?? null; } catch { affiliateLink = null; }

  // The post exists before the order goes out, so a paid video can never be left without a post to receive it.
  const job: VideoJob = { requestId: null, tool: output.tool, endpoint: tool.endpoint, duration: output.duration, framePath: frame.path, estimatedMicros, startedAt: at };
  const created = await db.from('posts').insert({
    id: postId, user_id: p.userId, instagram_account_id: accountId, product_id: product.id, format: p.format, status: 'rendering', scheduled_at: p.auto?.scheduledAt ?? null, caption: videoCaption(p.format, output),
    trigger_word: p.format === 'reel' ? TRIGGER_WORD : null, affiliate_link: affiliateLink, sub_id: subId, idempotency_key: crypto.randomUUID(), source: p.auto ? 'auto' : 'ai', video_job: job,
    ai_plan: { reason: output.reason, angle: output.angle, hook: output.hook, tool: output.tool, duration: output.duration, costMicros: claudeMicros, estimatedMicros, linkMissing: affiliateLink === null, autoMode: p.auto?.mode ?? null, generatedAt: new Date(at).toISOString() },
  });
  if (created.error) { await removeFrame(); throw new BrainError('Não foi possível criar o rascunho do vídeo. Tente de novo.'); }

  try {
    const res = await hfCall(fetcher, credentials, { method: 'POST', path: `/${tool.endpoint}`, body: buildHiggsfieldBody(output, frameUrl), idempotencyKey: postId, timeoutMs: 30_000 });
    if (res.status === 401) { await markInvalid(db, p.userId); throw new HiggsfieldError('auth'); }
    const requestId = str(res.json?.['request_id']);
    if (res.status < 200 || res.status >= 300 || !requestId) throw errorForStatus(res.status, str(res.json?.['detail']), res.retryAfter);
    const confirmed = await db.from('posts').update({ video_job: { ...job, requestId } }).eq('id', postId).eq('user_id', p.userId);
    if (confirmed.error) await db.from('posts').update({ video_job: { ...job, requestId } }).eq('id', postId).eq('user_id', p.userId);
  } catch (error) {
    await db.from('posts').delete().eq('id', postId).eq('user_id', p.userId);
    await removeFrame();
    throw error;
  }
  // The estimate is reserved right away, so videos ordered at the same time cannot pass the monthly cap together. A video that fails is refunded.
  await recordMediaUsage(db, p.userId, { purpose: 'video', model: tool.endpoint, costMicros: estimatedMicros, at });
  await db.from('activity_log').insert({ user_id: p.userId, action: 'Vídeo pedido ao Higgsfield', result: `${p.format === 'reel' ? 'Reels' : 'Story'} de ${output.duration}s com ${tool.label}`, details: { post_id: postId, product_id: product.id, tool: output.tool, estimated_micros: estimatedMicros, claude_micros: claudeMicros } });
  return { postId, productTitle: product.title, tool: tool.label, duration: output.duration, costMicros: claudeMicros, estimatedMicros, linkMissing: affiliateLink === null };
}