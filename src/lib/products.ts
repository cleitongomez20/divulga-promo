import type { Json } from '@/integrations/supabase/types';

/** Search fields asked from productOfferV2. Fields marked "(New)" in the Shopee docs may be missing, so the sender drops what Shopee rejects. */
export const PRODUCT_FIELDS = 'itemId productName imageUrl shopId shopName shopType commissionRate sellerCommissionRate shopeeCommissionRate commission sales priceMin priceMax priceDiscountRate ratingStar productCatIds productLink offerLink periodStartTime periodEndTime';
const ESSENTIAL_FIELDS = new Set(['nodes', 'pageInfo', 'itemId', 'productName', 'productLink', 'hasNextPage', 'page', 'limit']);

export const PAGE_SIZE = 20;
export const MAX_SEARCH_PAGES = 5;
// sortType 1 (relevance) only works together with a keyword.
export const SORTS = [
  { value: 2, label: 'Mais vendidos' },
  { value: 5, label: 'Maior comissão' },
  { value: 4, label: 'Menor preço' },
  { value: 3, label: 'Maior preço' },
  { value: 1, label: 'Mais relevantes (com palavra-chave)' },
] as const;

export type ProductSearch = { keyword?: string | undefined; sortType: number; page: number; limit: number; productCatId?: number | undefined };

export function cleanKeyword(value?: string) {
  return (value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function fieldsWithout(omit: readonly string[]) {
  let fields = PRODUCT_FIELDS;
  for (const name of omit) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || ESSENTIAL_FIELDS.has(name)) continue;
    fields = fields.replace(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])\\s*`, 'g'), '');
  }
  return fields.trim();
}

export function buildProductQuery(search: ProductSearch, omit: readonly string[] = []) {
  const keyword = cleanKeyword(search.keyword);
  const sortType = search.sortType === 1 && !keyword ? 2 : search.sortType;
  const args = [`page: ${Math.max(1, Math.floor(search.page))}`, `limit: ${Math.max(1, Math.min(50, Math.floor(search.limit)))}`, `sortType: ${Math.floor(sortType)}`];
  // JSON.stringify gives a valid, fully escaped GraphQL string, so typed text can never alter the query.
  if (keyword) args.unshift(`keyword: ${JSON.stringify(keyword)}`);
  if (search.productCatId) args.push(`productCatId: ${Math.floor(search.productCatId)}`);
  return `{ productOfferV2(${args.join(', ')}) { nodes { ${fieldsWithout(omit)} } pageInfo { page limit hasNextPage } } }`;
}

/** Reads the Shopee "Cannot query field" error and returns the field that can be dropped, or null. */
export function unknownProductField(message: string): string | null {
  const match = /Cannot query field "([A-Za-z][A-Za-z0-9_]*)"/.exec(message);
  return match && !ESSENTIAL_FIELDS.has(match[1] as string) ? (match[1] as string) : null;
}

export type ProductItem = {
  itemId: string; name: string; imageUrl: string | null; shopName: string | null; shopId: string | null;
  ratingStar: number | null; sales: number | null; commissionRate: number | null; commissionAmount: number | null;
  priceMin: number | null; priceMax: number | null; discountPct: number | null;
  productLink: string; offerLink: string | null; categoryIds: number[]; shopTypes: number[];
};

const asNumber = (value: unknown) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const asText = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const asIdText = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : typeof value === 'string' && /^\d{1,20}$/.test(value.trim()) ? value.trim() : null);
const asNumbers = (value: unknown) => (Array.isArray(value) ? value.map(asNumber).filter((n): n is number => n !== null) : []);

/** Only plain web links are kept: the text comes from outside and is placed in href/src attributes. */
export function safeUrl(value: unknown): string | null {
  const text = asText(value);
  if (!text || text.length > 600) return null;
  try { const url = new URL(text); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null; } catch { return null; }
}

export function normalizeProducts(nodes: unknown): ProductItem[] {
  if (!Array.isArray(nodes)) return [];
  const items: ProductItem[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const itemId = asIdText(n['itemId']); const name = asText(n['productName']); const productLink = safeUrl(n['productLink']);
    if (!itemId || !name || !productLink) continue;
    const priceMin = asNumber(n['priceMin']); const priceMax = asNumber(n['priceMax']);
    items.push({
      itemId, name: name.slice(0, 300), imageUrl: safeUrl(n['imageUrl']), shopName: asText(n['shopName'])?.slice(0, 120) ?? null, shopId: asIdText(n['shopId']),
      ratingStar: asNumber(n['ratingStar']), sales: asNumber(n['sales']), commissionRate: asNumber(n['commissionRate']), commissionAmount: asNumber(n['commission']),
      priceMin, priceMax: priceMax ?? priceMin, discountPct: asNumber(n['priceDiscountRate']),
      productLink, offerLink: safeUrl(n['offerLink']), categoryIds: asNumbers(n['productCatIds']), shopTypes: asNumbers(n['shopType']),
    });
  }
  return items;
}

/** Orders products here, on the screen. Shopee does not sort its default recommended list (only searches by keyword or category),
 *  so this keeps the chosen order working for whatever is loaded. Products without the value always go last. */
export function sortProducts(items: readonly ProductItem[], sortType: number): ProductItem[] {
  const compare = (a: number | null, b: number | null, direction: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * direction;
  };
  const copy = [...items];
  switch (sortType) {
    case 2: return copy.sort((a, b) => compare(a.sales, b.sales, -1));
    case 5: return copy.sort((a, b) => compare(a.commissionRate, b.commissionRate, -1));
    case 4: return copy.sort((a, b) => compare(a.priceMin, b.priceMin, 1));
    case 3: return copy.sort((a, b) => compare(a.priceMin, b.priceMin, -1));
    default: return copy; // relevance: keep Shopee's order
  }
}

/** Row for the products table. Prices are only the value seen when collected, never a value to publish. */
export function toProductRow(item: ProductItem, userId: string, collectedAt: string) {
  return {
    user_id: userId, marketplace: 'shopee', external_id: item.itemId, title: item.name, price: item.priceMin, commission: item.commissionRate,
    sales: item.sales === null ? null : Math.round(item.sales), rating: item.ratingStar, category: item.categoryIds.filter(id => id > 0).join('>') || null,
    images: (item.imageUrl ? [item.imageUrl] : []) as Json, url: item.productLink, collected_at: collectedAt,
  };
}

/** Sub IDs: only letters and numbers (how Shopee joins them is not documented), at most 12 characters, at most 5 of them. */
export const encodeSubId = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || '0';
export const encodeSubIds = (values: readonly string[]) => values.slice(0, 5).map(encodeSubId);

/** Only Shopee addresses can be turned into affiliate links; this tool is not a generic link generator. */
export function isShopeeUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const ours = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    return url.protocol === 'https:' && (ours('shopee.com.br') || ours('shope.ee'));
  } catch { return false; }
}

export function buildShortLinkMutation(originUrl: string, subIds: readonly string[]) {
  return `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: [${subIds.map(id => JSON.stringify(id)).join(', ')}] }) { shortLink } }`;
}

export const formatMoney = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
export const formatPercent = (rate: number) => `${(rate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
export function priceText(item: Pick<ProductItem, 'priceMin' | 'priceMax'>) {
  if (item.priceMin === null) return 'Preço indisponível';
  return item.priceMax !== null && item.priceMax > item.priceMin ? `${formatMoney(item.priceMin)} a ${formatMoney(item.priceMax)}` : formatMoney(item.priceMin);
}

/** Example products shown while no Shopee credentials are saved. */
export function simulatedProducts(keyword: string | undefined, sortType: number): ProductItem[] {
  const base = (id: number, name: string, shop: string, rate: number, price: number, sales: number, rating: number): ProductItem => ({
    itemId: String(9_000_000_000 + id), name, imageUrl: null, shopName: shop, shopId: String(100 + id), ratingStar: rating, sales, commissionRate: rate, commissionAmount: Math.round(price * rate * 100) / 100,
    priceMin: price, priceMax: price, discountPct: 10, productLink: `https://shopee.com.br/product/100/${9_000_000_000 + id}`, offerLink: null, categoryIds: [100001], shopTypes: [],
  });
  const all = [
    base(1, 'Organizador de gaveta modular (exemplo)', 'Casa Prática', 0.12, 29.9, 5400, 4.8), base(2, 'Jogo de potes herméticos 10 peças (exemplo)', 'Cozinha Fácil', 0.15, 59.9, 3200, 4.7),
    base(3, 'Escorredor de louça dobrável (exemplo)', 'Lar & Cia', 0.1, 39.9, 8100, 4.6), base(4, 'Kit de panos de microfibra (exemplo)', 'Limpeza Já', 0.2, 19.9, 12000, 4.9),
    base(5, 'Luminária de mesa recarregável (exemplo)', 'Casa Prática', 0.08, 79.9, 900, 4.5), base(6, 'Tapete antiderrapante para banheiro (exemplo)', 'Lar & Cia', 0.18, 24.9, 4300, 4.4),
  ];
  const text = cleanKeyword(keyword).toLowerCase();
  const found = text ? all.filter(item => item.name.toLowerCase().includes(text)) : all;
  const by = (pick: (item: ProductItem) => number, direction: 1 | -1) => [...found].sort((a, b) => (pick(a) - pick(b)) * direction);
  if (sortType === 5) return by(item => item.commissionRate ?? 0, -1);
  if (sortType === 4) return by(item => item.priceMin ?? 0, 1);
  if (sortType === 3) return by(item => item.priceMin ?? 0, -1);
  return by(item => item.sales ?? 0, -1);
}