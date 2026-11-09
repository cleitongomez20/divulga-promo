import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import { connectHiggsfieldSchema, estimatedImageMicros, higgsfieldErrorMessage, higgsfieldSettingsSchema, ESTIMATED_IMAGE_USD } from '@/lib/higgsfield';
import {
  HiggsfieldError, checkCredentials, connectHiggsfieldKey, credentialsForJob, errorForStatus, hfCall, loadHiggsfieldStatus, markInvalid, monthMediaSpentMicros, recordMediaUsage, removeHiggsfieldConnection, testStoredHiggsfield,
} from '@/lib/higgsfield.server';
import { openJson } from '@/lib/secret-box.server';

const NOW = Date.parse('2026-11-08T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const KEY_ID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const KEY_SECRET = 'S3cr3t_VALUE-abcdefghijklmnopqrstuvwxyz012345';

describe('input validation', () => {
  it('accepts a key ID and a secret and a monthly cap', () => {
    expect(connectHiggsfieldSchema.safeParse({ keyId: KEY_ID, keySecret: KEY_SECRET, monthlyCapUsd: 10 }).success).toBe(true);
    expect(connectHiggsfieldSchema.safeParse({ keyId: `  ${KEY_ID} `, keySecret: KEY_SECRET, monthlyCapUsd: 10 }).success).toBe(true);
  });
  it('refuses empty, short, spaced or colon-joined values', () => {
    for (const bad of ['', 'curta', 'tem espaço dentro de tudo', `${KEY_ID}:${KEY_SECRET}`, 'aspas"aqui12345', "aspas'aqui12345"]) {
      expect(connectHiggsfieldSchema.safeParse({ keyId: bad, keySecret: KEY_SECRET, monthlyCapUsd: 10 }).success).toBe(false);
      expect(connectHiggsfieldSchema.safeParse({ keyId: KEY_ID, keySecret: bad, monthlyCapUsd: 10 }).success).toBe(false);
    }
  });
  it('checks the monthly cap', () => {
    expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: 0 }).success).toBe(false);
    expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: 20_000 }).success).toBe(false);
    expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: Number.NaN }).success).toBe(false);
    expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: 25.5 }).success).toBe(true);
  });
  it('estimates the cost of images in micro-dollars', () => {
    expect(ESTIMATED_IMAGE_USD).toBe(0.084);
    expect(estimatedImageMicros(1)).toBe(84_000); expect(estimatedImageMicros(6)).toBe(504_000); expect(estimatedImageMicros(0)).toBe(0);
  });
  it('never puts a key in an error message', () => {
    for (const kind of ['auth', 'balance', 'invalid', 'blocked', 'busy', 'unavailable', 'server', 'network', 'timeout', 'cap', 'not_connected'] as const) {
      const text = higgsfieldErrorMessage(kind, 'detalhe');
      expect(text).not.toContain(KEY_SECRET); expect(text).not.toContain(KEY_ID);
    }
  });
});

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
function scripted(reply: (index: number) => { status?: number; json?: unknown; headers?: Record<string, string>; throws?: Error }) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = reply(seen.length - 1);
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200, headers: next.headers ?? {} });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const notFound = () => ({ status: 404, json: { detail: 'Request not found' } });
const credentials = { keyId: KEY_ID, keySecret: KEY_SECRET };

describe('calling Higgsfield', () => {
  it('sends both key values in the Authorization header and the idempotency key', async () => {
    const { fetcher, seen } = scripted(() => ({ json: { status: 'queued' } }));
    const result = await hfCall(fetcher, credentials, { method: 'POST', path: '/x/y', body: { prompt: 'a' }, idempotencyKey: 'abc' });
    expect(result.status).toBe(200);
    expect(seen[0]).toMatchObject({ url: 'https://api.higgsfield.ai/x/y', method: 'POST', body: { prompt: 'a' } });
    expect(seen[0]?.headers).toMatchObject({ authorization: `Key ${KEY_ID}:${KEY_SECRET}`, 'content-type': 'application/json', 'idempotency-key': 'abc' });
  });
  it('reads the Retry-After wait on a busy answer', async () => {
    const { fetcher } = scripted(() => ({ status: 429, json: { detail: 'account_queue_full' }, headers: { 'retry-after': '7' } }));
    expect((await hfCall(fetcher, credentials, { method: 'GET', path: '/a' })).retryAfter).toBe(7);
  });
  it('turns network failures and timeouts into explainable errors', async () => {
    await expect(hfCall(scripted(() => ({ throws: new TypeError('fetch failed') })).fetcher, credentials, { method: 'GET', path: '/a' })).rejects.toMatchObject({ kind: 'network' });
    await expect(hfCall(scripted(() => ({ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) })).fetcher, credentials, { method: 'GET', path: '/a' })).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('maps every status of the Higgsfield error table', () => {
    const kind = (status: number) => errorForStatus(status, 'x', null).kind;
    expect([401, 403, 423, 429, 404, 503, 400, 422, 409, 500, 502].map(kind)).toEqual(['auth', 'balance', 'blocked', 'busy', 'unavailable', 'unavailable', 'invalid', 'invalid', 'invalid', 'server', 'server']);
    expect(errorForStatus(429, '', 9).retryAfterSeconds).toBe(9);
  });
});

describe('checking a key at no cost', () => {
  const check = async (reply: { status?: number; json?: unknown }) => {
    const { fetcher, seen } = scripted(() => reply);
    try { await checkCredentials(fetcher, credentials); return { ok: true as const, seen }; } catch (error) { return { ok: false as const, kind: error instanceof HiggsfieldError ? error.kind : 'other', seen }; }
  };
  it('asks for the status of a request that does not exist, never creating anything', async () => {
    const { seen } = await check(notFound());
    expect(seen).toHaveLength(1); expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toMatch(/^https:\/\/api\.higgsfield\.ai\/requests\/[0-9a-f-]{36}\/status$/);
  });
  it('accepts a key that gets "not found", and refuses one that gets "unauthorized"', async () => {
    expect((await check(notFound())).ok).toBe(true);
    expect(await check({ status: 401, json: { detail: 'Invalid credentials' } })).toMatchObject({ ok: false, kind: 'auth' });
  });
  it('explains other answers', async () => {
    expect(await check({ status: 429 })).toMatchObject({ ok: false, kind: 'busy' });
    expect(await check({ status: 503 })).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(await check({ status: 500 })).toMatchObject({ ok: false, kind: 'server' });
  });
});

const seed = (extra: Record<string, Rows> = {}): Record<string, Rows> => ({ settings: [], connector_secrets: [], media_connections: [], media_usage: [], activity_log: [], ...extra });
const connect = (db: unknown, fetcher: typeof fetch, extra: { capCents?: number; at?: number } = {}) =>
  connectHiggsfieldKey(db as never, { userId: U, masterKey: MASTER, keyId: KEY_ID, keySecret: KEY_SECRET, capCents: extra.capCents ?? 1000, fetcher, now: () => extra.at ?? NOW });
const accepted = () => scripted(notFound).fetcher;

describe('connecting the key', () => {
  it('checks the key, then saves it sealed and creates the connection', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher, seen } = scripted(notFound);
    await connect(db, fetcher);
    expect(seen).toHaveLength(1);
    const secret = tables['connector_secrets']?.[0] as Record<string, string>;
    expect(secret['ciphertext']).not.toContain(KEY_ID); expect(secret['ciphertext']).not.toContain(KEY_SECRET);
    await expect(openJson(secret['ciphertext'] as string, MASTER, U, 'higgsfield')).resolves.toEqual({ keyId: KEY_ID, keySecret: KEY_SECRET });
    await expect(openJson(secret['ciphertext'] as string, MASTER, 'other-user', 'higgsfield')).rejects.toBeDefined();
    await expect(openJson(secret['ciphertext'] as string, MASTER, U, 'claude')).rejects.toBeDefined();
    expect(tables['media_connections']?.[0]).toMatchObject({ user_id: U, provider: 'higgsfield', status: 'connected', monthly_cap_cents: 1000, credential_id: secret['id'], last_error: null });
  });
  it('saves nothing when Higgsfield refuses the key', async () => {
    const { tables, db } = memoryDb(seed());
    await expect(connect(db, scripted(() => ({ status: 401, json: { detail: 'Invalid credentials' } })).fetcher)).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['connector_secrets']).toHaveLength(0); expect(tables['media_connections']).toHaveLength(0);
  });
  it('replaces the old key when a new one is connected', async () => {
    const { tables, db } = memoryDb(seed());
    await connect(db, accepted()); const first = (tables['connector_secrets']?.[0] as Record<string, string>)['id'];
    await connect(db, accepted(), { capCents: 500 });
    expect(tables['connector_secrets']).toHaveLength(1); expect((tables['connector_secrets']?.[0] as Record<string, string>)['id']).not.toBe(first);
    expect(tables['media_connections']).toHaveLength(1); expect(tables['media_connections']?.[0]).toMatchObject({ monthly_cap_cents: 500 });
  });
});

describe('guarding every generation', () => {
  const connected = async (extra: Record<string, Rows> = {}, capCents = 1000) => { const built = memoryDb(seed(extra)); await connect(built.db, accepted(), { capCents }); return built; };
  const job = (db: unknown, estimateMicros: number, at = NOW) => credentialsForJob(db as never, { userId: U, masterKey: MASTER, estimateMicros, now: () => at });
  const usage = (cost: number, at: string, user = U) => ({ id: `u${cost}${at}`, user_id: user, purpose: 'imagem', model: 'm', cost_micros: cost, created_at: at });

  it('opens the key for a job that fits in the cap', async () => {
    const { db } = await connected();
    await expect(job(db, 504_000)).resolves.toEqual({ keyId: KEY_ID, keySecret: KEY_SECRET });
  });
  it('refuses a job that would pass the monthly cap, counting what was already spent', async () => {
    const { tables, db } = await connected({}, 100); // US$ 1.00
    tables['media_usage']!.push(usage(700_000, '2026-11-03T12:00:00.000Z'));
    await expect(job(db, 504_000)).rejects.toMatchObject({ kind: 'cap' });
    await expect(job(db, 300_000)).resolves.toBeDefined();
  });
  it('counts only the current month, and only this user', async () => {
    const { tables, db } = await connected({}, 100);
    tables['media_usage']!.push(usage(9_000_000, '2026-10-20T12:00:00.000Z'), usage(9_000_000, '2026-11-03T12:00:00.000Z', 'someone-else'));
    await expect(job(db, 504_000)).resolves.toBeDefined();
    expect(await monthMediaSpentMicros(db as never, U, NOW)).toBe(0);
  });
  it('records usage and shows it in the status', async () => {
    const { tables, db } = await connected();
    await recordMediaUsage(db as never, U, { purpose: 'imagem', model: 'higgsfield/ads-studio/v1.0', costMicros: 252_000, at: NOW });
    expect(tables['media_usage']?.[0]).toMatchObject({ user_id: U, purpose: 'imagem', model: 'higgsfield/ads-studio/v1.0', cost_micros: 252_000 });
    expect(await loadHiggsfieldStatus(db as never, U, NOW)).toMatchObject({ connected: true, status: 'connected', monthlyCapCents: 1000, spentMicros: 252_000 });
  });
  it('asks to connect when there is no connection', async () => {
    const { db } = memoryDb(seed());
    await expect(job(db, 1)).rejects.toMatchObject({ kind: 'not_connected' });
    expect(await loadHiggsfieldStatus(db as never, U, NOW)).toMatchObject({ connected: false });
  });
  it('stops using a key that was marked invalid', async () => {
    const { tables, db } = await connected();
    await markInvalid(db as never, U);
    expect(tables['media_connections']?.[0]).toMatchObject({ status: 'invalid' });
    await expect(job(db, 1)).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('testing and removing', () => {
  it('a working test brings an invalid connection back, at no cost', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, accepted()); await markInvalid(db as never, U);
    const { fetcher, seen } = scripted(notFound);
    await testStoredHiggsfield(db as never, { userId: U, masterKey: MASTER, fetcher, now: () => NOW });
    expect(seen).toHaveLength(1); expect(seen[0]?.method).toBe('GET');
    expect(tables['media_connections']?.[0]).toMatchObject({ status: 'connected', last_error: null, last_tested_at: new Date(NOW).toISOString() });
    expect(tables['media_usage']).toHaveLength(0);
  });
  it('a refused key is recorded without exposing anything else', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, accepted());
    await expect(testStoredHiggsfield(db as never, { userId: U, masterKey: MASTER, fetcher: scripted(() => ({ status: 401 })).fetcher, now: () => NOW })).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['media_connections']?.[0]).toMatchObject({ status: 'invalid' });
    expect(String((tables['media_connections']?.[0] as Record<string, unknown>)['last_error'])).toMatch(/recusou a chave/);
  });
  it('a temporary problem keeps the connection as it was', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, accepted());
    await expect(testStoredHiggsfield(db as never, { userId: U, masterKey: MASTER, fetcher: scripted(() => ({ status: 503 })).fetcher, now: () => NOW })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(tables['media_connections']?.[0]).toMatchObject({ status: 'connected' });
  });
  it('removing the connection also erases the stored key', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, accepted());
    await removeHiggsfieldConnection(db as never, U);
    expect(tables['media_connections']).toHaveLength(0); expect(tables['connector_secrets']).toHaveLength(0);
  });
});