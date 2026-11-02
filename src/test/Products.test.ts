import { describe, it, expect } from 'vitest';
import { parse } from 'graphql';
import { ShopeeConnector } from '@/lib/shopee.server';
import {
  PRODUCT_FIELDS, buildProductQuery, cleanKeyword, unknownProductField, normalizeProducts, toProductRow, encodeSubIds, encodeSubId,
  isShopeeUrl, buildShortLinkMutation, safeUrl, priceText, formatPercent, simulatedProducts,
} from '@/lib/products';

const base = { sortType: 2, page: 1, limit: 20 };
const node = (extra: Record<string, unknown> = {}) => ({
  itemId: '17979995178', productName: 'Organizador de gaveta', imageUrl: 'https://cf.shopee.com.br/file/abc', shopId: '84499012', shopName: 'Casa Prática',
  commissionRate: '0.12', commission: '3.59', sales: 5400, priceMin: '29.9', priceMax: '39.9', priceDiscountRate: 10, ratingStar: '4.8',
  productCatIds: [100012, 100068, 0], productLink: 'https://shopee.com.br/product/84499012/17979995178', offerLink: 'https://shope.ee/abc', shopType: [1], ...extra,
});

describe('product search query', () => {
  it('is valid GraphQL and asks only for documented fields', () => {
    const query = buildProductQuery({ ...base, keyword: 'copo', productCatId: 100001 });
    expect(() => parse(query)).not.toThrow();
    expect(query).toContain('keyword: "copo"');
    expect(query).toContain('productCatId: 100001');
    for (const obsolete of ['appExistRate', 'appNewRate', 'webExistRate', 'webNewRate', ' price ']) expect(query).not.toContain(obsolete);
    expect(PRODUCT_FIELDS).toContain('commissionRate');
  });
  it('never lets typed text change the query', () => {
    const query = buildProductQuery({ ...base, keyword: 'copo" } } mutation { x\n' });
    expect(() => parse(query)).not.toThrow();
    expect(parse(query).definitions).toHaveLength(1);
    expect(cleanKeyword('  a\n\tb   c  ')).toBe('a b c');
    expect(cleanKeyword('x'.repeat(300))).toHaveLength(100);
  });
  it('falls back to best sellers when relevance is chosen without a keyword', () => {
    expect(buildProductQuery({ ...base, sortType: 1 })).toContain('sortType: 2');
    expect(buildProductQuery({ ...base, sortType: 1, keyword: 'copo' })).toContain('sortType: 1');
  });
  it('can leave out fields Shopee rejects, but never the essential ones', () => {
    const query = buildProductQuery(base, ['commission', 'sellerCommissionRate', 'itemId']);
    expect(query).not.toMatch(/\bcommission\b/);
    expect(query).not.toContain('sellerCommissionRate');
    expect(query).toContain('commissionRate');
    expect(query).toContain('itemId');
    expect(unknownProductField('Cannot query field "priceDiscountRate" on type "ProductOfferV2".')).toBe('priceDiscountRate');
    expect(unknownProductField('Cannot query field "itemId" on type "ProductOfferV2".')).toBeNull();
    expect(unknownProductField('Business Error')).toBeNull();
  });
});

describe('reading the Shopee answer', () => {
  it('turns text numbers into numbers and keeps the useful fields', () => {
    const [item] = normalizeProducts([node()]);
    expect(item).toMatchObject({ itemId: '17979995178', name: 'Organizador de gaveta', commissionRate: 0.12, commissionAmount: 3.59, priceMin: 29.9, priceMax: 39.9, ratingStar: 4.8, sales: 5400, shopName: 'Casa Prática' });
    expect(priceText(item!)).toMatch(/R\$\s?29,90 a R\$\s?39,90/);
    expect(formatPercent(0.12)).toBe('12%');
    expect(formatPercent(0.0825)).toBe('8,25%');
  });
  it('skips broken entries and tolerates missing optional fields', () => {
    const items = normalizeProducts([node({ itemId: null }), node({ productName: '' }), node({ productLink: 'javascript:alert(1)' }), 'lixo', null, node({ commissionRate: undefined, ratingStar: undefined, priceMax: undefined })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ commissionRate: null, ratingStar: null, priceMax: 29.9 });
    expect(normalizeProducts(undefined)).toEqual([]);
  });
  it('only keeps web addresses for links and images', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('https://shopee.com.br/x')).toBe('https://shopee.com.br/x');
    expect(normalizeProducts([node({ imageUrl: 'javascript:x' })])[0]?.imageUrl).toBeNull();
  });
  it('builds the row stored in the products table', () => {
    const row = toProductRow(normalizeProducts([node()])[0]!, 'user-1', '2026-11-01T00:00:00.000Z');
    expect(row).toMatchObject({ user_id: 'user-1', marketplace: 'shopee', external_id: '17979995178', title: 'Organizador de gaveta', price: 29.9, commission: 0.12, sales: 5400, rating: 4.8, category: '100012>100068', url: 'https://shopee.com.br/product/84499012/17979995178' });
    expect(row.images).toEqual(['https://cf.shopee.com.br/file/abc']);
  });
});

describe('affiliate links', () => {
  it('builds valid GraphQL with safely escaped values', () => {
    const mutation = buildShortLinkMutation('https://shopee.com.br/produto?a="x"&b=1', ['teste', 'painel']);
    expect(() => parse(mutation)).not.toThrow();
    expect(mutation).toContain('subIds: ["teste", "painel"]');
    expect(parse(mutation).definitions).toHaveLength(1);
  });
  it('keeps sub IDs to letters and numbers, 12 characters and 5 items', () => {
    expect(encodeSubId('conta-1_ABC.xyz!')).toBe('conta1ABCxyz');
    expect(encodeSubId('')).toBe('0');
    expect(encodeSubId('abcdefghijklmnopqrstuvwxyz')).toHaveLength(12);
    expect(encodeSubIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(encodeSubIds(['teste', '', 'x'])).toEqual(['teste', '0', 'x']);
  });
  it('only accepts Shopee addresses over https', () => {
    expect(isShopeeUrl('https://shopee.com.br/product/1/2')).toBe(true);
    expect(isShopeeUrl('https://s.shopee.com.br/abc')).toBe(true);
    expect(isShopeeUrl('https://shope.ee/abc')).toBe(true);
    expect(isShopeeUrl('http://shopee.com.br/x')).toBe(false);
    expect(isShopeeUrl('https://shopee.com.br.evil.com/x')).toBe(false);
    expect(isShopeeUrl('https://evilshopee.com.br/x')).toBe(false);
    expect(isShopeeUrl('https://example.com/shopee.com.br')).toBe(false);
    expect(isShopeeUrl('not a url')).toBe(false);
  });
});

describe('example products while there are no credentials', () => {
  it('filters by keyword and follows the chosen order', () => {
    expect(simulatedProducts('organizador', 2)).toHaveLength(1);
    expect(simulatedProducts('zzzz', 2)).toHaveLength(0);
    const bySales = simulatedProducts(undefined, 2).map(item => item.sales);
    expect(bySales).toEqual([...bySales].sort((a, b) => (b ?? 0) - (a ?? 0)));
    const byPrice = simulatedProducts(undefined, 4).map(item => item.priceMin);
    expect(byPrice).toEqual([...byPrice].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(simulatedProducts(undefined, 5)[0]?.commissionRate).toBe(0.2);
  });
});

describe('through the Shopee connector', () => {
  const connector = (answers: unknown[]) => {
    const bodies: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(JSON.stringify(answers.shift()), { status: 200 }); }) as unknown as typeof fetch;
    return { bodies, client: new ShopeeConnector({ appId: '123456', secret: 'demo' }, { fetcher, now: () => 1577836800000, acquire: async () => true, slowDown: async () => {}, wait: async () => {} }) };
  };
  it('sends the product search and the link request as signed, valid requests', async () => {
    const { client, bodies } = connector([
      { data: { productOfferV2: { nodes: [node()], pageInfo: { page: 1, limit: 20, hasNextPage: true } } } },
      { data: { generateShortLink: { shortLink: 'https://s.shopee.com.br/abc123' } } },
    ]);
    const search = await client.execute({ query: buildProductQuery({ ...base, keyword: 'copo' }) });
    expect(search.ok).toBe(true);
    if (search.ok) expect(normalizeProducts((search.data['productOfferV2'] as { nodes: unknown }).nodes)).toHaveLength(1);
    const link = await client.execute({ query: buildShortLinkMutation('https://shopee.com.br/product/1/2', encodeSubIds(['teste', 'painel', '2'])) });
    expect(link.ok).toBe(true);
    if (link.ok) expect((link.data['generateShortLink'] as { shortLink: string }).shortLink).toBe('https://s.shopee.com.br/abc123');
    expect(JSON.parse(bodies[1] as string).query).toContain('generateShortLink');
  });
});
