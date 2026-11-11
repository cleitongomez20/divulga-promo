import { beforeEach, describe, expect, it, vi } from 'vitest';

// These tests protect the rules of the Produtos screen's server side: the safety pause between Shopee requests, saving what was found
// (the Claude content brain chooses among the saved products), logging, and the clear messages. They exist because this file was
// once rebuilt by the Lovable assistant and lost some of these rules.
const state = vi.hoisted(() => ({
  wait: 0, connector: null as null | { execute: (request: { query: string }) => Promise<unknown> }, openError: null as Error | null, upsertError: null as unknown,
  rpcs: [] as { scope: string; ms: number }[], upserts: [] as { rows: Record<string, unknown>[]; options: unknown }[], logs: [] as Record<string, unknown>[], queries: [] as string[],
}));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  let parse: (input: unknown) => unknown = input => input;
  const builder = {
    middleware: () => builder,
    inputValidator: (validator: (input: unknown) => unknown) => { parse = validator; return builder; },
    handler: (handler: (args: { context: unknown; data: unknown }) => unknown) => (args: { context: unknown; data: unknown }) => handler({ ...args, data: parse(args.data) }),
  };
  return builder;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: {
    rpc: async (_name: string, args: { p_scope: string; p_interval_ms: number }) => { state.rpcs.push({ scope: args.p_scope, ms: args.p_interval_ms }); return { data: state.wait, error: null }; },
    from: () => ({
      upsert: async (rows: Record<string, unknown>[], options: unknown) => { state.upserts.push({ rows, options }); return { error: state.upsertError }; },
      insert: async (row: Record<string, unknown>) => { state.logs.push(row); return { error: null }; },
    }),
  },
}));
vi.mock('@/lib/shopee-sync.server', () => ({ openConnector: async () => { if (state.openError) throw state.openError; return state.connector; } }));

import { createTestLink, searchProducts } from '@/lib/products.functions';

type Result = { status: string; message?: string; waitSeconds?: number; simulated?: boolean; items?: unknown[]; hasNextPage?: boolean; shortLink?: string };
const call = (fn: unknown, data: unknown) => (fn as (args: unknown) => Promise<Result>)({ context: { userId: 'user-1' }, data });
const search = (extra: Record<string, unknown> = {}) => call(searchProducts, { sortType: 2, page: 1, ...extra });

const node = (extra: Record<string, unknown> = {}) => ({
  itemId: '17979995178', productName: 'Organizador de gaveta', imageUrl: 'https://cf.shopee.com.br/file/abc', shopId: '84499012', shopName: 'Casa Prática',
  commissionRate: '0.12', commission: '3.59', sales: 5400, priceMin: '29.9', priceMax: '39.9', priceDiscountRate: 10, ratingStar: '4.8',
  productCatIds: [100012], productLink: 'https://shopee.com.br/product/84499012/17979995178', offerLink: 'https://shope.ee/abc', shopType: [1], ...extra,
});
const found = (nodes: unknown[], hasNextPage = false) => ({ ok: true, data: { productOfferV2: { nodes, pageInfo: { hasNextPage } } } });
const failure = (message: string, extra: Record<string, unknown> = {}) => ({ ok: false, message, retryable: false, invalidCredentials: false, errors: [{ message, path: [], extensions: { code: 10000 } }], ...extra });
const connector = (...answers: unknown[]) => { state.connector = { execute: async request => { state.queries.push(request.query); return answers.shift() ?? found([]); } }; };

beforeEach(() => { state.wait = 0; state.connector = null; state.openError = null; state.upsertError = null; state.rpcs = []; state.upserts = []; state.logs = []; state.queries = []; });

describe('product search', () => {
  it('asks for the safety pause first, 1.5 seconds per user', async () => {
    connector(found([node()]));
    await search();
    expect(state.rpcs[0]).toEqual({ scope: 'shopee-search:user-1', ms: 1500 });
  });
  it('tells the screen to wait, without calling Shopee, when the pause has not passed', async () => {
    state.wait = 1200; connector(found([node()]));
    const result = await search();
    expect(result).toMatchObject({ status: 'wait', waitSeconds: 2 });
    expect(state.queries).toHaveLength(0);
  });
  it('without Shopee credentials, shows example products and saves nothing', async () => {
    const result = await search();
    expect(result).toMatchObject({ status: 'ok', simulated: true, hasNextPage: false }); expect(result.items?.length).toBeGreaterThan(0);
    expect(state.upserts).toHaveLength(0);
  });
  it('saves what it finds for this user, so the content brain can choose among the saved products', async () => {
    connector(found([node(), node({ itemId: '2', productLink: 'https://shopee.com.br/product/1/2' })], true));
    const result = await search();
    expect(result).toMatchObject({ status: 'ok', simulated: false, page: 1, hasNextPage: true }); expect(result.items).toHaveLength(2);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]?.options).toEqual({ onConflict: 'user_id,marketplace,external_id' });
    expect(state.upserts[0]?.rows).toHaveLength(2);
    expect(state.upserts[0]?.rows[0]).toMatchObject({ user_id: 'user-1', marketplace: 'shopee', external_id: '17979995178', title: 'Organizador de gaveta' });
  });
  it('still shows the products, and records the problem, when they cannot be saved', async () => {
    state.upsertError = { message: 'permission denied' }; connector(found([node()]));
    const result = await search();
    expect(result.status).toBe('ok');
    expect(state.logs.some(row => row['action'] === 'Busca de produtos' && /não foi possível salvá-los/.test(String(row['result'])))).toBe(true);
  });
  it('records a failed search with its codes and returns Shopee\'s message', async () => {
    connector(failure('Credenciais inválidas'));
    const result = await search();
    expect(result).toMatchObject({ status: 'error', message: 'Credenciais inválidas' });
    expect(state.logs.some(row => row['action'] === 'Busca de produtos' && row['result'] === 'Credenciais inválidas')).toBe(true);
  });
  it('shows the friendly message of a problem raised by the app itself', async () => {
    state.openError = new Error('Não foi possível ler as credenciais da Shopee. Conecte de novo.');
    expect(await search()).toMatchObject({ status: 'error', message: 'Não foi possível ler as credenciais da Shopee. Conecte de novo.' });
  });
  it('asks the screen to try again when Shopee asked for a pause', async () => {
    connector(failure('A Shopee pediu uma pausa', { retryable: true }));
    expect(await search()).toMatchObject({ status: 'wait', waitSeconds: 3 });
  });
  it('drops fields Shopee does not know and remembers them for the next searches', async () => {
    connector(failure('Cannot query field "priceDiscountRate" on type "ProductOfferV2"'), found([node()]));
    expect((await search()).status).toBe('ok');
    expect(state.queries).toHaveLength(2); expect(state.queries[0]).toContain('priceDiscountRate'); expect(state.queries[1]).not.toContain('priceDiscountRate');
    state.queries = []; connector(found([node()]));
    await search();
    expect(state.queries[0]).not.toContain('priceDiscountRate');
  });
  it('keeps pruning unknown fields up to eight times before giving up', async () => {
    const names = ['f1', 'f2', 'f3', 'f4', 'f5'];
    connector(...names.map(name => failure(`Cannot query field "${name}" on type "ProductOfferV2"`)), found([node()]));
    expect((await search()).status).toBe('ok');
    expect(state.queries).toHaveLength(6);
  });
});

describe('test link', () => {
  const link = (extra: Record<string, unknown> = {}) => call(createTestLink, { productLink: 'https://shopee.com.br/product/84499012/17979995178', itemId: '17979995178', ...extra });
  it('asks for the safety pause first, 3 seconds per user', async () => {
    connector({ ok: true, data: { generateShortLink: { shortLink: 'https://shope.ee/abc' } } });
    await link();
    expect(state.rpcs[0]).toEqual({ scope: 'shopee-link:user-1', ms: 3000 });
  });
  it('tells the screen to wait when the pause has not passed', async () => {
    state.wait = 2000; connector({ ok: true, data: {} });
    expect(await link()).toMatchObject({ status: 'wait', waitSeconds: 2 }); expect(state.queries).toHaveLength(0);
  });
  it('refuses addresses that are not from Shopee, before anything else', async () => {
    connector({ ok: true, data: {} });
    expect(await link({ productLink: 'https://example.com/p' })).toMatchObject({ status: 'error', message: expect.stringMatching(/Shopee/) });
    expect(state.rpcs).toHaveLength(0); expect(state.queries).toHaveLength(0);
  });
  it('creates a link marked as test and records it', async () => {
    connector({ ok: true, data: { generateShortLink: { shortLink: 'https://shope.ee/abc' } } });
    expect(await link()).toEqual({ status: 'ok', shortLink: 'https://shope.ee/abc', simulated: false });
    expect(state.queries[0]).toContain('teste'); expect(state.queries[0]).toContain('painel'); expect(state.queries[0]).toContain('17979995178');
    expect(state.logs.some(row => row['action'] === 'Link de teste' && row['result'] === 'Link de teste gerado')).toBe(true);
  });
  it('without Shopee credentials, returns an example link marked as simulated', async () => {
    expect(await link()).toMatchObject({ status: 'ok', simulated: true });
  });
  it('does not accept a link that is not from Shopee in the answer, and records a failed attempt', async () => {
    connector({ ok: true, data: { generateShortLink: { shortLink: 'https://evil.example.com/x' } } }, failure('Produto indisponível'));
    expect((await link()).status).toBe('error');
    expect(await link()).toMatchObject({ status: 'error', message: 'Produto indisponível' });
    expect(state.logs.some(row => row['action'] === 'Link de teste' && row['result'] === 'Produto indisponível')).toBe(true);
  });
});
