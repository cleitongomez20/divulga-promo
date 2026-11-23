import { z } from 'zod';

/** The phrase a follower comments to receive the link (a post can have its own, saved in posts.trigger_word). */
export const DEFAULT_TRIGGER = 'EU QUERO';
/** An Instagram direct message can hold at most 1,000 bytes of text. */
export const DM_MAX_BYTES = 1000;
/** A private reply can be sent up to 7 days after the comment; a margin is kept so the last hours are not risked. */
export const REPLY_WINDOW_MS = 7 * 86_400_000 - 10 * 60_000;
export const MAX_SEND_ATTEMPTS = 3;
/** The most messages one account sends in an hour, so a viral post cannot look like spam to Instagram. */
export const MAX_DMS_PER_HOUR = 80;
/** The shortest pause between two messages of the same account. */
export const SEND_PACE_MS = 2000;
/** A message stuck "sending" for this long is put back in the queue (a crash in the middle). */
export const STALE_SENDING_MS = 5 * 60_000;
export const WEBHOOK_PATH = '/api/public/meta-webhook';

export const DEFAULT_TEMPLATE = 'Oi! 😍 Aqui está o link do produto que você pediu:\n{link}\n\nSe tiver qualquer dúvida, é só responder esta mensagem.';
export const replySettingsSchema = z.object({
  enabled: z.boolean(),
  template: z.string().trim().min(5, 'A mensagem está muito curta.').max(600, 'A mensagem pode ter no máximo 600 caracteres.').refine(value => value.includes('{link}'), 'A mensagem precisa ter {link}, o lugar onde o link do produto entra.'),
});

const byteLength = (value: string) => new TextEncoder().encode(value).length;
/** Lower case, no accents, no punctuation, single spaces: "Eu quero!!! 😍" becomes "eu quero". */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/** True when the comment contains the trigger phrase as whole words, ignoring case, accents and punctuation. */
export function matchesTrigger(commentText: string, trigger: string): boolean {
  const wanted = normalizeText(trigger);
  if (!wanted) return false;
  return ` ${normalizeText(commentText)} `.includes(` ${wanted} `);
}

/** The message with the link in place. Too long for Instagram: the default message is used instead, so the link always goes out. */
export function buildDm(template: string, link: string): string {
  const message = template.split('{link}').join(link).trim();
  return byteLength(message) <= DM_MAX_BYTES ? message : DEFAULT_TEMPLATE.replace('{link}', link);
}

export type CommentEvent = { igUserId: string; commentId: string; fromId: string | null; username: string | null; text: string; mediaId: string; parentId: string | null };
/** Ids arrive as text. A number is refused on purpose: a long number loses digits and would point to the wrong comment. */
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const obj = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Reads the comments out of a Meta notification (both shapes Meta uses: the "changes" list, and the field directly in the entry). */
export function parseWebhook(body: unknown): CommentEvent[] {
  const root = obj(body);
  if (!root || root['object'] !== 'instagram' || !Array.isArray(root['entry'])) return [];
  const events: CommentEvent[] = [];
  for (const rawEntry of root['entry'] as unknown[]) {
    const entry = obj(rawEntry); const igUserId = text(entry?.['id']);
    if (!entry || !igUserId) continue;
    const changes: { field: unknown; value: unknown }[] = [];
    if (Array.isArray(entry['changes'])) for (const change of entry['changes'] as unknown[]) { const c = obj(change); if (c) changes.push({ field: c['field'], value: c['value'] }); }
    if (entry['field'] !== undefined) changes.push({ field: entry['field'], value: entry['value'] });
    for (const change of changes) {
      if (change.field !== 'comments') continue;
      const value = obj(change.value); if (!value) continue;
      const commentId = text(value['id']) ?? text(value['comment_id']);
      const mediaId = text(obj(value['media'])?.['id']) ?? text(value['media_id']);
      if (!commentId || !mediaId) continue;
      const from = obj(value['from']);
      events.push({ igUserId, commentId, mediaId, fromId: text(from?.['id']), username: text(from?.['username']), text: typeof value['text'] === 'string' ? value['text'] : '', parentId: text(value['parent_id']) });
    }
  }
  return events;
}

/** Checks the "X-Hub-Signature-256" header: the SHA-256 signature of the exact text received, made with the app secret. */
export async function verifySignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !header.toLowerCase().startsWith('sha256=') || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7).toLowerCase();
  let diff = expected.length ^ given.length;
  for (let i = 0; i < Math.max(expected.length, given.length); i++) diff |= (expected.charCodeAt(i) || 0) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

/** What the answer of Instagram to a private reply means for the app. */
export type SendOutcome = 'sent' | 'already' | 'expired' | 'blocked' | 'auth' | 'permission' | 'retry' | 'invalid';
export function outcomeOf(error: { code: number | null; subcode: number | null; status: number | null }): SendOutcome {
  const numbers = [error.code, error.subcode];
  if (numbers.includes(2534023)) return 'already';
  if (numbers.includes(2534025)) return 'expired';
  if (numbers.includes(2534022)) return 'blocked';
  if (error.code === 190 || error.status === 401) return 'auth';
  if (error.code === 10 || (error.code !== null && error.code >= 200 && error.code < 300) || error.status === 403) return 'permission';
  if ([1, 2, 4, 17, 32, 341, 368, 613].includes(error.code ?? -1) || error.status === 429 || (error.status !== null && error.status >= 500)) return 'retry';
  return 'invalid';
}
export function outcomeMessage(outcome: SendOutcome): string {
  switch (outcome) {
    case 'sent': return 'Mensagem enviada.';
    case 'already': return 'Essa pessoa já tinha recebido uma resposta privada para este comentário.';
    case 'expired': return 'O comentário é antigo demais ou foi apagado, e o Instagram não deixa mais responder.';
    case 'blocked': return 'A pessoa não aceita mensagens de contas que ela não conhece (configuração de privacidade dela).';
    case 'auth': return 'A conexão com o Instagram expirou. Reconecte na tela Conexões.';
    case 'permission': return 'O app da Meta não tem permissão para enviar mensagens. Confira as permissões de mensagem.';
    case 'retry': return 'O Instagram está com instabilidade ou limitando as mensagens. Vou tentar de novo.';
    default: return 'O Instagram recusou a mensagem.';
  }
}
