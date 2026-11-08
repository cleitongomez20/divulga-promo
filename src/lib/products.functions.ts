import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import type { Json } from '@/integrations/supabase/types';
import {
  MAX_SEARCH_PAGES,
  PAGE_SIZE,
  buildProductQuery,
  buildShortLinkMutation,
  cleanKeyword,
  encodeSubIds,
  isShopeeUrl,
  normalizeProducts,
  safeUrl,
  simulatedProducts,
  toProductRow,
  unknownProductField,
  type ProductItem
} from './products';

const MAX_FIELD_PRUNES = 8;
/** Fields Shopee said do not exist. Remembered while this server instance lives so later searches skip them. */
const rejectedFields = new Set<string>();

export type SearchResult =
  { status: 'ok'; items: ProductItem[]; page: number; hasNextPage: boolean; simulated: boolean } | { status: 'wait' | 'error'; message: string; waitSeconds?: number };
export type LinkResult = { status: 'ok'; shortLink: string; simulated: boolean } | { status: 'wait' | 'error'; message: string; waitSeconds?: number };

const searchSchema = z.object({
  keyword: z.string().max(200).optional(),
  sortType: z.number().int().min(1).max(5).default(2),
  page: z.number().int().min(1).max(MAX_SEARCH_PAGES).default(1),
  productCatId: z.number().int().positive().max(2_000_000_000).optional()
});
const linkSchema = z.object({
  productLink: z.string().url().max(600),
  itemId: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional()
});

type Admin = (typeof import('@/integrations/supabase/client.server'))['supabaseAdmin'];
/** Spacing between calls for one user. Returns how many seconds to wait, or 0 when the call may go ahead. */
async function pauseSeconds(admin: Admin, scope: string, intervalMs: number) {
  const { data, error } = await admin.rpc('reserve_connector_slot', { p_scope: scope, p_interval_ms: intervalMs });
  if (error) throw new Error('Não foi possível aplicar a pausa de segurança.');
  return data === 0 ? 0 : Math.max(1, Math.ceil((data ?? 3000) / 1000));
}
const log = (admin: Admin, userId: string, action: string, result: string, details: Record<string, unknown> = {}) =>
  admin.from('activity_log').insert({ user_id: userId, action, result, details: details as Json });

export const searchProducts = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(input => searchSchema.parse(input ?? {}))
  .handler(async ({ context, data }): Promise<SearchResult> => {
    const { supabaseAdmin: admin } = await import('@/integrations/supabase/client.server');
    const { openConnector } = await import('./shopee-sync.server');
    const userId = context.userId;
    try {
      const wait = await pauseSeconds(admin, `shopee-search:${userId}`, 1500);
      if (wait > 0) return { status: 'wait', message: 'Aguarde alguns segundos antes de buscar de novo.', waitSeconds: wait };
      const connector = await openConnector(admin, userId);
      const search = { keyword: cleanKeyword(data.keyword), sortType: data.sortType, page: data.page, limit: PAGE_SIZE, productCatId: data.productCatId };
      if (!connector) return { status: 'ok', items: simulatedProducts(search.keyword, search.sortType), page: 1, hasNextPage: false, simulated: true };

      const omit = new Set(rejectedFields);
      let prunes = 0;
      for (;;) {
        const result = await connector.execute({ query: buildProductQuery(search, [...omit]) });
        if (!result.ok) {
          const unknown = result.errors.map(e => unknownProductField(e.message)).find((name): name is string => !!name);
          if (unknown && !omit.has(unknown) && prunes < MAX_FIELD_PRUNES) {
            omit.add(unknown);
            rejectedFields.add(unknown);
            prunes++;
            continue;
          }
          // The marketplace asked for a pause (rate limit): the screen waits a few seconds and tries again by itself.
          if (result.retryable) return { status: 'wait', message: 'A Shopee pediu uma pausa. Vamos tentar de novo em instantes.', waitSeconds: 3 };
          await log(admin, userId, 'Busca de produtos', result.message, {
            codes: result.errors.map(e => e.extensions.code),
            errors: result.errors.map(e => ({ code: e.extensions.code, message: e.message })),
            omitted_fields: [...omit]
          });
          return { status: 'error', message: result.message };
        }
        const report = result.data['productOfferV2'] as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | null | undefined;
        const items = normalizeProducts(report?.nodes);
        const now = new Date().toISOString();
        if (items.length) {
          const { error } = await admin.from('products').upsert(
            items.map(item => toProductRow(item, userId, now)),
            { onConflict: 'user_id,marketplace,external_id' }
          );
          if (error) await log(admin, userId, 'Busca de produtos', 'Os produtos foram encontrados, mas não foi possível salvá-los.', {});
        }
        return { status: 'ok', items, page: data.page, hasNextPage: report?.pageInfo?.hasNextPage === true && data.page < MAX_SEARCH_PAGES, simulated: false };
      }
    } catch (error) {
      return { status: 'error', message: error instanceof Error && error.message ? error.message : 'Não foi possível buscar produtos agora.' };
    }
  });

export const createTestLink = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(input => linkSchema.parse(input))
  .handler(async ({ context, data }): Promise<LinkResult> => {
    const { supabaseAdmin: admin } = await import('@/integrations/supabase/client.server');
    const { openConnector } = await import('./shopee-sync.server');
    const userId = context.userId;
    if (!isShopeeUrl(data.productLink)) return { status: 'error', message: 'Só é possível gerar links para produtos da Shopee.' };
    try {
      const wait = await pauseSeconds(admin, `shopee-link:${userId}`, 3000);
      if (wait > 0) return { status: 'wait', message: 'Aguarde alguns segundos antes de gerar outro link.', waitSeconds: wait };
      const connector = await openConnector(admin, userId);
      if (!connector) return { status: 'ok', shortLink: 'https://shope.ee/exemplo-simulado', simulated: true };
      // Test links carry recognisable sub IDs, so a sale from one of them is easy to spot in the sales list.
      const subIds = encodeSubIds(['teste', 'painel', data.itemId ?? '']);
      const result = await connector.execute({ query: buildShortLinkMutation(data.productLink, subIds) });
      if (!result.ok) {
        await log(admin, userId, 'Link de teste', result.message, { codes: result.errors.map(e => e.extensions.code) });
        return { status: 'error', message: result.message };
      }
      const shortLink = safeUrl((result.data['generateShortLink'] as { shortLink?: unknown } | null | undefined)?.shortLink);
      if (!shortLink || !isShopeeUrl(shortLink)) return { status: 'error', message: 'A Shopee não devolveu um link válido. Tente de novo.' };
      await log(admin, userId, 'Link de teste', 'Link de teste gerado', { item_id: data.itemId ?? null });
      return { status: 'ok', shortLink, simulated: false };
    } catch (error) {
      return { status: 'error', message: error instanceof Error && error.message ? error.message : 'Não foi possível gerar o link agora.' };
    }
  });
