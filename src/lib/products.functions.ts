import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import {
  PAGE_SIZE, MAX_SEARCH_PAGES, buildProductQuery, buildShortLinkMutation, cleanKeyword, encodeSubIds, isShopeeUrl,
  normalizeProducts, safeUrl, simulatedProducts, toProductRow, unknownProductField, type ProductItem,
} from './products';

export type SearchResult =
  | { status: 'ok'; items: ProductItem[]; page: number; hasNextPage: boolean; simulated: boolean }
  | { status: 'wait'; message: string; waitSeconds?: number }
  | { status: 'error'; message: string };
export type LinkResult = { status: 'ok'; shortLink: string; simulated?: boolean } | { status: 'error'; message: string };

async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }

const searchSchema = z.object({
  keyword: z.string().max(100).optional(),
  productCatId: z.number().int().positive().optional(),
  sortType: z.number().int().min(1).max(5),
  page: z.number().int().min(1).max(MAX_SEARCH_PAGES),
});

/** Searches Shopee products. Without credentials, returns the simulated list and says so. */
export const searchProducts = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => searchSchema.parse(input)).handler(async ({ context, data }): Promise<SearchResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      const { openConnector } = await import('./shopee-sync.server');
      const connector = await openConnector(db, userId);
      const keyword = cleanKeyword(data.keyword);
      if (!connector) {
        const items = simulatedProducts(keyword || undefined, data.sortType);
        return { status: 'ok', items, page: 1, hasNextPage: false, simulated: true };
      }
      const omit: string[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await connector.execute({ query: buildProductQuery({ keyword: keyword || undefined, productCatId: data.productCatId, sortType: data.sortType, page: data.page, limit: PAGE_SIZE }, omit) });
        if (!result.ok) {
          const unknown = result.errors.map(error => unknownProductField(error.message)).find((name): name is string => !!name);
          if (unknown && !omit.includes(unknown)) { omit.push(unknown); continue; }
          if (result.retryable) return { status: 'wait', message: 'A Shopee pediu uma pausa. Vamos tentar de novo em instantes.', waitSeconds: 3 };
          return { status: 'error', message: result.message };
        }
        const report = result.data['productOfferV2'] as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | null | undefined;
        const items = normalizeProducts(report?.nodes);
        const hasNextPage = report?.pageInfo?.hasNextPage === true && data.page < MAX_SEARCH_PAGES;
        if (items.length) {
          const collectedAt = new Date().toISOString();
          await db.from('products').upsert(items.map(item => toProductRow(item, userId, collectedAt)), { onConflict: 'user_id,marketplace,external_id' });
        }
        return { status: 'ok', items, page: data.page, hasNextPage, simulated: false };
      }
      return { status: 'error', message: 'A Shopee não respondeu como esperado. Tente de novo em instantes.' };
    } catch { return { status: 'error', message: 'Não foi possível buscar produtos agora. Tente de novo em instantes.' }; }
  });

/** Generates a tracked short link for one product, marked as a test link. */
export const createTestLink = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ productLink: z.string().max(600), itemId: z.string().max(40) }).parse(input)).handler(async ({ context, data }): Promise<LinkResult> => {
    const db = await admin(); const userId = context.userId;
    try {
      if (!isShopeeUrl(data.productLink)) return { status: 'error', message: 'Esse endereço não é da Shopee.' };
      const { openConnector } = await import('./shopee-sync.server');
      const connector = await openConnector(db, userId);
      if (!connector) return { status: 'ok', shortLink: `https://shope.ee/teste-${encodeSubIds([data.itemId])[0]}`, simulated: true };
      const result = await connector.execute({ query: buildShortLinkMutation(data.productLink, encodeSubIds(['teste', 'painel', data.itemId])) });
      if (!result.ok) return { status: 'error', message: result.message };
      const shortLink = safeUrl((result.data['generateShortLink'] as { shortLink?: unknown } | null | undefined)?.shortLink);
      if (!shortLink || !isShopeeUrl(shortLink)) return { status: 'error', message: 'A Shopee não devolveu um link válido. Tente de novo.' };
      await db.from('activity_log').insert({ user_id: userId, action: 'Link de teste gerado', result: 'Link curto criado na Shopee', details: { item_id: data.itemId } });
      return { status: 'ok', shortLink };
    } catch { return { status: 'error', message: 'Não foi possível gerar o link agora. Tente de novo.' }; }
  });
