// Server-only: the storyboard flow, the same for the automation and for the manual "Gerar conteúdo com a IA" button.
// 1. The AI picks the product, the video tool and writes the caption. 2. It plans six scenes. 3. OpenAI draws one image per scene.
// 4. ONE video is ordered at Higgsfield with all the images as references. 5. The finished post schedules itself (see video-jobs.server.ts).
// Everything after step 2 happens in the background, one small step per visit of the scheduler, with no question to the user.
import type { SupabaseClient } from '@supabase/supabase-js';
import { storyboardSpeechOf } from './ai-options.server';
import { askAi } from './ai.server';
import type { ClaudeMessage } from './claude.server';
import { TRIGGER_WORD, assembleCaption, buildPrompt, feedbackMessage, judgeAnswer, subIdOf, type ProductCandidate } from './content-brain';
import { BrainError, loadCandidatePool } from './content-brain.server';
import { HiggsfieldError, credentialsForJob, errorForStatus, hfCall, markInvalid, recordMediaUsage } from './higgsfield.server';
import { higgsfieldErrorMessage } from './higgsfield';
import type { AutomationMode } from './automation';
import { MEDIA_BUCKET } from './posts';
import { encodeSubIds } from './products';
import {
  MAX_SCENE_TRIES, MAX_SCENES_PER_VISIT, STORYBOARD_STUCK_MS, STORY_TOOL_IDS, buildStoryBody, buildStoryDirectionPrompt, buildStoryVideoPrompt, judgeStoryDirection,
  type StoryToolId,
} from './story-video';
import { generateScene, planStoryboard } from './storyboard.server';
import { MAX_CONCURRENT_VIDEOS, VIDEO_TOOLS, estimateVideoMicros, type VideoFormat, type VideoJob } from './video-brain';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export type StoryFormat = VideoFormat | 'carousel';
export type StoryStartResult = { postId: string; productTitle: string; tool: string; duration: number; costMicros: number; estimatedMicros: number; linkMissing: boolean };

/**
 * Starts the whole process for one post: product, caption, tool, storyboard. The post is created waiting for its images, and the scheduler
 * does the rest. Nothing is ordered at Higgsfield yet, so a failure here costs only text and, at most, the images of a storyboard.
 */
export async function startStoryContent(db: Db, p: {
  userId: string; masterKey: string; format: StoryFormat; fetcher?: Fetcher; now?: () => number;
  makeLink?: (productUrl: string, subIds: string[]) => Promise<string | null>;
  auto?: { mode: AutomationMode; scheduledAt: string; manual?: boolean };
}): Promise<StoryStartResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now; const at = now();
  const carousel = p.format === 'carousel';

  // Cheap checks first, before any money is spent.
  if (!carousel) await credentialsForJob(db, { userId: p.userId, masterKey: p.masterKey, estimateMicros: 0, now });
  const running = await db.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', p.userId).eq('status', 'rendering');
  if ((running.count ?? 0) >= MAX_CONCURRENT_VIDEOS) throw new BrainError(`Já há ${MAX_CONCURRENT_VIDEOS} conteúdos sendo criados. Espere um terminar para pedir outro.`);
  const { candidates } = await loadCandidatePool(db, p.userId, at);
  const withSpeech = carousel ? false : await storyboardSpeechOf(db, p.userId);

  // The AI answers, the code checks. One correction round at most, with the problems sent back as feedback.
  const ids = new Set(candidates.map(item => item.id));
  const prompt = carousel ? buildPrompt(candidates) : buildStoryDirectionPrompt(p.format as VideoFormat, candidates, { withSpeech });
  const messages: ClaudeMessage[] = [{ role: 'user', content: prompt.user }];
  type Direction = { productId: string; reason: string; angle: string; hook: string; caption: string | null; tool: StoryToolId | null; duration: number };
  let direction: Direction | null = null; let aiMicros = 0; let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2 && !direction; attempt++) {
    const reply = await askAi(db, { userId: p.userId, masterKey: p.masterKey, purpose: 'video', system: prompt.system, messages, maxTokens: 1800, timeoutMs: 60_000, fetcher, now });
    aiMicros += reply.costMicros;
    if (carousel) {
      const verdict = judgeAnswer(reply.text, ids);
      if (verdict.ok) { direction = { productId: verdict.output.chosen_product_id, reason: verdict.output.reason, angle: verdict.output.angle, hook: verdict.output.hook, caption: assembleCaption(verdict.output), tool: null, duration: 0 }; break; }
      lastProblems = verdict.problems;
    } else {
      const verdict = judgeStoryDirection(reply.text, p.format as VideoFormat, ids);
      if (verdict.ok) { const o = verdict.output; direction = { productId: o.chosen_product_id, reason: o.reason, angle: o.angle, hook: o.hook, caption: p.format === 'reel' ? assembleCaption(o) : null, tool: o.tool, duration: o.duration }; break; }
      lastProblems = verdict.problems;
    }
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: feedbackMessage(lastProblems) });
  }
  if (!direction) {
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Conteúdo recusado pelas regras', result: 'A IA não escreveu dentro das regras', details: { problems: lastProblems } });
    throw new BrainError('A IA não conseguiu planejar o conteúdo dentro das regras desta vez. Tente de novo.');
  }
  const product = candidates.find(item => item.id === direction?.productId) as ProductCandidate;
  const tool = direction.tool ? VIDEO_TOOLS[direction.tool] : null;
  const estimatedMicros = tool ? estimateVideoMicros(tool, direction.duration) : 0;
  // The monthly cap of Higgsfield, if the owner set one, is checked with the real estimate before the images are paid for.
  if (tool) await credentialsForJob(db, { userId: p.userId, masterKey: p.masterKey, estimateMicros: estimatedMicros, now });

  const planned = await planStoryboard(db, { userId: p.userId, masterKey: p.masterKey, productId: product.id, withSpeech, fetcher, now });
  aiMicros += planned.costMicros;

  const postId = crypto.randomUUID(); const subId = subIdOf(postId);
  let affiliateLink: string | null = null;
  try { affiliateLink = (await p.makeLink?.(product.url, encodeSubIds([subId, 'ia']))) ?? null; } catch { affiliateLink = null; }
  const job: VideoJob = {
    requestId: null, tool: direction.tool ?? 'seedance_2_5', endpoint: tool?.endpoint ?? 'carousel', duration: direction.duration, framePath: '', estimatedMicros, startedAt: at,
    stage: 'storyboard', storyboardId: planned.storyboardId, withSpeech, ...(carousel ? { carousel: true } : {}),
  };
  const created = await db.from('posts').insert({
    id: postId, user_id: p.userId, instagram_account_id: await accountOf(db, p.userId), product_id: product.id, format: p.format, status: 'rendering', scheduled_at: p.auto?.scheduledAt ?? null, caption: direction.caption,
    trigger_word: p.format === 'story' ? null : TRIGGER_WORD, affiliate_link: affiliateLink, sub_id: subId, idempotency_key: crypto.randomUUID(), source: p.auto && !p.auto.manual ? 'auto' : 'ai', video_job: job,
    ai_plan: {
      reason: direction.reason, angle: direction.angle, hook: direction.hook, tool: direction.tool, duration: direction.duration, costMicros: aiMicros, estimatedMicros, linkMissing: affiliateLink === null,
      autoMode: p.auto?.mode ?? null, pipeline: 'storyboard', storyboardId: planned.storyboardId, withSpeech, generatedAt: new Date(at).toISOString(),
    },
  });
  if (created.error) {
    await db.from('storyboards').update({ status: 'discarded' }).eq('id', planned.storyboardId).eq('user_id', p.userId);
    throw new BrainError('Não foi possível criar a publicação. Tente de novo.');
  }
  await db.from('activity_log').insert({
    user_id: p.userId, action: 'Conteúdo da IA iniciado', result: `${carousel ? 'Carrossel' : p.format === 'reel' ? 'Reels' : 'Story'} de "${product.title.slice(0, 70)}"${tool ? ` com ${tool.label}, ${direction.duration}s` : ''}`,
    details: { post_id: postId, product_id: product.id, storyboard_id: planned.storyboardId, ...(direction.tool ? { tool: direction.tool } : {}), with_speech: withSpeech },
  });
  return { postId, productTitle: product.title, tool: tool?.label ?? 'imagens da IA', duration: direction.duration, costMicros: aiMicros, estimatedMicros, linkMissing: affiliateLink === null };
}

async function accountOf(db: Db, userId: string): Promise<string> {
  const { data } = await db.from('instagram_accounts').select('id').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  return str((data as Row | null)?.['id']);
}

export type StageOutcome =
  | { kind: 'wait'; note?: string }
  | { kind: 'fail'; message: string }
  | { kind: 'ordered' }
  | { kind: 'completed'; scheduledAt: string | null; automatic: boolean; images: number };

const TRANSIENT = new Set(['busy', 'server', 'network', 'timeout', 'unavailable', 'auth', 'balance', 'not_connected']);

/**
 * One small step for a post that is waiting for its storyboard: draw the next scenes, and when all six are ready either finish the carousel or
 * order the video (one request, all images as references). Called by the scheduler once a minute; it never asks the user anything.
 */
export async function advanceStoryStage(db: Db, p: {
  post: Row; job: VideoJob; masterKey: string; fetcher?: Fetcher; now?: () => number;
}): Promise<StageOutcome> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const postId = str(p.post['id']); const userId = str(p.post['user_id']); const job = p.job;
  if (now() - job.startedAt > STORYBOARD_STUCK_MS) return { kind: 'fail', message: 'As imagens do storyboard demoraram demais para ficar prontas. Tente de novo.' };
  if (!job.storyboardId) return { kind: 'fail', message: 'Não foi possível acompanhar o storyboard deste conteúdo.' };

  const load = async () => {
    const { data } = await db.from('storyboard_scenes').select('*').eq('storyboard_id', job.storyboardId as string).eq('user_id', userId).order('position', { ascending: true });
    return (data ?? []) as Row[];
  };
  let scenes = await load();
  if (!scenes.length) return { kind: 'fail', message: 'O storyboard deste conteúdo não foi encontrado.' };
  const dead = scenes.find(scene => str(scene['status']) === 'failed' && num(scene['attempts']) >= MAX_SCENE_TRIES);
  if (dead) return { kind: 'fail', message: str(dead['last_error']) || 'Uma das imagens do storyboard não pôde ser criada. Tente de novo.' };

  const pending = scenes.filter(scene => str(scene['status']) !== 'done');
  if (pending.length) {
    // The first scene alone (the next ones copy its person), then a few at a time.
    const batch = str((scenes[0] as Row)['status']) !== 'done' ? [scenes[0] as Row] : pending.slice(0, MAX_SCENES_PER_VISIT);
    await Promise.allSettled(batch.map(scene => generateScene(db, { userId, masterKey: p.masterKey, sceneId: str(scene['id']), fetcher, now })));
    scenes = await load();
    if (scenes.some(scene => str(scene['status']) !== 'done')) {
      const done = scenes.filter(scene => str(scene['status']) === 'done').length;
      return { kind: 'wait', note: `Criando as imagens do storyboard (${done} de ${scenes.length})...` };
    }
  }

  // All the images are ready.
  const assetIds = scenes.map(scene => str(scene['asset_id']));
  const { data: assets } = await db.from('video_assets').select('id,storage_path').eq('user_id', userId).in('id', assetIds);
  const pathOf = new Map(((assets ?? []) as Row[]).map(asset => [str(asset['id']), str(asset['storage_path'])]));
  if (assetIds.some(id => !pathOf.get(id))) return { kind: 'fail', message: 'Uma das imagens do storyboard não foi encontrada.' };

  const plan = p.post['ai_plan'] && typeof p.post['ai_plan'] === 'object' ? (p.post['ai_plan'] as Row) : {};
  if (job.carousel) {
    const link = await db.from('post_media').insert(assetIds.map((assetId, index) => ({ user_id: userId, post_id: postId, asset_id: assetId, position: index })));
    if (link.error) return { kind: 'wait' };
    const automatic = plan['autoMode'] === 'auto' && plan['linkMissing'] !== true;
    const planned = Date.parse(str(p.post['scheduled_at']));
    const goesAt = automatic ? new Date(Math.max(Number.isNaN(planned) ? 0 : planned, now() + 2 * 60_000)).toISOString() : null;
    await db.from('posts').update({ status: automatic ? 'scheduled' : 'draft', scheduled_at: goesAt, ...(automatic ? { attempts: 0 } : {}), video_asset_id: assetIds[0], video_job: null, error: null }).eq('id', postId).eq('user_id', userId).eq('status', 'rendering');
    return { kind: 'completed', scheduledAt: goesAt, automatic, images: assetIds.length };
  }

  const tool = VIDEO_TOOLS[job.tool]; const toolId = job.tool as StoryToolId;
  if (!(STORY_TOOL_IDS as readonly string[]).includes(toolId)) return { kind: 'fail', message: 'A ferramenta de vídeo deste conteúdo não é mais aceita.' };
  const estimate = estimateVideoMicros(tool, job.duration);
  let credentials;
  try { credentials = await credentialsForJob(db, { userId, masterKey: p.masterKey, estimateMicros: estimate, now }); } catch (error) {
    if (error instanceof HiggsfieldError) return TRANSIENT.has(error.kind) ? { kind: 'wait', note: higgsfieldErrorMessage(error.kind, error.detail) } : { kind: 'fail', message: higgsfieldErrorMessage(error.kind, error.detail) };
    return { kind: 'wait' };
  }
  const { data: board } = await db.from('storyboards').select('presenter').eq('id', job.storyboardId).eq('user_id', userId).maybeSingle();
  const withSpeech = job.withSpeech === true;
  const videoPrompt = buildStoryVideoPrompt(toolId, {
    scenes: scenes.map(scene => ({ shot: str(scene['shot']), motion: str(scene['motion']), speech: str(scene['speech']) || null })),
    presenter: str((board as Row | null)?.['presenter']) || null, seconds: job.duration, withSpeech,
  });
  const imageUrls = assetIds.map(id => db.storage.from(MEDIA_BUCKET).getPublicUrl(pathOf.get(id) as string).data.publicUrl);
  try {
    // The idempotency key is the post: if this step is repeated, Higgsfield returns the same request instead of making (and charging) a second video.
    const res = await hfCall(fetcher, credentials, { method: 'POST', path: `/${tool.endpoint}`, body: buildStoryBody(toolId, { prompt: videoPrompt, imageUrls, duration: job.duration, withSpeech }), idempotencyKey: postId, timeoutMs: 30_000 });
    if (res.status === 401) { await markInvalid(db, userId); throw new HiggsfieldError('auth'); }
    const requestId = str(res.json?.['request_id']);
    if (res.status < 200 || res.status >= 300 || !requestId) throw errorForStatus(res.status, str(res.json?.['detail']), res.retryAfter);
    const confirmed: VideoJob = { ...job, requestId, stage: 'video', estimatedMicros: estimate, startedAt: now() };
    await db.from('posts').update({ video_job: confirmed, error: null }).eq('id', postId).eq('user_id', userId);
    await recordMediaUsage(db, userId, { purpose: 'video', model: tool.endpoint, costMicros: estimate, at: now() });
    await db.from('activity_log').insert({ user_id: userId, action: 'Vídeo pedido ao Higgsfield', result: `${p.post['format'] === 'story' ? 'Story' : 'Reels'} de ${job.duration}s com ${tool.label}, a partir de ${imageUrls.length} imagens`, details: { post_id: postId, tool: job.tool, estimated_micros: estimate } });
    return { kind: 'ordered' };
  } catch (error) {
    if (error instanceof HiggsfieldError) return TRANSIENT.has(error.kind) ? { kind: 'wait', note: higgsfieldErrorMessage(error.kind, error.detail) } : { kind: 'fail', message: higgsfieldErrorMessage(error.kind, error.detail) };
    return { kind: 'wait', note: higgsfieldErrorMessage('network') };
  }
}

