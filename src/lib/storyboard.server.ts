// Server-only: the storyboard. The active AI plans six scenes (text), then OpenAI draws one image per scene from the real product photo.
// Each image is its own short request, so a slow image never hits a time limit and a failure costs one scene, not the whole storyboard.
// Nothing is published here: the result is a set of images for the user to review.
import type { SupabaseClient } from '@supabase/supabase-js';
import { askAi, providerConnected } from './ai.server';
import type { ClaudeMessage } from './claude.server';
import { isShopeeImageUrl } from './content-brain';
import { BrainError, storeProductPhoto } from './content-brain.server';
import { DEFAULT_IMAGE_MODEL, openAiErrorMessage } from './openai';
import { OpenAiError, askOpenAiImage } from './openai.server';
import { MEDIA_BUCKET } from './posts';
import { SCENE_COUNT, SCENE_STALE_MS, buildPlanPrompt, buildScenePrompt, judgePlan, planFeedback, type StoryboardPlan } from './storyboard';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const SIGNED_URL_SECONDS = 3600;

export type StoryboardSceneView = {
  id: string; position: number; title: string; shot: string; motion: string; speech: string | null; onScreenText: string | null;
  status: string; imageUrl: string | null; lastError: string | null; costMicros: number;
};
export type StoryboardView = {
  id: string; status: string; productTitle: string; concept: string; presenter: string | null; withSpeech: boolean; costMicros: number; createdAt: string; scenes: StoryboardSceneView[];
};
export type StoryboardSummary = { id: string; productTitle: string; status: string; createdAt: string; doneScenes: number; totalScenes: number; costMicros: number };
export type StoryboardProduct = { id: string; title: string };

/** The products the user can make a storyboard for: saved from Shopee, with a photo from a Shopee host. */
export async function listStoryboardProducts(db: Db, userId: string): Promise<StoryboardProduct[]> {
  const { data } = await db.from('products').select('id,title,images').eq('user_id', userId).eq('marketplace', 'shopee').order('collected_at', { ascending: false }).limit(60);
  return ((data ?? []) as Row[]).flatMap(row => {
    const images = Array.isArray(row['images']) ? (row['images'] as unknown[]) : [];
    return str(row['title']).trim() && isShopeeImageUrl(str(images[0])) ? [{ id: str(row['id']), title: str(row['title']) }] : [];
  }).slice(0, 40);
}

/** Plans the storyboard with the active AI, saves the reference photo, and creates the six scenes waiting to be drawn. Spends only text tokens. */
export async function planStoryboard(db: Db, p: { userId: string; masterKey: string; productId: string; withSpeech: boolean; fetcher?: Fetcher; now?: () => number }): Promise<{ storyboardId: string; costMicros: number }> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now; const at = now();
  if (!(await providerConnected(db, p.userId, 'openai'))) throw new BrainError('Para criar as imagens do storyboard, conecte a OpenAI na tela Conexões e confirme que a conexão está funcionando.');
  const { data: account } = await db.from('instagram_accounts').select('id').eq('user_id', p.userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!account) throw new BrainError('Conecte o Instagram na tela Conexões antes de criar um storyboard.');
  const accountId = str((account as Row)['id']);
  const { data: product } = await db.from('products').select('id,title,images').eq('id', p.productId).eq('user_id', p.userId).maybeSingle();
  const images = Array.isArray((product as Row | null)?.['images']) ? (((product as Row)['images']) as unknown[]) : [];
  const title = str((product as Row | null)?.['title']).trim(); const imageUrl = str(images[0]);
  if (!product || !title || !isShopeeImageUrl(imageUrl)) throw new BrainError('Não encontrei esse produto com foto. Escolha outro na lista.');

  // The AI answers, the code checks. One correction round at most, with the problems sent back as feedback.
  const { system, user } = buildPlanPrompt({ title }, { withSpeech: p.withSpeech });
  const messages: ClaudeMessage[] = [{ role: 'user', content: user }];
  let costMicros = 0; let plan: StoryboardPlan | null = null; let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    const reply = await askAi(db, { userId: p.userId, masterKey: p.masterKey, purpose: 'storyboard', system, messages, maxTokens: 2500, timeoutMs: 60_000, fetcher, now });
    costMicros += reply.costMicros;
    const verdict = judgePlan(reply.text, { withSpeech: p.withSpeech });
    if (verdict.ok) { plan = verdict.plan; break; }
    lastProblems = verdict.problems;
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: planFeedback(verdict.problems) });
  }
  if (!plan) {
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Storyboard recusado pelas regras', result: 'A IA não escreveu dentro das regras', details: { problems: lastProblems } });
    throw new BrainError('A IA não conseguiu montar o storyboard dentro das regras desta vez. Tente de novo.');
  }

  const photo = await storeProductPhoto(db, { userId: p.userId, fetcher, imageUrl });
  const storyboardId = crypto.randomUUID(); const assetId = crypto.randomUUID();
  const undo = async () => {
    await db.from('storyboards').delete().eq('id', storyboardId).eq('user_id', p.userId);
    await db.from('video_assets').delete().eq('id', assetId).eq('user_id', p.userId);
    await db.storage.from(MEDIA_BUCKET).remove([photo.path]);
  };
  const asset = await db.from('video_assets').insert({ id: assetId, user_id: p.userId, instagram_account_id: accountId, storage_path: photo.path, media_type: 'image', mime_type: 'image/jpeg', size_bytes: photo.bytes, source: 'product' });
  if (asset.error) { await undo(); throw new BrainError('Não foi possível registrar a foto do produto. Tente de novo.'); }
  const created = await db.from('storyboards').insert({
    id: storyboardId, user_id: p.userId, instagram_account_id: accountId, product_id: p.productId, product_title: title.slice(0, 300), status: 'planned', with_speech: p.withSpeech,
    concept: plan.concept, presenter: plan.presenter, reference_path: photo.path, plan, image_model: DEFAULT_IMAGE_MODEL, cost_micros: costMicros,
  });
  if (created.error) { await undo(); throw new BrainError('Não foi possível salvar o storyboard. Tente de novo.'); }
  const scenes = await db.from('storyboard_scenes').insert(plan.scenes.map((scene, index) => ({
    id: crypto.randomUUID(), user_id: p.userId, storyboard_id: storyboardId, position: index, title: scene.title, shot: scene.shot, motion: scene.motion, speech: scene.speech, on_screen_text: scene.on_screen_text, status: 'pending',
  })));
  if (scenes.error) { await undo(); throw new BrainError('Não foi possível salvar as cenas. Tente de novo.'); }
  await db.from('activity_log').insert({ user_id: p.userId, action: 'Storyboard planejado', result: `Produto "${title.slice(0, 80)}", ${SCENE_COUNT} cenas${p.withSpeech ? ' com fala' : ' sem fala'}`, details: { storyboard_id: storyboardId, product_id: p.productId, cost_micros: costMicros } });
  return { storyboardId, costMicros };
}

async function download(db: Db, path: string): Promise<Uint8Array | null> {
  const { data, error } = await db.storage.from(MEDIA_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export type SceneResult = { sceneId: string; costMicros: number; storyboardStatus: string; skipped: 'done' | 'busy' | null };

/**
 * Draws one scene: takes the real product photo (and, for the next scenes of a storyboard with a person, the first finished scene) as references,
 * asks OpenAI for the image, stores it, and records the cost. Claiming the scene first means two clicks never draw (and pay for) the same scene twice.
 */
export async function generateScene(db: Db, p: { userId: string; masterKey: string; sceneId: string; fetcher?: Fetcher; now?: () => number }): Promise<SceneResult> {
  const now = p.now ?? Date.now; const at = now();
  const { data: sceneRow } = await db.from('storyboard_scenes').select('*').eq('id', p.sceneId).eq('user_id', p.userId).maybeSingle();
  const scene = sceneRow as Row | null;
  if (!scene) throw new BrainError('Não encontrei essa cena.');
  const storyboardId = str(scene['storyboard_id']);
  const { data: boardRow } = await db.from('storyboards').select('*').eq('id', storyboardId).eq('user_id', p.userId).maybeSingle();
  const board = boardRow as Row | null;
  if (!board || str(board['status']) === 'discarded') throw new BrainError('Esse storyboard foi descartado.');
  const base = { sceneId: p.sceneId, costMicros: 0, storyboardStatus: str(board['status']) };
  if (str(scene['status']) === 'done') return { ...base, skipped: 'done' };
  if (str(scene['status']) === 'generating' && at - Date.parse(str(scene['updated_at']) || new Date(at).toISOString()) < SCENE_STALE_MS) return { ...base, skipped: 'busy' };

  // Claim: only one request may move the scene to "generating".
  const claimStatuses = str(scene['status']) === 'generating' ? ['generating'] : ['pending', 'failed'];
  const claimed = await db.from('storyboard_scenes').update({ status: 'generating', attempts: num(scene['attempts']) + 1, last_error: null, updated_at: new Date(at).toISOString() })
    .eq('id', p.sceneId).eq('user_id', p.userId).in('status', claimStatuses).select('id');
  if (!(claimed.data as Row[] | null)?.length) return { ...base, skipped: 'busy' };
  const fail = async (message: string): Promise<never> => {
    await db.from('storyboard_scenes').update({ status: 'failed', last_error: message }).eq('id', p.sceneId).eq('user_id', p.userId);
    throw new BrainError(message);
  };

  const position = num(scene['position']); const presenter = str(board['presenter']) || null;
  const photo = await download(db, str(board['reference_path']));
  if (!photo) return fail('Não consegui abrir a foto do produto deste storyboard. Descarte-o e crie outro.');
  const references: Uint8Array[] = [photo];
  if (presenter && position > 0) {
    const { data: firstDone } = await db.from('storyboard_scenes').select('asset_id,position').eq('storyboard_id', storyboardId).eq('user_id', p.userId).eq('status', 'done').order('position', { ascending: true }).limit(1).maybeSingle();
    const firstAsset = str((firstDone as Row | null)?.['asset_id']);
    if (firstAsset) {
      const { data: asset } = await db.from('video_assets').select('storage_path').eq('id', firstAsset).eq('user_id', p.userId).maybeSingle();
      const bytes = await download(db, str((asset as Row | null)?.['storage_path']));
      if (bytes) references.push(bytes);
    }
  }
  const plan = { concept: str(board['concept']), presenter, scenes: [] } as unknown as StoryboardPlan;
  const prompt = buildScenePrompt(plan, { title: str(scene['title']), shot: str(scene['shot']), motion: str(scene['motion']), speech: str(scene['speech']) || null, on_screen_text: str(scene['on_screen_text']) || null }, position, { samePersonReference: references.length > 1 });

  let image;
  try {
    image = await askOpenAiImage(db, { userId: p.userId, masterKey: p.masterKey, purpose: 'imagem', model: str(board['image_model']) || DEFAULT_IMAGE_MODEL, prompt, references, ...(p.fetcher ? { fetcher: p.fetcher } : {}), now });
  } catch (error) {
    if (error instanceof OpenAiError) return fail(openAiErrorMessage(error.kind, error.detail));
    return fail('Não foi possível gerar esta imagem agora. Tente de novo.');
  }
  const path = `${p.userId}/${crypto.randomUUID()}.jpg`;
  const uploaded = await db.storage.from(MEDIA_BUCKET).upload(path, image.bytes, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
  if (uploaded.error) return fail('A imagem foi gerada, mas não foi possível guardá-la. Tente de novo.');
  const assetId = crypto.randomUUID();
  const asset = await db.from('video_assets').insert({ id: assetId, user_id: p.userId, instagram_account_id: str(board['instagram_account_id']), storage_path: path, media_type: 'image', mime_type: 'image/jpeg', size_bytes: image.bytes.length, source: 'ai_image' });
  if (asset.error) { await db.storage.from(MEDIA_BUCKET).remove([path]); return fail('A imagem foi gerada, mas não foi possível registrá-la. Tente de novo.'); }
  await db.from('storyboard_scenes').update({ status: 'done', asset_id: assetId, cost_micros: image.costMicros, last_error: null }).eq('id', p.sceneId).eq('user_id', p.userId);

  const { data: all } = await db.from('storyboard_scenes').select('status').eq('storyboard_id', storyboardId).eq('user_id', p.userId);
  const finished = ((all ?? []) as Row[]).every(row => str(row['status']) === 'done');
  const status = finished ? 'ready' : 'generating';
  await db.from('storyboards').update({ status, cost_micros: num(board['cost_micros']) + image.costMicros }).eq('id', storyboardId).eq('user_id', p.userId);
  await db.from('activity_log').insert({ user_id: p.userId, action: 'Imagem do storyboard criada', result: `Cena ${position + 1} de ${SCENE_COUNT}`, details: { storyboard_id: storyboardId, scene_id: p.sceneId, cost_micros: image.costMicros } });
  return { sceneId: p.sceneId, costMicros: image.costMicros, storyboardStatus: status, skipped: null };
}

/** The storyboard with its scenes, and a temporary address for each finished image. */
export async function loadStoryboard(db: Db, userId: string, storyboardId: string): Promise<StoryboardView | null> {
  const { data: boardRow } = await db.from('storyboards').select('*').eq('id', storyboardId).eq('user_id', userId).maybeSingle();
  const board = boardRow as Row | null;
  if (!board) return null;
  const { data: sceneRows } = await db.from('storyboard_scenes').select('*').eq('storyboard_id', storyboardId).eq('user_id', userId).order('position', { ascending: true });
  const rows = (sceneRows ?? []) as Row[];
  const assetIds = rows.map(row => str(row['asset_id'])).filter(Boolean);
  const paths = new Map<string, string>();
  if (assetIds.length) {
    const { data: assets } = await db.from('video_assets').select('id,storage_path').eq('user_id', userId).in('id', assetIds);
    for (const asset of (assets ?? []) as Row[]) paths.set(str(asset['id']), str(asset['storage_path']));
  }
  const scenes: StoryboardSceneView[] = [];
  for (const row of rows) {
    const path = paths.get(str(row['asset_id']));
    let imageUrl: string | null = null;
    if (path) { const signed = await db.storage.from(MEDIA_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS); imageUrl = signed.data?.signedUrl ?? null; }
    scenes.push({
      id: str(row['id']), position: num(row['position']), title: str(row['title']), shot: str(row['shot']), motion: str(row['motion']), speech: str(row['speech']) || null,
      onScreenText: str(row['on_screen_text']) || null, status: str(row['status']), imageUrl, lastError: str(row['last_error']) || null, costMicros: num(row['cost_micros']),
    });
  }
  return {
    id: storyboardId, status: str(board['status']), productTitle: str(board['product_title']), concept: str(board['concept']), presenter: str(board['presenter']) || null,
    withSpeech: board['with_speech'] === true, costMicros: num(board['cost_micros']), createdAt: str(board['created_at']), scenes,
  };
}

/** The latest storyboards, newest first, with how many scenes are drawn. Discarded ones are left out. */
export async function listStoryboards(db: Db, userId: string): Promise<StoryboardSummary[]> {
  const { data } = await db.from('storyboards').select('id,product_title,status,created_at,cost_micros').eq('user_id', userId).neq('status', 'discarded').order('created_at', { ascending: false }).limit(10);
  const boards = (data ?? []) as Row[];
  if (!boards.length) return [];
  const { data: sceneRows } = await db.from('storyboard_scenes').select('storyboard_id,status').eq('user_id', userId).in('storyboard_id', boards.map(board => str(board['id'])));
  const scenes = (sceneRows ?? []) as Row[];
  return boards.map(board => {
    const own = scenes.filter(scene => str(scene['storyboard_id']) === str(board['id']));
    return { id: str(board['id']), productTitle: str(board['product_title']), status: str(board['status']), createdAt: str(board['created_at']), doneScenes: own.filter(scene => str(scene['status']) === 'done').length, totalScenes: own.length, costMicros: num(board['cost_micros']) };
  });
}

export async function discardStoryboard(db: Db, userId: string, storyboardId: string): Promise<boolean> {
  const { data } = await db.from('storyboards').update({ status: 'discarded' }).eq('id', storyboardId).eq('user_id', userId).select('id');
  return Boolean((data as Row[] | null)?.length);
}