// Server-only: follows the videos ordered at Higgsfield. The scheduler visits once a minute; each visit asks "is it ready yet?" for every
// video in progress and, when one is ready, downloads it, stores it and turns the post into a draft for the user to approve.
import type { SupabaseClient } from '@supabase/supabase-js';
import { hfCall, markInvalid, openStoredCredentials, recordMediaUsage } from './higgsfield.server';
import { higgsfieldErrorMessage } from './higgsfield';
import { MEDIA_BUCKET } from './posts';
import { MAX_VIDEO_BYTES, VIDEO_STUCK_MS, VIDEO_UNSENT_MS, VIDEO_TOOLS, parseVideoJob, type VideoJob } from './video-brain';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
export type VideoJobsResult = { checked: number; completed: number; failed: number; waiting: number };
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Only plain https addresses of a real host: never an IP address or a local name. */
export function isSafeVideoUrl(value: string): boolean {
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    return !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':') && !host.startsWith('[');
  } catch { return false; }
}
/** An MP4 file starts with a box whose type, at bytes 4 to 8, is "ftyp". */
export const looksLikeMp4 = (bytes: Uint8Array) => bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;

export async function advanceVideoJobs(db: Db, p: { masterKey: string; fetcher?: Fetcher; now?: () => number; maxCompletions?: number }): Promise<VideoJobsResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const result: VideoJobsResult = { checked: 0, completed: 0, failed: 0, waiting: 0 };
  const { data } = await db.from('posts').select('id,user_id,instagram_account_id,format,video_job,created_at').eq('status', 'rendering').order('created_at', { ascending: true }).limit(10);

  for (const row of (data ?? []) as Row[]) {
    result.checked++;
    const postId = str(row['id']); const userId = str(row['user_id']); const accountId = str(row['instagram_account_id']);
    const job = parseVideoJob(row['video_job']);
    const startedAt = job?.startedAt ?? (Date.parse(str(row['created_at'])) || now());
    const age = now() - startedAt;
    const removeFrame = async (job: VideoJob | null) => { if (job?.framePath) await db.storage.from(MEDIA_BUCKET).remove([job.framePath]); };
    const log = (action: string, text: string, details: Record<string, unknown> = {}) => db.from('activity_log').insert({ user_id: userId, action, result: text, details: { post_id: postId, ...details } });
    /** The video will not come: the post fails, the reserved estimate is returned (Higgsfield does not charge failed or blocked requests) and the first frame is removed. */
    const fail = async (message: string, refund: boolean) => {
      await db.from('posts').update({ status: 'failed', error: message, video_job: null }).eq('id', postId).eq('user_id', userId).eq('status', 'rendering');
      if (refund && job && job.estimatedMicros > 0) await recordMediaUsage(db, userId, { purpose: 'video-estorno', model: job.endpoint, costMicros: -job.estimatedMicros, at: now() });
      await removeFrame(job);
      await log('Vídeo não foi gerado', message);
      result.failed++;
    };
    const wait = async (note?: string) => {
      result.waiting++;
      if (note && str(row['error']) !== note) await db.from('posts').update({ error: note }).eq('id', postId).eq('user_id', userId);
    };

    if (!job) { await fail('Não foi possível acompanhar este vídeo.', false); continue; }
    if (!job.requestId) { if (age > VIDEO_UNSENT_MS) await fail('O pedido do vídeo não chegou ao Higgsfield. Tente de novo.', false); else result.waiting++; continue; }

    let credentials;
    try { credentials = await openStoredCredentials(db, { userId, masterKey: p.masterKey }); } catch {
      if (age > VIDEO_STUCK_MS) await fail('O Higgsfield está desconectado e o vídeo não pôde ser recebido.', true); else await wait(higgsfieldErrorMessage('not_connected'));
      continue;
    }
    let status: { status: number; json: Row | null };
    try { status = await hfCall(fetcher, credentials, { method: 'GET', path: `/requests/${encodeURIComponent(job.requestId)}/status`, timeoutMs: 15_000 }); } catch {
      if (age > VIDEO_STUCK_MS) await fail('O Higgsfield não respondeu a tempo.', true); else await wait();
      continue;
    }
    if (status.status === 401) { await markInvalid(db, userId); await wait(higgsfieldErrorMessage('auth')); continue; }
    if (status.status === 404) { await fail('O Higgsfield não encontrou este pedido de vídeo.', true); continue; }
    if (status.status !== 200 || !status.json) {
      if (age > VIDEO_STUCK_MS) await fail('O Higgsfield não respondeu a tempo.', true); else await wait();
      continue;
    }
    const state = str(status.json['status']);
    if (state === 'failed') { await fail('O Higgsfield não conseguiu gerar o vídeo. Tente de novo.', true); continue; }
    if (state === 'nsfw') { await fail('O Higgsfield bloqueou este vídeo por conteúdo. Tente de novo com outro produto.', true); continue; }
    if (state === 'canceled') { await fail('O pedido do vídeo foi cancelado.', true); continue; }
    if (state !== 'completed') {
      if (age > VIDEO_STUCK_MS) {
        await hfCall(fetcher, credentials, { method: 'POST', path: `/requests/${encodeURIComponent(job.requestId)}/cancel`, timeoutMs: 10_000 }).catch(() => null);
        await fail('O vídeo demorou demais para ficar pronto.', true);
      } else await wait();
      continue;
    }

    // Ready: download, check, store, and turn the post into a draft.
    if (result.completed >= (p.maxCompletions ?? 2)) { await wait(); continue; }
    const videoField = status.json['video'];
    const videoUrl = videoField && typeof videoField === 'object' ? str((videoField as Row)['url']) : '';
    if (!isSafeVideoUrl(videoUrl)) { await fail('O Higgsfield devolveu um endereço de vídeo inválido.', true); continue; }
    let bytes: Uint8Array;
    try {
      const res = await fetcher(videoUrl, { signal: AbortSignal.timeout(40_000) });
      if (!res.ok) { if (age > VIDEO_STUCK_MS) await fail('Não consegui baixar o vídeo pronto.', true); else await wait(); continue; }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch { if (age > VIDEO_STUCK_MS) await fail('Não consegui baixar o vídeo pronto.', true); else await wait(); continue; }
    if (bytes.length > MAX_VIDEO_BYTES) { await fail('O vídeo gerado passa de 50 MB e não cabe no armazenamento.', true); continue; }
    if (!looksLikeMp4(bytes)) { await fail('O arquivo recebido do Higgsfield não é um vídeo MP4.', true); continue; }

    const path = `${userId}/${crypto.randomUUID()}.mp4`; const assetId = crypto.randomUUID();
    const uploaded = await db.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: 'video/mp4', upsert: false, cacheControl: '31536000' });
    if (uploaded.error) { await wait(); continue; }
    const undo = async () => { await db.from('video_assets').delete().eq('id', assetId).eq('user_id', userId); await db.storage.from(MEDIA_BUCKET).remove([path]); };
    const asset = await db.from('video_assets').insert({
      id: assetId, user_id: userId, instagram_account_id: accountId, storage_path: path, media_type: 'video', mime_type: 'video/mp4', size_bytes: bytes.length,
      source: 'higgsfield', provider_job_id: job.requestId, template: job.tool, duration_seconds: job.duration,
    });
    if (asset.error) { await undo(); await wait(); continue; }
    const link = await db.from('post_media').insert({ user_id: userId, post_id: postId, asset_id: assetId, position: 0 });
    if (link.error) { await undo(); await wait(); continue; }
    await db.from('posts').update({ status: 'draft', video_asset_id: assetId, video_job: null, error: null }).eq('id', postId).eq('user_id', userId).eq('status', 'rendering');
    await removeFrame(job);
    await log('Vídeo pronto', `${row['format'] === 'story' ? 'Story' : 'Reels'} de ${job.duration}s com ${VIDEO_TOOLS[job.tool].label}`, { size_bytes: bytes.length });
    result.completed++;
  }
  return result;
}
