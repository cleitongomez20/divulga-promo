import { describe, it, expect, vi } from 'vitest';
import { authorization, signature, CONNECTION_QUERY, ShopeeConnector, SHOPEE_ENDPOINT, translateError, SimulatedMarketplaceConnector, maskAppId } from '@/lib/shopee.server';
import { credentialsSchema } from '@/lib/connections-schema';
import { encryptCredentials, decryptCredentials } from '@/lib/connector-crypto.server';
const credentials = { appId: '123456', secret: 'demo' };
const OFFICIAL_QUERY = '{\nbrandOffer{\n    nodes{\n        commissionRate\n        offerName\n    }\n}\n}';
const payload = '{"query":"{\\nbrandOffer{\\n    nodes{\\n        commissionRate\\n        offerName\\n    }\\n}\\n}"}';
const expected = 'dc88d72feea70c80c52c3399751a7d34966763f51a7f056aa070a5e9df645412';
function setup(responses: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  const wait = vi.fn(async () => {}); const slowDown = vi.fn(async () => {}); const acquire = vi.fn(async () => true);
  const client = new ShopeeConnector(credentials, { fetcher, now: () => 1577836800000, acquire, slowDown, wait });
  return { client, fetcher, wait, acquire, slowDown };
}
describe('Shopee official signing rules', () => {
  it('matches exact official payload and SHA256 digest', async () => {
    expect(JSON.stringify({ query: OFFICIAL_QUERY })).toBe(payload);
    expect(CONNECTION_QUERY).toContain('productOfferV2(keyword: "copo", limit: 1, page: 1)');
    expect(await signature(credentials, 1577836800, payload)).toBe(expected);
  });
  it('matches official singular Credential Authorization', async () => {
    expect(await authorization(credentials, 1577836800, payload)).toBe(`SHA256 Credential=123456, Timestamp=1577836800, Signature=${expected}`);
  });
  it('sends the signed string unchanged using Unix seconds and server endpoint', async () => {
    const { client, fetcher } = setup([{ data: { brandOffer: { nodes: [] } } }]);
    expect((await client.execute({ query: OFFICIAL_QUERY })).ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SHOPEE_ENDPOINT); expect(init.method).toBe('POST'); expect(init.body).toBe(payload);
    expect(new Headers(init.headers).get('Authorization')).toBe(`SHA256 Credential=123456, Timestamp=1577836800, Signature=${expected}`);
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
  it('preserves optional variables and operationName in the signed request', async () => {
    const { client, fetcher } = setup([{ data: {} }]);
    const request = { query: 'query A { x } query B { y }', operationName: 'A', variables: { count: 2 } };
    await client.execute(request);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(request));
    expect(new Headers(init.headers).get('Authorization')).toBe(await authorization(credentials, 1577836800, String(init.body)));
  });
  it('rejects multiple operations without operationName before sending', async () => {
    const { client, fetcher } = setup([]);
    const result = await client.execute({ query: 'query A { x } query B { y }' });
    expect(result.ok).toBe(false); expect(fetcher).not.toHaveBeenCalled();
    if (!result.ok) expect(result.errors[0]?.extensions.code).toBe(10010);
  });
  it('does not retry malformed responses', async () => {
    const fetcher = vi.fn(async () => new Response('not JSON'));
    const client = new ShopeeConnector(credentials, { fetcher, acquire: async () => true, slowDown: async () => {} });
    expect((await client.testConnection()).ok).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe('Shopee failures and conservative retries', () => {
  it.each([10010, 10020, 11000, 99999])('treats HTTP 200 errors %s as failures without automatic retries', async code => {
    const { client, fetcher } = setup([{ data: {}, errors: [{ message: 'Falha', path: ['brandOffer'], extensions: { code, message: 'Oferta não disponível' } }] }]);
    const result = await client.testConnection();
    expect(result.ok).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    if (!result.ok) { expect(result.retryable).toBe(false); expect(result.invalidCredentials).toBe(code === 10020); expect(result.errors[0]?.extensions.code).toBe(code); }
  });
  it.each([10000, 10030])('retries %s at most three times with increasing waits', async code => {
    const response = { errors: [{ extensions: { code } }] };
    const { client, fetcher, wait, slowDown, acquire } = setup([response, response, response]);
    expect((await client.testConnection()).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(acquire).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[3000], [6000]]); expect(slowDown).toHaveBeenCalledTimes(code === 10030 ? 3 : 0);
  });
  it('does not call Shopee when the durable limiter denies a slot', async () => {
    const fetcher = vi.fn();
    const client = new ShopeeConnector(credentials, { fetcher, acquire: async () => false, slowDown: async () => {} });
    expect((await client.testConnection()).ok).toBe(false); expect(fetcher).not.toHaveBeenCalled();
  });
  it('redacts provider echoes before displaying or auditing errors', async () => {
    const { client } = setup([{ errors: [{ message: 'demo 123456', path: ['demo'], extensions: { code: 11000, message: 'SHA256 Credential=123456, Signature=demo' } }] }]);
    const result = JSON.stringify(await client.testConnection());
    expect(result).not.toContain('demo'); expect(result).not.toContain('123456'); expect(result).not.toContain('Signature=');
  });
  it('shows the returned business message for 11000', () => { expect(translateError(11000, 'Oferta não disponível')).toBe('Oferta não disponível'); });
  it('keeps a separate simulated connector', async () => { expect(await new SimulatedMarketplaceConnector().testConnection()).toEqual({ ok: true }); });
});
describe('Encrypted credentials', () => {
  it('roundtrips encrypted owner credentials, not plaintext', async () => {
    const encrypted = await encryptCredentials(credentials, 'test-key-only', 'owner');
    expect(encrypted).not.toContain('demo'); expect(encrypted).not.toContain('123456');
    expect(await decryptCredentials(encrypted, 'test-key-only', 'owner')).toEqual(credentials);
  });
  it('rejects decryption by a different owner', async () => {
    const encrypted = await encryptCredentials(credentials, 'test-key-only', 'owner');
    await expect(decryptCredentials(encrypted, 'test-key-only', 'another-owner')).rejects.toThrow();
  });
});describe('Connection diagnostics', () => {
  it('reports timeouts with a safe reason and no secrets', async () => {
    const fetcher = vi.fn(async () => { throw Object.assign(new Error('timed out demo'), { name: 'TimeoutError' }); });
    const client = new ShopeeConnector(credentials, { fetcher, acquire: async () => true, slowDown: async () => {}, wait: async () => {} });
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.message).toContain('Tempo esgotado'); expect(r.diagnostic).toMatchObject({ stage: 'durante o envio', errorName: 'TimeoutError' }); expect(JSON.stringify(r)).not.toContain('demo'); }
  });
  it('reports HTTP status with a redacted body snippet', async () => {
    const fetcher = vi.fn(async () => new Response('blocked 123456 ' + 'x'.repeat(400), { status: 403 }));
    const client = new ShopeeConnector(credentials, { fetcher, acquire: async () => true, slowDown: async () => {} });
    const r = await client.testConnection();
    if (!r.ok) { expect(r.diagnostic?.httpStatus).toBe(403); expect(r.diagnostic?.bodySnippet?.length).toBeLessThanOrEqual(200); expect(r.diagnostic?.bodySnippet).not.toContain('123456'); }
  });
  it('reports non-JSON responses distinctly', async () => {
    const client = new ShopeeConnector(credentials, { fetcher: vi.fn(async () => new Response('<html>')), acquire: async () => true, slowDown: async () => {} });
    const r = await client.testConnection();
    if (!r.ok) expect(r.message).toContain('não é JSON');
  });
  it('masks the AppId keeping 3 first and 2 last digits', () => { expect(maskAppId('1234567890')).toBe('123•••••90'); });
  it('trims the secret', () => { expect(credentialsSchema.parse({ appId: '1', secret: '  s  ' }).secret).toBe('s'); });
});
