import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { claudeErrorMessage, formatUsd } from './claude';

export type GenerateResult = { status: 'ok'; message: string; postId: string } | { status: 'error'; message: string };

/** Generates one draft: the Claude brain picks a saved product and writes the caption. The user reviews and approves it on the Publicações screen. */
export const generateContent = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<GenerateResult> => {
  const userId = context.userId;
  try {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const db = supabaseAdmin as unknown as SupabaseClient;
    const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
    if (!key) return { status: 'error', message: 'O armazenamento seguro ainda não está disponível.' };
    // Spacing between runs, so a double click cannot spend twice.
    const { data: delay, error: slotError } = await db.rpc('reserve_connector_slot', { p_scope: `ai-draft:${userId}`, p_interval_ms: 8000 });
    if (!slotError && typeof delay === 'number' && delay > 0) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };

    const { generateAiDraft, BrainError } = await import('./content-brain.server');
    const { ClaudeError } = await import('./claude.server');
    const { buildShortLinkMutation, isShopeeUrl, safeUrl } = await import('./products');
    const makeLink = async (productUrl: string, subIds: string[]) => {
      const { openConnector } = await import('./shopee-sync.server');
      const connector = await openConnector(supabaseAdmin, userId);
      if (!connector) return null;
      const result = await connector.execute({ query: buildShortLinkMutation(productUrl, subIds) });
      if (!result.ok) return null;
      const link = safeUrl((result.data['generateShortLink'] as { shortLink?: unknown } | null | undefined)?.shortLink);
      return link && isShopeeUrl(link) ? link : null;
    };
    try {
      const draft = await generateAiDraft(db, { userId, masterKey: key, makeLink });
      const link = draft.linkMissing ? ' Ainda sem link de afiliado: conecte a Shopee ou tente de novo.' : '';
      return { status: 'ok', postId: draft.postId, message: `Rascunho criado para "${draft.productTitle.slice(0, 70)}". Custo estimado: ${formatUsd(draft.costMicros)}.${link}` };
    } catch (error) {
      if (error instanceof BrainError) return { status: 'error', message: error.message };
      if (error instanceof ClaudeError) return { status: 'error', message: claudeErrorMessage(error.kind, error.detail) };
      throw error;
    }
  } catch { return { status: 'error', message: 'Não foi possível gerar o conteúdo agora. Tente de novo.' }; }
});