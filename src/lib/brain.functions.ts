import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { formatUsd } from './claude';
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
  const { aiErrorMessage } = await import('./ai.server');
  const { HiggsfieldError } = await import('./higgsfield.server');
  if (error instanceof BrainError) return { status: 'error', message: error.message };
  const aiMessage = aiErrorMessage(error);
  if (aiMessage) return { status: 'error', message: aiMessage };
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
          message: `${VIDEO_FORMAT_LABELS[data.format]} pedido para "${draft.productTitle.slice(0, 60)}": ${draft.duration}s com ${draft.tool}. Custo estimado: ${formatUsd(draft.estimatedMicros)} de vídeo mais ${formatUsd(draft.costMicros)} da IA. O vídeo leva alguns minutos e aparece como rascunho.${link}`,
        };
      } catch (error) { return await explain(error); }
    } catch { return { status: 'error', message: 'Não foi possível pedir o vídeo agora. Tente de novo.' }; }
  });

/** The formats of the "Generate content with AI" button, in the order the screen shows them. */
export const GENERATE_FORMATS = ['reel', 'story', 'photo', 'carousel'] as const;
export type GenerateFormat = (typeof GENERATE_FORMATS)[number];
const GENERATE_LABELS: Record<GenerateFormat, string> = { reel: 'Reels', story: 'Story', photo: 'Publicação no Feed', carousel: 'Carrossel' };

/**
 * The manual start of the whole process: the user picks a format and clicks once. The AI chooses the product, writes everything and makes the
 * pictures or the video, and the post schedules itself (the publisher still respects the daily limit, the warm-up and the interval).
 * Feed and Carrossel are done right away. Reels and Story take a few minutes at Higgsfield and are scheduled the moment the video arrives.
 * It is the same process the automation uses; the only difference is who starts it.
 */
export const generateAiContent = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ format: z.enum(GENERATE_FORMATS) }).parse(input)).handler(async ({ context, data }): Promise<GenerateResult> => {
    const userId = context.userId;
    try {
      const ready = await prepare(userId, 'ai-content');
      if ('error' in ready) return { status: 'error', message: ready.error };
      try {
        const at = Date.now();
        if (data.format === 'reel' || data.format === 'story') {
          const { startVideoDraft } = await import('./video-brain.server');
          const draft = await startVideoDraft(ready.db, { userId, masterKey: ready.key, format: data.format, makeLink: ready.makeLink, auto: { mode: 'auto', scheduledAt: new Date(at).toISOString(), manual: true } });
          const link = draft.linkMissing ? ' Sem link de afiliado: o vídeo vai ficar como rascunho. Conecte a Shopee ou tente de novo.' : ' Quando ficar pronto, ele é agendado sozinho.';
          return {
            status: 'ok', postId: draft.postId,
            message: `${GENERATE_LABELS[data.format]} pedido para "${draft.productTitle.slice(0, 60)}": ${draft.duration}s com ${draft.tool}. Custo estimado: ${formatUsd(draft.estimatedMicros)} de vídeo mais ${formatUsd(draft.costMicros)} da IA. O vídeo leva alguns minutos e aparece em Suas publicações.${link}`,
          };
        }
        if (data.format === 'carousel') {
          // The carousel is made of six images drawn by OpenAI from the real product photo, so it needs OpenAI. It is built in the background and schedules itself.
          const { providerConnected } = await import('./ai.server');
          if (!(await providerConnected(ready.db, userId, 'openai'))) return { status: 'error', message: 'O carrossel usa imagens criadas pela OpenAI. Conecte a OpenAI na tela Conexões e confirme que a conexão está funcionando.' };
          const { startStoryContent } = await import('./story-video.server');
          const started = await startStoryContent(ready.db, { userId, masterKey: ready.key, format: 'carousel', makeLink: ready.makeLink, auto: { mode: 'auto', scheduledAt: new Date(at).toISOString(), manual: true } });
          const link = started.linkMissing ? ' Sem link de afiliado: o carrossel vai ficar como rascunho. Conecte a Shopee ou tente de novo.' : ' Quando ficar pronto, ele é agendado sozinho.';
          return { status: 'ok', postId: started.postId, message: `Carrossel pedido para "${started.productTitle.slice(0, 60)}". Custo estimado do texto: ${formatUsd(started.costMicros)}. A IA está criando as 6 imagens, o que leva alguns minutos, e o conteúdo aparece em Suas publicações.${link}` };
        }
        const { generateAiDraft } = await import('./content-brain.server');
        const draft = await generateAiDraft(ready.db, { userId, masterKey: ready.key, format: data.format, schedule: true, makeLink: ready.makeLink, now: () => at });
        const note = draft.scheduledAt ? ' Já está agendado: sai no próximo horário livre.' : ' Sem link de afiliado: ficou como rascunho. Conecte a Shopee ou tente de novo.';
        return { status: 'ok', postId: draft.postId, message: `${GENERATE_LABELS[data.format]} criado para "${draft.productTitle.slice(0, 70)}". Custo estimado: ${formatUsd(draft.costMicros)}.${note}` };
      } catch (error) { return await explain(error); }
    } catch { return { status: 'error', message: 'Não foi possível gerar o conteúdo agora. Tente de novo.' }; }
  });
