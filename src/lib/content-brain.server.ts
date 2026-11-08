// Server-only: the content brain. The code decides what the AI may choose from and checks everything it writes;
// the AI only picks one product and writes the text. Nothing is published here: the result is always a draft for the user to approve.
import type { SupabaseClient } from '@supabase/supabase-js';
import { askClaude, type ClaudeMessage } from './claude.server';
import {
  AI_FORMATS_NOW, assembleCaption, buildPrompt, feedbackMessage, isShopeeImageUrl, judgeAnswer, pickCandidates, subIdOf, TRIGGER_WORD, type AiOutput, type ProductCandidate,
} from './content-brain';
import { MEDIA_BUCKET } from './posts';
import { encodeSubIds } from './products';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

/** An error whose message is already written for the user. */
export class BrainError extends Error {}
export type DraftResult = { postId: string; productTitle: string; costMicros: number; linkMissing: boolean };

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const numOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Downloads a Shopee product photo. Only Shopee hosts, at most two redirects, and the bytes must really be a JPEG. */
export async function downloadJpeg(fetcher: Fetcher, url: string): Promise<Uint8Array | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!isShopeeImageUrl(current)) return null;
    let res: Response;
    try { res = await fetcher(current, { redirect: 'manual', headers: { accept: 'image/jpeg,image/*;q=0.8' }, signal: AbortSignal.timeout(12_000) }); } catch { return null; }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location'); if (!next) return null;
      try { current = new URL(next, current).toString(); } catch { return null; }
      continue;
    }
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 5_000 || bytes.length > 10_000_000) return null;
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
  }
  return null;
}

export async function generateAiDraft(db: Db, p: {
  userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number;
  /** Turns a Shopee product address into a tracked affiliate link. Returns null when it cannot (the draft is then created without a link). */
  makeLink?: (productUrl: string, subIds: string[]) => Promise<string | null>;
}): Promise<DraftResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now; const at = now();

  const { data: account } = await db.from('instagram_accounts').select('id').eq('user_id', p.userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!account) throw new BrainError('Conecte o Instagram na tela Conexões antes de gerar conteúdo.');
  const accountId = str((account as Row)['id']);

  const { data: settings } = await db.from('settings').select('repeat_days').eq('user_id', p.userId).maybeSingle();
  const repeatDays = numOrNull((settings as Row | null)?.['repeat_days']) ?? 14;
  const [productsResult, recentResult] = await Promise.all([
    db.from('products').select('id,external_id,title,price,commission,sales,rating,images,url,collected_at').eq('user_id', p.userId).eq('marketplace', 'shopee').order('collected_at', { ascending: false }).limit(300),
    db.from('posts').select('product_id').eq('user_id', p.userId).neq('status', 'canceled').gte('created_at', new Date(at - repeatDays * 86_400_000).toISOString()),
  ]);
  if (productsResult.error || recentResult.error) throw new BrainError('Não foi possível ler os seus produtos agora. Tente de novo.');
  const recent = new Set(((recentResult.data ?? []) as Row[]).map(row => str(row['product_id'])));
  const all: ProductCandidate[] = [];
  for (const row of (productsResult.data ?? []) as Row[]) {
    const images = Array.isArray(row['images']) ? (row['images'] as unknown[]) : [];
    const imageUrl = str(images[0]); const url = str(row['url']);
    if (!imageUrl || !url) continue;
    all.push({ id: str(row['id']), externalId: str(row['external_id']), title: str(row['title']), price: numOrNull(row['price']), commission: numOrNull(row['commission']), sales: numOrNull(row['sales']), rating: numOrNull(row['rating']), imageUrl, url, collectedAt: str(row['collected_at']) });
  }
  const candidates = pickCandidates(all, { nowMs: at, recentProductIds: recent });
  if (!candidates.length) throw new BrainError(`Não há produtos disponíveis. Busque produtos na tela Produtos: só entram os salvos nos últimos 30 dias, com foto, bem avaliados e que não foram usados nos últimos ${repeatDays} dias.`);

  // The AI answers, the code checks. One correction round at most, with the problems sent back as feedback.
  const { system, user } = buildPrompt(candidates);
  const ids = new Set(candidates.map(item => item.id));
  const messages: ClaudeMessage[] = [{ role: 'user', content: user }];
  let costMicros = 0; let output: AiOutput | null = null; let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2 && !output; attempt++) {
    const reply = await askClaude(db, { userId: p.userId, masterKey: p.masterKey, purpose: 'conteudo', system, messages, maxTokens: 1500, timeoutMs: 60_000, fetcher, now });
    costMicros += reply.costMicros;
    const verdict = judgeAnswer(reply.text, ids);
    if (verdict.ok) { output = verdict.output; break; }
    lastProblems = verdict.problems;
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: feedbackMessage(verdict.problems) });
  }
  if (!output) {
    await db.from('activity_log').insert({ user_id: p.userId, action: 'Conteúdo recusado pelas regras', result: 'O Claude não escreveu dentro das regras', details: { problems: lastProblems } });
    throw new BrainError('O Claude não conseguiu escrever dentro das regras desta vez. Tente gerar de novo.');
  }
  const product = candidates.find(item => item.id === output?.chosen_product_id) as ProductCandidate;

  const bytes = await downloadJpeg(fetcher, product.imageUrl);
  if (!bytes) throw new BrainError('Não consegui baixar uma foto utilizável deste produto. Tente gerar de novo para escolher outro.');

  const postId = crypto.randomUUID(); const assetId = crypto.randomUUID();
  const subId = subIdOf(postId);
  let affiliateLink: string | null = null;
  try { affiliateLink = (await p.makeLink?.(product.url, encodeSubIds([subId, 'ia']))) ?? null; } catch { affiliateLink = null; }

  const path = `${p.userId}/${crypto.randomUUID()}.jpg`;
  const uploaded = await db.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
  if (uploaded.error) throw new BrainError('Não foi possível guardar a foto do produto. Tente de novo.');
  const undo = async () => {
    await db.from('posts').delete().eq('id', postId).eq('user_id', p.userId);
    await db.from('video_assets').delete().eq('id', assetId).eq('user_id', p.userId);
    await db.storage.from(MEDIA_BUCKET).remove([path]);
  };
  const asset = await db.from('video_assets').insert({ id: assetId, user_id: p.userId, instagram_account_id: accountId, storage_path: path, media_type: 'image', mime_type: 'image/jpeg', size_bytes: bytes.length, source: 'product' });
  if (asset.error) { await undo(); throw new BrainError('Não foi possível registrar a foto. Tente de novo.'); }
  const post = await db.from('posts').insert({
    id: postId, user_id: p.userId, instagram_account_id: accountId, product_id: product.id, format: AI_FORMATS_NOW[0], status: 'draft', caption: assembleCaption(output),
    trigger_word: TRIGGER_WORD, affiliate_link: affiliateLink, sub_id: subId, video_asset_id: assetId, idempotency_key: crypto.randomUUID(), source: 'ai',
    ai_plan: { reason: output.reason, angle: output.angle, hook: output.hook, costMicros, linkMissing: affiliateLink === null, generatedAt: new Date(at).toISOString() },
  });
  if (post.error) { await undo(); throw new BrainError('Não foi possível criar o rascunho. Tente de novo.'); }
  const media = await db.from('post_media').insert({ user_id: p.userId, post_id: postId, asset_id: assetId, position: 0 });
  if (media.error) { await undo(); throw new BrainError('Não foi possível ligar a foto ao rascunho. Tente de novo.'); }

  await db.from('activity_log').insert({ user_id: p.userId, action: 'Rascunho criado pelo Claude', result: `Foto do produto "${product.title.slice(0, 80)}"`, details: { post_id: postId, product_id: product.id, cost_micros: costMicros, link: affiliateLink !== null } });
  return { postId, productTitle: product.title, costMicros, linkMissing: affiliateLink === null };
}