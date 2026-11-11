import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { claudeErrorMessage, formatUsd } from './claude';
import { higgsfieldErrorMessage } from './higgsfield';
import { VIDEO_FORMATS, VIDEO_FORMAT_LABELS } from './video-brain';

export type GenerateResult = { status: 'ok'; message: string; postId: string } | { status: 'error'; message: string };

/** Everything the generating functions share: the database, the secret key, the spacing between runs and the affiliate link maker. */
async function prepare(userId: string, scope: string) {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const db = supabaseAdmin as unknown as SupabaseClient;
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) return { error: 'O armazenamento seguro ainda não está disponível.' } as const;
  // Spacing between runs, so a double click cannot spend twice.
  const { data: delay, error: slotError } = await db.rpc('reserve_connector_slot', { p_scope: `${scope}:${userId}`, p_interval_ms: 8000 });
  if (!slotError && typeof delay === 'number' && delay > 0) return { error: 'Aguarde alguns segundos e tente de novo.' } as const;
  const { buildShortLinkMutation, isShopeeUrl, safeUrl } = await import('./products');
  const makeLink = async (productUrl: string, subIds: string[]) => {
    const { openConnector } = await import('./shopee-sync.server');
    const connector = await openConnector(supabaseAdmin, userId);
    if (!connector) return null;
    // Same safety pause between link requests as the Produtos screen (3 seconds per user).
    const { data: linkWait } = await db.rpc('reserve_connector_slot', { p_scope: `shopee-link:${userId}`, p_interval_ms: 3000 });
    if (typeof linkWait === 'number' && linkWait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(linkWait, 4000)));
    const result = await connector.execute({ query: buildShortLinkMutation(productUrl, subIds) });
    if (!result.ok) return null;
    const link = safeUrl((result.data['generateShortLink'] as { shortLink?: unknown } | null | undefined)?.shortLink);
    return link && isShopeeUrl(link) ? link : null;
  };
  return { db, key, makeLink } as const;
}
/** Turns the errors the generating code raises into a message the user can read. */
async function explain(error: unknown): Promise<GenerateResult> {
  const { BrainError } = await import('./content-brain.server');
  const { ClaudeError } = await import('./claude.server');
  const { HiggsfieldError } = await import('./higgsfield.server');
  if (error instanceof BrainError) return { status: 'error', message: error.message };
  if (error instanceof ClaudeError) return { status: 'error', message: claudeErrorMessage(error.kind, error.detail) };
  if (error instanceof HiggsfieldError) return { status: 'error', message: higgsfieldErrorMessage(error.kind, error.detail) };
  return { status: 'error', message: 'Não foi possível gerar o conteúdo agora. Tente de novo.' };
}

/** Generates one photo draft: the Claude brain picks a saved product and writes the caption. The user reviews and approves it on the Publicações screen. */
export const generateContent = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<GenerateResult> => {
  const userId = context.userId;
  try {
    const ready = await prepare(userId, 'ai-draft');
    if ('error' in ready) return { status: 'error', message: ready.error };
    try {
      const { generateAiDraft } = await import('./content-brain.server');
      const draft = await generateAiDraft(ready.db, { userId, masterKey: ready.key, makeLink: ready.makeLink });
      const link = draft.linkMissing ? ' Ainda sem link de afiliado: conecte a Shopee ou tente de novo.' : '';
      return { status: 'ok', postId: draft.postId, message: `Rascunho criado para "${draft.productTitle.slice(0, 70)}". Custo estimado: ${formatUsd(draft.costMicros)}.${link}` };
    } catch (error) { return await explain(error); }
  } catch { return { status: 'error', message: 'Não foi possível gerar o conteúdo agora. Tente de novo.' }; }
});

/**
 * Orders a Reels or Story video: the Claude brain picks a saved product, a video tool from our catalog and writes the plan;
 * the order goes to Higgsfield and the post shows as "Gerando vídeo" until the scheduler brings the finished video in as a draft.
 */
export const generateVideo = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ format: z.enum(VIDEO_FORMATS) }).parse(input)).handler(async ({ context, data }): Promise<GenerateResult> => {
    const userId = context.userId;
    try {
      const ready = await prepare(userId, 'ai-video');
      if ('error' in ready) return { status: 'error', message: ready.error };
      try {
        const { startVideoDraft } = await import('./video-brain.server');
        const draft = await startVideoDraft(ready.db, { userId, masterKey: ready.key, format: data.format, makeLink: ready.makeLink });
        const link = draft.linkMissing ? ' Ainda sem link de afiliado: conecte a Shopee ou tente de novo.' : '';
        return {
          status: 'ok', postId: draft.postId,
          message: `${VIDEO_FORMAT_LABELS[data.format]} pedido para "${draft.productTitle.slice(0, 60)}": ${draft.duration}s com ${draft.tool}. Custo estimado: ${formatUsd(draft.estimatedMicros)} de vídeo mais ${formatUsd(draft.costMicros)} do Claude. O vídeo leva alguns minutos e aparece como rascunho.${link}`,
        };
      } catch (error) { return await explain(error); }
    } catch { return { status: 'error', message: 'Não foi possível pedir o vídeo agora. Tente de novo.' }; }
  });
