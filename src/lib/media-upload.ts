import { supabase } from '@/integrations/supabase/client';
import { IMAGE_MIME, MAX_FILE_BYTES, MEDIA_BUCKET, extensionOfMime, kindOfMime, type MediaKind } from './posts';

export type PreparedFile = { blob: Blob; mime: string; ext: string; kind: MediaKind; name: string };
const MAX_EDGE = 1920;

function mimeOf(file: File) {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  return name.endsWith('.mov') ? 'video/quicktime' : name.endsWith('.mp4') ? 'video/mp4' : '';
}

/** Re-draws any picture the browser can read as a JPEG (the only photo type Instagram accepts). This also drops hidden data such as location. */
async function toJpeg(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise<Blob | null>(resolve => canvas.toBlob(blob => resolve(blob), IMAGE_MIME, 0.92));
  } catch { return null; }
}

export async function prepareFile(file: File): Promise<PreparedFile | { error: string }> {
  const mime = mimeOf(file);
  if (mime.startsWith('image/')) {
    const jpeg = await toJpeg(file);
    const blob = jpeg ?? (mime === IMAGE_MIME ? file : null);
    if (!blob) return { error: `Não consegui ler a imagem "${file.name}". Use uma foto JPEG ou PNG.` };
    if (blob.size > MAX_FILE_BYTES) return { error: `"${file.name}" passa de 50 MB.` };
    return { blob: new Blob([blob], { type: IMAGE_MIME }), mime: IMAGE_MIME, ext: 'jpg', kind: 'image', name: file.name };
  }
  const kind = kindOfMime(mime); const ext = extensionOfMime(mime);
  if (!kind || !ext || kind !== 'video') return { error: `"${file.name}" não é um tipo aceito. Use foto (JPEG ou PNG) ou vídeo MP4 ou MOV.` };
  if (file.size > MAX_FILE_BYTES) return { error: `"${file.name}" passa de 50 MB.` };
  return { blob: new Blob([file], { type: mime }), mime, ext, kind, name: file.name };
}

/** Sends one prepared file to the user's own folder. The name is a random code, so the public address cannot be guessed. */
export async function uploadPrepared(userId: string, file: PreparedFile): Promise<{ path: string } | { error: string }> {
  const path = `${userId}/${crypto.randomUUID()}.${file.ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file.blob, { contentType: file.mime, upsert: false, cacheControl: '31536000' });
  if (error) return { error: `Não foi possível enviar "${file.name}". Tente de novo.` };
  return { path };
}

export async function removeUploads(paths: string[]) {
  if (paths.length) await supabase.storage.from(MEDIA_BUCKET).remove(paths).catch(() => null);
}