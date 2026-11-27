// Server-only: manual test of the "EU QUERO" reply that does not depend on Meta's webhook. It reads the latest comments of the latest published
// posts straight from the Instagram API, keeps only the recent ones that carry the trigger, queues them and sends the private replies.
// Safety limits: only comments of the last two hours by default, never more than three messages per click, never the account's own comments.
import type { SupabaseClient } from '@supabase/supabase-js';
import { GRAPH_VERSION } from './instagram';
import { getPublishingToken } from './instagram.server';
import { DEFAULT_TRIGGER, matchesTrigger, type CommentEvent } from './comment-reply';
import { ingestEvents, sendPending, type SendResult } from './comment-reply.server';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const MAX_POSTS = 10;
const MAX_MESSAGES = 3;

export type SyncResult = { posts: number; comments: number; recent: number; skipped: number; matched: number; queued: number; send: SendResult | null; problem: string | null };

/** "2026-11-27T00:10:00+0000" (Instagram) becomes a time in milliseconds; NaN when it cannot be read. */
const timeOf = (value: string) => Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

async function listComments(fetcher: Fetcher, token: string, mediaId: string): Promise<{ items: Row[]; problem: string | null; foreign?: boolean }> {
  try {
    const res = await fetcher(`${GRAPH}/${encodeURIComponent(mediaId)}/comments?fields=id,text,username,timestamp&limit=25`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => null)) as Row | null;
    const error = json?.['error'] && typeof json['error'] === 'object' ? (json['error'] as Row) : null;
    // Code 100: the post does not exist for the connected account (it was published through another Instagram account). It is skipped, not an error.
    if (error?.['code'] === 100) return { items: [], problem: null, foreign: true };
    if (error || !res.ok) return { items: [], problem: `O Instagram recusou a leitura dos comentários (${str(error?.['message']).slice(0, 160) || `código ${res.status}`}).` };
    return { items: Array.isArray(json?.['data']) ? (json['data'] as Row[]) : [], problem: null };
  } catch {
    return { items: [], problem: 'Não consegui falar com o Instagram agora. Tente de novo.' };
  }
}

export async function syncRecentComments(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number; sinceMinutes?: number }): Promise<SyncResult> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const result: SyncResult = { posts: 0, comments: 0, recent: 0, skipped: 0, matched: 0, queued: 0, send: null, problem: null };

  const { data: settings } = await db.from('comment_reply_settings').select('enabled').eq('user_id', p.userId).maybeSingle();
  if ((settings as Row | null)?.['enabled'] !== true) { result.problem = 'A resposta automática está desligada. Marque "Ligar a resposta automática" e clique em Salvar.'; return result; }

  let credentials: Awaited<ReturnType<typeof getPublishingToken>> = null;
  try { credentials = await getPublishingToken(db as never, p.userId, p.masterKey, now()); } catch { credentials = null; }
  if (!credentials) { result.problem = 'A conexão com o Instagram expirou. Reconecte na tela Conexões.'; return result; }

  const { data: account } = await db.from('instagram_accounts').select('username').eq('user_id', p.userId).limit(1).maybeSingle();
  const own = str((account as Row | null)?.['username']).toLowerCase();
  const { data: posts } = await db.from('posts').select('id,ig_media_id,trigger_word').eq('user_id', p.userId).eq('status', 'published').not('ig_media_id', 'is', null).order('published_at', { ascending: false }).limit(MAX_POSTS);
  const published = (posts ?? []) as Row[];
  result.posts = published.length;
  if (!published.length) { result.problem = 'Não há nenhuma publicação com o Instagram para verificar.'; return result; }

  const since = now() - (p.sinceMinutes ?? 120) * 60_000;
  const found: { event: CommentEvent; at: number }[] = [];
  for (const post of published) {
    const mediaId = str(post['ig_media_id']);
    const listed = await listComments(fetcher, credentials.token, mediaId);
    if (listed.problem) { result.problem = listed.problem; return result; }
    if (listed.foreign) { result.skipped++; continue; }
    for (const item of listed.items) {
      result.comments++;
      const at = timeOf(str(item['timestamp']));
      if (Number.isNaN(at) || at < since) continue;
      result.recent++;
      const username = str(item['username']) || null;
      if (username && username.toLowerCase() === own) continue;
      if (!matchesTrigger(str(item['text']), str(post['trigger_word']) || DEFAULT_TRIGGER)) continue;
      const commentId = str(item['id']);
      if (!commentId) continue;
      found.push({ at, event: { igUserId: credentials.igUserId, commentId, mediaId, fromId: null, username, text: str(item['text']), parentId: null } });
    }
  }
  if (result.skipped === published.length) { result.problem = 'Nenhuma das últimas publicações pertence à conta conectada agora: elas foram publicadas por outra conta do Instagram. Publique um post pela conta atual e comente nele.'; return result; }
  const chosen = found.sort((a, b) => b.at - a.at).slice(0, MAX_MESSAGES).map(entry => entry.event);
  result.matched = chosen.length;
  if (chosen.length) result.queued = await ingestEvents(db, chosen, { now });
  result.send = await sendPending(db, { masterKey: p.masterKey, ...(p.fetcher ? { fetcher: p.fetcher } : {}), now, limit: MAX_MESSAGES });
  return result;
}
