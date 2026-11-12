// Server-only: turns a Shopee product address into a tracked affiliate link, with the same safety pause between requests as the Produtos screen.
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildShortLinkMutation, isShopeeUrl, safeUrl } from './products';
import { openConnector } from './shopee-sync.server';

export type MakeLink = (productUrl: string, subIds: string[]) => Promise<string | null>;

export function makeLinkFor(admin: Parameters<typeof openConnector>[0], db: SupabaseClient, userId: string): MakeLink {
  return async (productUrl, subIds) => {
    const connector = await openConnector(admin, userId);
    if (!connector) return null;
    // Same safety pause between link requests as the Produtos screen (3 seconds per user).
    const { data: wait } = await db.rpc('reserve_connector_slot', { p_scope: `shopee-link:${userId}`, p_interval_ms: 3000 });
    if (typeof wait === 'number' && wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 4000)));
    const result = await connector.execute({ query: buildShortLinkMutation(productUrl, subIds) });
    if (!result.ok) return null;
    const link = safeUrl((result.data['generateShortLink'] as { shortLink?: unknown } | null | undefined)?.shortLink);
    return link && isShopeeUrl(link) ? link : null;
  };
}