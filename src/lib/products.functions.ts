import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { HEARTBEAT_SCOPE } from './publishing';
import {
  CANCELABLE_STATUSES, FORMAT_LABELS, MAX_CAPTION, MAX_FILE_BYTES, MEDIA_BUCKET, checkSchedule, createPostSchema, kindOfMime, mimeOfExtension, ownsMediaPath, validateMedia,
  type MediaKind,
} from './posts';

export type PostActionResult = { status: 'ok'; message?: string; postId?: string } | { status: 'error'; message: string };
export type PostMediaView = { url: string; kind: MediaKind };
export type AiPlanView = { reason: string; angle: string; hook: string; linkMissing: boolean };
export type PostView = { id: string; format: string; status: string; attempts: number; source: string; aiPlan: AiPlanView | null; hasLink: boolean; scheduledAt: string | null; publishedAt: string | null; caption: string; productTitle: string; error: string | null; media: PostMediaView[] };
export type PostsOverview = { ai: { connected: boolean }; scheduler: { lastVisitAt: string | null }; account: { username: string | null; status: string } | null; products: { id: string; title: string }[]; posts: PostView[] };

// The generated database types do not know the media columns and the post_media table yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null);

function aiPlanOf(value: unknown): AiPlanView | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as Row;
  return { reason: text(plan['reason']), angle: text(plan['angle']), hook: text(plan['hook']), linkMissing: plan['linkMissing'] === true };
}

/** Spacing between registrations for one user, so a double click cannot create the same publication twice. */
async function tooSoon(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: `post-create:${userId}`, p_interval_ms: 2000 });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const log = (db: SupabaseClient, userId: string, action: string, result: string, details: Record<string, unknown> = {}) =>
  db.from('activity_log').insert({ user_id: userId, action, result, details });

export const getPostsOverview = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<PostsOverview> => {
  const db = await admin(); const userId = context.userId;
  const [account, products, posts, heartbeat, aiConnection] = await Promise.all([
    db.from('instagram_accounts').select('id,username,status').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle(),
    db.from('products').select('id,title').eq('user_id', userId).order('collected_at', { ascending: false }).limit(200),
    db.from('posts').select('id,format,status,scheduled_at,published_at,caption,error,product_id,attempts,source,ai_plan,affiliate_link,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    db.from('connector_runtime').select('next_allowed_at').eq('scope', HEARTBEAT_SCOPE).maybeSingle(),
    db.from('ai_connections').select('status,credential_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (account.error || products.error || posts.error) throw new Error('Não foi possível carregar suas publicações. Tente de novo.');
  const postRows = (posts.data ?? []) as Row[];
  const ids = postRows.map(row => text(row['id']));
  const productIds = [...new Set(postRows.map(row => text(row['product_id'])))];
  const [titles, links] = await Promise.all([
    productIds.length ? db.from('products').select('id,title').eq('user_id', userId).in('id', productIds) : Promise.resolve({ data: [] as Row[], error: null }),
    ids.length ? db.from('post_media').select('post_id,asset_id,position').eq('user_id', userId).in('post_id', ids).order('position', { ascending: true }) : Promise.resolve({ data: [] as Row[], error: null }),
  ]);
  if (titles.error || links.error) throw new Error('Não foi possível carregar suas publicações. Tente de novo.');
  const linkRows = (links.data ?? []) as Row[];
  const assetIds = [...new Set(linkRows.map(row => text(row['asset_id'])))];
  const assets = assetIds.length ? await db.from('video_assets').select('id,storage_path,media_type').eq('user_id', userId).in('id', assetIds) : { data: [] as Row[], error: null };
  if (assets.error) throw new Error('Não foi possível carregar suas publicações. Tente de novo.');
  const titleOf = new Map(((titles.data ?? []) as Row[]).map(row => [text(row['id']), text(row['title'])]));
  const assetOf = new Map(((assets.data ?? []) as Row[]).map(row => [text(row['id']), row]));
  const mediaOf = new Map<string, PostMediaView[]>();
  for (const link of linkRows) {
    const asset = assetOf.get(text(link['asset_id']));
    const path = asset ? textOrNull(asset['storage_path']) : null;
    if (!asset || !path) continue;
    const list = mediaOf.get(text(link['post_id'])) ?? [];
    list.push({ url: db.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl, kind: text(asset['media_type']) === 'video' ? 'video' : 'image' });
    mediaOf.set(text(link['post_id']), list);
  }
  const acc = account.data as Row | null;
  const aiRow = (aiConnection.data ?? null) as Row | null;
  return {
    ai: { connected: Boolean(aiRow && textOrNull(aiRow['credential_id']) && text(aiRow['status']) === 'connected') },
    scheduler: { lastVisitAt: textOrNull(((heartbeat.data ?? null) as Row | null)?.['next_allowed_at']) },
    account: acc ? { username: textOrNull(acc['username']), status: text(acc['status']) } : null,
    products: ((products.data ?? []) as Row[]).map(row => ({ id: text(row['id']), title: text(row['title']) })),
    posts: postRows.map(row => ({
      id: text(row['id']), format: text(row['format']), status: text(row['status']), attempts: Number(row['attempts'] ?? 0), source: text(row['source']) || 'manual', aiPlan: aiPlanOf(row['ai_plan']), hasLink: Boolean(textOrNull(row['affiliate_link'])), scheduledAt: textOrNull(row['scheduled_at']), publishedAt: textOrNull(row['published_at']),
      caption: text(row['caption']), productTitle: titleOf.get(text(row['product_id'])) ?? 'Produto removido', error: textOrNull(row['error']), media: mediaOf.get(text(row['id'])) ?? [],
    })),
  };
});

/** Looks at the stored file itself (size and type are read from the storage, never trusted from the browser). */
async function inspectObject(db: SupabaseClient, userId: string, path: string) {
  const name = path.slice(userId.length + 1);
  const { data, error } = await db.storage.from(MEDIA_BUCKET).list(userId, { limit: 100, search: name });
  if (error) return null;
  const found = (data ?? []).find(item => item.name === name);
  const meta = found?.metadata as { size?: unknown; mimetype?: unknown } | null | undefined;
  if (!found || !meta) return null;
  return { size: Number(meta.size ?? 0), mime: typeof meta.mimetype === 'string' ? meta.mimetype : '' };
}

/** Manual import: the files are already in the user's folder; this registers them and creates the publication (draft or scheduled). */
export const createManualPost = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => createPostSchema.parse(input)).handler(async ({ context, data }): Promise<PostActionResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      if (await tooSoon(db, userId)) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
      const scheduleProblem = checkSchedule(data.scheduledAt);
      if (scheduleProblem) return { status: 'error', message: scheduleProblem };
      if (data.media.some(item => !ownsMediaPath(item.path, userId))) return { status: 'error', message: 'Esses arquivos não pertencem à sua conta. Envie de novo.' };

      const { data: account } = await db.from('instagram_accounts').select('id,status').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (!account) return { status: 'error', message: 'Conecte o Instagram na tela Conexões antes de criar publicações.' };
      const { data: product } = await db.from('products').select('id').eq('user_id', userId).eq('id', data.productId).maybeSingle();
      if (!product) return { status: 'error', message: 'Não encontrei esse produto. Escolha outro da lista.' };

      const inspected = await Promise.all(data.media.map(async item => ({ path: item.path, info: await inspectObject(db, userId, item.path) })));
      const files: { path: string; mime: string; size: number; kind: MediaKind }[] = [];
      for (const { path, info } of inspected) {
        if (!info) return { status: 'error', message: 'Um dos arquivos não chegou ao armazenamento. Envie de novo.' };
        const kind = kindOfMime(info.mime);
        const expected = mimeOfExtension(path.slice(path.lastIndexOf('.') + 1));
        if (!kind || expected !== info.mime) return { status: 'error', message: 'Tipo de arquivo não aceito. Use foto JPEG ou vídeo MP4/MOV.' };
        if (info.size <= 0 || info.size > MAX_FILE_BYTES) return { status: 'error', message: 'Cada arquivo pode ter no máximo 50 MB.' };
        files.push({ path, mime: info.mime, size: info.size, kind });
      }
      const mediaProblem = validateMedia(data.format, files.map(file => file.kind));
      if (mediaProblem) return { status: 'error', message: mediaProblem };

      const accountId = text((account as Row)['id']);
      const assetRows = files.map(file => ({ id: crypto.randomUUID(), user_id: userId, instagram_account_id: accountId, storage_path: file.path, media_type: file.kind, mime_type: file.mime, size_bytes: file.size, source: 'manual' }));
      const postId = crypto.randomUUID();
      const status = data.scheduledAt ? 'scheduled' : 'draft';
      const undo = async () => { await db.from('posts').delete().eq('id', postId).eq('user_id', userId); await db.from('video_assets').delete().in('id', assetRows.map(row => row.id)).eq('user_id', userId); };

      const assets = await db.from('video_assets').insert(assetRows);
      if (assets.error) return { status: 'error', message: 'Não foi possível registrar os arquivos. Tente de novo.' };
      const post = await db.from('posts').insert({
        id: postId, user_id: userId, instagram_account_id: accountId, product_id: data.productId, format: data.format, status, scheduled_at: data.scheduledAt,
        caption: data.caption || null, affiliate_link: data.affiliateLink || null, video_asset_id: assetRows[0]?.id ?? null, idempotency_key: data.requestId,
      });
      if (post.error) {
        await undo();
        if (post.error.code === '23505') return { status: 'ok', message: 'Essa publicação já tinha sido registrada.' };
        return { status: 'error', message: 'Não foi possível criar a publicação. Tente de novo.' };
      }
      const media = await db.from('post_media').insert(assetRows.map((row, position) => ({ user_id: userId, post_id: postId, asset_id: row.id, position })));
      if (media.error) { await undo(); return { status: 'error', message: 'Não foi possível ligar os arquivos à publicação. Tente de novo.' }; }

      await log(db, userId, 'Publicação criada', `${FORMAT_LABELS[data.format]} ${status === 'scheduled' ? 'agendada' : 'salva como rascunho'}`, { post_id: postId, format: data.format, files: files.length });
      return { status: 'ok', postId, message: status === 'scheduled' ? 'Publicação agendada.' : 'Rascunho salvo.' };
    } catch { return { status: 'error', message: 'Não foi possível concluir agora. Tente de novo.' }; }
  });

export const cancelPost = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ postId: z.string().uuid() }).parse(input)).handler(async ({ context, data }): Promise<PostActionResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      const { data: changed, error } = await db.from('posts').update({ status: 'canceled' }).eq('id', data.postId).eq('user_id', userId).in('status', [...CANCELABLE_STATUSES]).select('id');
      if (error) return { status: 'error', message: 'Não foi possível cancelar agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: 'Só dá para cancelar rascunhos e publicações agendadas.' };
      await log(db, userId, 'Publicação cancelada', 'Cancelada pelo usuário', { post_id: data.postId });
      return { status: 'ok', message: 'Publicação cancelada.' };
    } catch { return { status: 'error', message: 'Não foi possível cancelar agora. Tente de novo.' }; }
  });

/** "Publicar agora" for drafts and scheduled posts, "Tentar de novo" for failed ones: the publication goes to the front of the queue and the scheduler sends it on its next visit. */
export const queuePostNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ postId: z.string().uuid() }).parse(input)).handler(async ({ context, data }): Promise<PostActionResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      const { data: account } = await db.from('instagram_accounts').select('status').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (!account || text((account as Row)['status']) !== 'connected') return { status: 'error', message: 'Reconecte o Instagram na tela Conexões antes de publicar.' };
      const { data: changed, error } = await db.from('posts').update({ status: 'scheduled', scheduled_at: new Date().toISOString(), attempts: 0, error: null })
        .eq('id', data.postId).eq('user_id', userId).in('status', ['draft', 'scheduled', 'failed']).select('id');
      if (error) return { status: 'error', message: 'Não foi possível colocar na fila agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: 'Essa publicação não pode ser enviada agora.' };
      await log(db, userId, 'Publicação na fila', 'Enviada para publicar agora', { post_id: data.postId });
      return { status: 'ok', message: 'Na fila. Ela sai na próxima passada do agendador, em até 1 minuto.' };
    } catch { return { status: 'error', message: 'Não foi possível colocar na fila agora. Tente de novo.' }; }
  });

/** The user edits the text of a draft before approving it. */
export const updateDraftCaption = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ postId: z.string().uuid(), caption: z.string().trim().max(MAX_CAPTION, `A legenda pode ter no máximo ${MAX_CAPTION} caracteres.`) }).parse(input))
  .handler(async ({ context, data }): Promise<PostActionResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      const { data: changed, error } = await db.from('posts').update({ caption: data.caption || null }).eq('id', data.postId).eq('user_id', userId).eq('status', 'draft').select('id');
      if (error) return { status: 'error', message: 'Não foi possível salvar a legenda agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: 'Só dá para editar a legenda de rascunhos.' };
      return { status: 'ok', message: 'Legenda salva.' };
    } catch { return { status: 'error', message: 'Não foi possível salvar a legenda agora. Tente de novo.' }; }
  });

/** Approves a draft (or changes the time of a scheduled post): it will be published at the chosen time, within the daily limit. */
export const schedulePostAt = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ postId: z.string().uuid(), scheduledAt: z.string().datetime() }).parse(input)).handler(async ({ context, data }): Promise<PostActionResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      const problem = checkSchedule(data.scheduledAt);
      if (problem) return { status: 'error', message: problem };
      const { data: account } = await db.from('instagram_accounts').select('status').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (!account || text((account as Row)['status']) !== 'connected') return { status: 'error', message: 'Reconecte o Instagram na tela Conexões antes de agendar.' };
      const { data: changed, error } = await db.from('posts').update({ status: 'scheduled', scheduled_at: data.scheduledAt, attempts: 0, error: null })
        .eq('id', data.postId).eq('user_id', userId).in('status', ['draft', 'scheduled']).select('id');
      if (error) return { status: 'error', message: 'Não foi possível agendar agora. Tente de novo.' };
      if (!changed?.length) return { status: 'error', message: 'Só dá para agendar rascunhos e publicações agendadas.' };
      await log(db, userId, 'Publicação agendada', 'Agendada pelo usuário', { post_id: data.postId, scheduled_at: data.scheduledAt });
      return { status: 'ok', message: 'Publicação agendada.' };
    } catch { return { status: 'error', message: 'Não foi possível agendar agora. Tente de novo.' }; }
  });