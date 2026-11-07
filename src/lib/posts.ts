import { z } from 'zod';
import { isShopeeUrl } from './products';

/** Public storage space for photos and videos. Each user only writes inside the folder named with their own id. */
export const MEDIA_BUCKET = 'media';
export const MAX_FILE_BYTES = 52_428_800; // 50 MB, the bucket limit
export const MAX_CAPTION = 2200; // Instagram caption limit
export const MAX_SCHEDULE_DAYS = 60;

export const POST_FORMATS = ['reel', 'story', 'photo', 'carousel'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];
export const FORMAT_LABELS: Record<PostFormat, string> = { reel: 'Reels', story: 'Story', photo: 'Foto', carousel: 'Carrossel' };

export type MediaKind = 'image' | 'video';
export const IMAGE_MIME = 'image/jpeg';
export const VIDEO_MIMES = ['video/mp4', 'video/quicktime'] as const;
export const ALLOWED_MIMES: readonly string[] = [IMAGE_MIME, ...VIDEO_MIMES];

export const kindOfMime = (mime: string): MediaKind | null => (mime === IMAGE_MIME ? 'image' : (VIDEO_MIMES as readonly string[]).includes(mime) ? 'video' : null);
export const extensionOfMime = (mime: string): string | null => (mime === IMAGE_MIME ? 'jpg' : mime === 'video/mp4' ? 'mp4' : mime === 'video/quicktime' ? 'mov' : null);
export const mimeOfExtension = (ext: string): string | null => (ext === 'jpg' ? IMAGE_MIME : ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' : null);

export const FORMAT_RULES: Record<PostFormat, { min: number; max: number; kinds: readonly MediaKind[]; hint: string }> = {
  reel: { min: 1, max: 1, kinds: ['video'], hint: '1 vídeo (MP4 ou MOV)' },
  story: { min: 1, max: 1, kinds: ['image', 'video'], hint: '1 foto ou 1 vídeo' },
  photo: { min: 1, max: 1, kinds: ['image'], hint: '1 foto' },
  carousel: { min: 2, max: 10, kinds: ['image', 'video'], hint: 'de 2 a 10 fotos ou vídeos' },
};

/** Returns a message in Portuguese when the files do not fit the chosen format, otherwise null. */
export function validateMedia(format: PostFormat, kinds: readonly MediaKind[]): string | null {
  const rule = FORMAT_RULES[format];
  if (kinds.length < rule.min || kinds.length > rule.max) return `${FORMAT_LABELS[format]} precisa de ${rule.hint}.`;
  if (kinds.some(kind => !rule.kinds.includes(kind))) return `${FORMAT_LABELS[format]} aceita ${rule.kinds.length === 1 ? (rule.kinds[0] === 'video' ? 'só vídeo' : 'só foto') : 'foto e vídeo'}.`;
  return null;
}

export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'canceled'] as const;
export const STATUS_LABELS: Record<string, string> = { draft: 'Rascunho', scheduled: 'Agendada', publishing: 'Publicando', published: 'Publicada', failed: 'Falhou', canceled: 'Cancelada' };
export const CANCELABLE_STATUSES = ['draft', 'scheduled'] as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** "<user id>/<random id>.<jpg|mp4|mov>", the only shape the upload screen produces. */
export const mediaPathSchema = z.string().max(120).regex(new RegExp(`^${UUID}/${UUID}\\.(jpg|mp4|mov)$`), 'Arquivo inválido.');
export const ownsMediaPath = (path: string, userId: string) => path.startsWith(`${userId}/`);

export const createPostSchema = z.object({
  requestId: z.string().uuid(),
  format: z.enum(POST_FORMATS),
  productId: z.string().uuid('Escolha o produto da publicação.'),
  caption: z.string().trim().max(MAX_CAPTION, `A legenda pode ter no máximo ${MAX_CAPTION} caracteres.`).default(''),
  affiliateLink: z.string().trim().max(600).refine(value => value === '' || isShopeeUrl(value), 'O link precisa ser da Shopee (shope.ee ou shopee.com.br).').default(''),
  scheduledAt: z.string().datetime().nullable().default(null),
  media: z.array(z.object({ path: mediaPathSchema })).min(1, 'Envie pelo menos um arquivo.').max(10, 'No máximo 10 arquivos.'),
});
export type CreatePostInput = z.infer<typeof createPostSchema>;

/** Message when the chosen time cannot be used, otherwise null. */
export function checkSchedule(iso: string | null, now = Date.now()): string | null {
  if (iso === null) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return 'Escolha uma data e hora válidas.';
  if (time < now + 60_000) return 'Escolha um horário que ainda não passou.';
  if (time > now + MAX_SCHEDULE_DAYS * 86_400_000) return `Agende no máximo ${MAX_SCHEDULE_DAYS} dias à frente.`;
  return null;
}

/** Turns a wall-clock time typed as "YYYY-MM-DDTHH:mm" in the given time zone into an ISO instant (UTC). Null when invalid. */
export function zonedTimeToUtcIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const offsetAt = (ms: number) => {
      const parts = formatter.formatToParts(new Date(ms));
      const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms;
    };
    let guess = wall - offsetAt(wall);
    guess = wall - offsetAt(guess);
    const result = new Date(guess);
    return Number.isNaN(result.getTime()) ? null : result.toISOString();
  } catch { return null; }
}

export function formatInZone(iso: string, timeZone: string | undefined) {
  try { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso)); } catch { return iso; }
}
