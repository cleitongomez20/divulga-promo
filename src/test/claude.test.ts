import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import { CLAUDE_MODELS, capMicros, centsOfUsd, claudeErrorMessage, claudeKeySchema, claudeSettingsSchema, connectClaudeSchema, estimateCostMicros, formatUsd, monthStartIso } from '@/lib/claude';
import { ClaudeError, ANTHROPIC_VERSION, CLAUDE_URL, askClaude, callClaude, connectClaudeKey, loadClaudeStatus, removeClaudeConnection, testStoredClaude } from '@/lib/claude.server';
import { openJson } from '@/lib/secret-box.server';

const NOW = Date.parse('2026-11-08T15:00:00.000Z');
const KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const MASTER = 'master-key-for-tests';
const U = 'user-1';

describe('cost estimate and limits', () => {
  it('prices a Sonnet call by tokens: 1,000 in and 500 out is 7,000 micro-dollars', () => {
    expect(estimateCostMicros('claude-sonnet-5-5', 1000, 500)).toBe(7000);
    expect(formatUsd(7000)).toBe('US$ 0,0070');
  });
  it('prices Haiku and Opus, and Haiku long prompts at the higher rate', () => {
    expect(estimateCostMicros('claude-haiku-5-5', 10_000, 2000)).toBe(2000); // 1,000 + 1,000
    expect(estimateCostMicros('claude-opus-5-5', 1000, 1000)).toBe(24_000);
    expect(estimateCostMicros('claude-haiku-5-5', 200_000, 0)).toBe(100_000); // 0.50 per million above 100K tokens
  });
  it('prices an unknown model like the most expensive one', () => {
    expect(estimateCostMicros('claude-novo', 1000, 1000)).toBe(estimateCostMicros('claude-opus-5-5', 1000, 1000));
  });
  it('converts the cap from dollars to cents to micro-dollars', () => {
    expect(centsOfUsd(10)).toBe(1000); expect(capMicros(1000)).toBe(10_000_000); expect(centsOfUsd(2.5)).toBe(250);
  });
  it('finds the start of the month in São Paulo', () => {
    expect(monthStartIso(NOW, 'America/Sao_Paulo')).toBe('2026-11-01T03:00:00.000Z');
    expect(monthStartIso(Date.parse('2026-12-01T01:00:00Z'), 'America/Sao_Paulo')).toBe('2026-11-01T03:00:00.000Z');
  });
  it('offers the three models with a recommended default', () => {
    expect(CLAUDE_MODELS.map(model => model.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  });
});

describe('input validation', () => {
  it('accepts a key that starts with sk-ant- and rejects other text', () => {
    expect(claudeKeySchema.safeParse(KEY).success).toBe(true);
    expect(claudeKeySchema.safeParse('sk-proj-abcdefghijklmnopqrstuvwxyz012345').success).toBe(false);
    expect(claudeKeySchema.safeParse('sk-ant-curta').success).toBe(false);
    expect(claudeKeySchema.safeParse(`  ${KEY}  `).success).toBe(true);
  });
  it('checks model and monthly cap', () => {
    expect(connectClaudeSchema.safeParse({ apiKey: KEY, model: 'claude-sonnet-5-5', monthlyCapUsd: 10 }).success).toBe(true);
    expect(connectClaudeSchema.safeParse({ apiKey: KEY, model: 'gpt-4', monthlyCapUsd: 10 }).success).toBe(false);
    expect(claudeSettingsSchema.safeParse({ model: 'claude-haiku-5-5', monthlyCapUsd: 0 }).success).toBe(false);
    expect(claudeSettingsSchema.safeParse({ model: 'claude-haiku-5-5', monthlyCapUsd: 20_000 }).success).toBe(false);
    expect(claudeSettingsSchema.safeParse({ model: 'claude-haiku-5-5', monthlyCapUsd: Number.NaN }).success).toBe(false);
  });
});

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function scriptedClaude(reply: (index: number) => { status?: number; json?: unknown; throws?: Error }) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = reply(seen.length - 1);
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const ok = (text = 'ok', input = 20, output = 3) => ({ json: { type: 'message', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output }, stop_reason: 'end_turn' } });
const apiError = (status: number, type: string, message = 'x') => ({ status, json: { type: 'error', error: { type, message } } });

describe('callClaude', () => {
  it('sends the key as a bearer token with the version header and reads text and usage', async () => {
    const { fetcher, seen } = scriptedClaude(() => ok('Olá', 120, 40));
    const result = await callClaude(fetcher, { apiKey: KEY, model: 'claude-sonnet-5-5', system: 'Você é um redator.', messages: [{ role: 'user', content: 'Oi' }], maxTokens: 500 });
    expect(result).toEqual({ text: 'Olá', inputTokens: 120, outputTokens: 40, stopReason: 'end_turn' });
    expect(seen[0]?.url).toBe(CLAUDE_URL);
    expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' });
    expect(seen[0]?.body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 500, system: 'Você é um redator.', messages: [{ role: 'user', content: 'Oi' }] });
  });
  it('joins several text blocks and ignores the others', async () => {
    const { fetcher } = scriptedClaude(() => ({ json: { content: [{ type: 'text', text: 'A' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'B' }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect((await callClaude(fetcher, { apiKey: KEY, model: 'm', messages: [], maxTokens: 10 })).text).toBe('AB');
  });
  const kindOf = async (reply: ReturnType<typeof apiError> | { throws: Error }) => {
    const { fetcher } = scriptedClaude(() => reply);
    try { await callClaude(fetcher, { apiKey: KEY, model: 'm', messages: [], maxTokens: 10 }); return 'none'; } catch (error) { return error instanceof ClaudeError ? error.kind : 'other'; }
  };
  it('turns every kind of failure into an explainable error', async () => {
    expect(await kindOf(apiError(401, 'authentication_error'))).toBe('auth');
    expect(await kindOf(apiError(403, 'permission_error'))).toBe('permission');
    expect(await kindOf(apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the API'))).toBe('credit');
    expect(await kindOf(apiError(429, 'rate_limit_error'))).toBe('rate_limit');
    expect(await kindOf(apiError(529, 'overloaded_error'))).toBe('overloaded');
    expect(await kindOf(apiError(500, 'api_error'))).toBe('server');
    expect(await kindOf(apiError(400, 'invalid_request_error', 'max_tokens: too large'))).toBe('bad_request');
    expect(await kindOf({ throws: new TypeError('fetch failed') })).toBe('network');
    expect(await kindOf({ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) })).toBe('timeout');
  });
  it('never puts the key in an error message', () => {
    for (const kind of ['auth', 'permission', 'credit', 'rate_limit', 'overloaded', 'network', 'timeout', 'bad_request', 'server', 'cap', 'not_connected'] as const) {
      expect(claudeErrorMessage(kind, 'detalhe')).not.toContain('sk-ant');
    }
  });
});

const seed = (extra: Record<string, Rows> = {}): Record<string, Rows> => ({ settings: [], connector_secrets: [], ai_connections: [], ai_usage: [], activity_log: [], ...extra });
const connect = (db: unknown, fetcher: typeof fetch, extra: { model?: string; capCents?: number; at?: number } = {}) =>
  connectClaudeKey(db as never, { userId: U, masterKey: MASTER, apiKey: KEY, model: extra.model ?? 'claude-sonnet-5-5', capCents: extra.capCents ?? 1000, fetcher, now: () => extra.at ?? NOW });

describe('connecting the key', () => {
  it('tests the key, then saves it sealed and creates the connection', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher, seen } = scriptedClaude(() => ok('ok', 25, 2));
    await connect(db, fetcher);
    expect(seen).toHaveLength(1); expect(seen[0]?.body['max_tokens']).toBe(16);
    const secret = tables['connector_secrets']?.[0] as Record<string, string>;
    expect(secret['ciphertext']).not.toContain('sk-ant'); expect(secret['ciphertext']).not.toContain(KEY);
    await expect(openJson<{ apiKey: string }>(secret['ciphertext'] as string, MASTER, U, 'claude')).resolves.toEqual({ apiKey: KEY });
    await expect(openJson(secret['ciphertext'] as string, MASTER, 'other-user', 'claude')).rejects.toBeDefined();
    expect(tables['ai_connections']?.[0]).toMatchObject({ user_id: U, status: 'connected', model: 'claude-sonnet-5-5', monthly_cap_cents: 1000, credential_id: secret['id'], last_error: null });
    expect(tables['ai_usage']?.[0]).toMatchObject({ purpose: 'teste', model: 'claude-sonnet-5-5', input_tokens: 25, output_tokens: 2, cost_micros: 70 });
  });
  it('saves nothing when Claude refuses the key', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher } = scriptedClaude(() => apiError(401, 'authentication_error'));
    await expect(connect(db, fetcher)).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['connector_secrets']).toHaveLength(0); expect(tables['ai_connections']).toHaveLength(0);
  });
  it('replaces the old key when a new one is connected', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher } = scriptedClaude(() => ok());
    await connect(db, fetcher); const first = (tables['connector_secrets']?.[0] as Record<string, string>)['id'];
    await connect(db, fetcher, { model: 'claude-haiku-5-5', capCents: 500 });
    expect(tables['connector_secrets']).toHaveLength(1);
    expect((tables['connector_secrets']?.[0] as Record<string, string>)['id']).not.toBe(first);
    expect(tables['ai_connections']).toHaveLength(1);
    expect(tables['ai_connections']?.[0]).toMatchObject({ model: 'claude-haiku-5-5', monthly_cap_cents: 500 });
  });
});

describe('askClaude', () => {
  const connected = async (extra: Record<string, Rows> = {}, options: { capCents?: number } = {}) => {
    const built = memoryDb(seed(extra)); await connect(built.db, scriptedClaude(() => ok()).fetcher, { capCents: options.capCents ?? 1000 });
    built.tables['ai_usage']!.length = 0; return built;
  };
  const ask = (db: unknown, fetcher: typeof fetch, at = NOW) => askClaude(db as never, { userId: U, masterKey: MASTER, purpose: 'legenda', system: 'Redator', messages: [{ role: 'user', content: 'Escreva' }], maxTokens: 400, fetcher, now: () => at });

  it('answers, and records the tokens and the estimated cost', async () => {
    const { tables, db } = await connected();
    const { fetcher, seen } = scriptedClaude(() => ok('Legenda pronta', 1000, 500));
    const reply = await ask(db, fetcher);
    expect(reply).toMatchObject({ text: 'Legenda pronta', inputTokens: 1000, outputTokens: 500, costMicros: 7000 });
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(tables['ai_usage']).toHaveLength(1);
    expect(tables['ai_usage']?.[0]).toMatchObject({ user_id: U, purpose: 'legenda', cost_micros: 7000 });
  });
  it('refuses to call Claude once the monthly cap is reached', async () => {
    const { tables, db } = await connected({}, { capCents: 100 }); // US$ 1.00
    tables['ai_usage']!.push({ id: 'u1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 1_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    const { fetcher, seen } = scriptedClaude(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'cap' });
    expect(seen).toHaveLength(0);
  });
  it('counts only the current month toward the cap', async () => {
    const { tables, db } = await connected({}, { capCents: 100 });
    tables['ai_usage']!.push({ id: 'u1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 5_000_000, created_at: '2026-10-20T12:00:00.000Z' });
    const { fetcher } = scriptedClaude(() => ok());
    await expect(ask(db, fetcher)).resolves.toBeDefined();
  });
  it('does not count another user spending', async () => {
    const { tables, db } = await connected({}, { capCents: 100 });
    tables['ai_usage']!.push({ id: 'u1', user_id: 'someone-else', purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 9_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    await expect(ask(db, scriptedClaude(() => ok()).fetcher)).resolves.toBeDefined();
  });
  it('asks to connect when there is no connection', async () => {
    const { db } = memoryDb(seed());
    const { fetcher, seen } = scriptedClaude(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'not_connected' }); expect(seen).toHaveLength(0);
  });
  it('marks the connection invalid when Claude rejects the key, and then stops calling', async () => {
    const { tables, db } = await connected();
    await expect(ask(db, scriptedClaude(() => apiError(401, 'authentication_error')).fetcher)).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['ai_connections']?.[0]).toMatchObject({ status: 'invalid' });
    const { fetcher, seen } = scriptedClaude(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'auth' }); expect(seen).toHaveLength(0);
  });
  it('keeps the connection when the failure is only temporary, and records no cost', async () => {
    const { tables, db } = await connected();
    await expect(ask(db, scriptedClaude(() => apiError(529, 'overloaded_error')).fetcher)).rejects.toMatchObject({ kind: 'overloaded' });
    expect(tables['ai_connections']?.[0]).toMatchObject({ status: 'connected' }); expect(tables['ai_usage']).toHaveLength(0);
  });
});

describe('testing, status and removal', () => {
  it('a working test brings an invalid connection back', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scriptedClaude(() => ok()).fetcher);
    (tables['ai_connections']![0] as Record<string, unknown>)['status'] = 'invalid';
    await testStoredClaude(db as never, { userId: U, masterKey: MASTER, fetcher: scriptedClaude(() => ok()).fetcher, now: () => NOW });
    expect(tables['ai_connections']?.[0]).toMatchObject({ status: 'connected', last_error: null, last_tested_at: new Date(NOW).toISOString() });
  });
  it('a failed test records the reason without exposing anything else', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scriptedClaude(() => ok()).fetcher);
    await expect(testStoredClaude(db as never, { userId: U, masterKey: MASTER, fetcher: scriptedClaude(() => apiError(401, 'authentication_error')).fetcher, now: () => NOW })).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['ai_connections']?.[0]).toMatchObject({ status: 'invalid' });
    expect(String((tables['ai_connections']?.[0] as Record<string, unknown>)['last_error'])).toMatch(/recusou a chave/);
  });
  it('reports the status with the month spending', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scriptedClaude(() => ok('ok', 1_000_000, 0)).fetcher);
    tables['ai_usage']!.push({ id: 'old', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 777, created_at: '2026-09-01T00:00:00.000Z' });
    const status = await loadClaudeStatus(db as never, U, NOW);
    expect(status).toMatchObject({ connected: true, status: 'connected', model: 'claude-sonnet-5-5', monthlyCapCents: 1000, spentMicros: 2_000_000 });
    expect(await loadClaudeStatus(memoryDb(seed()).db as never, U, NOW)).toMatchObject({ connected: false });
  });
  it('removing the connection also erases the stored key', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scriptedClaude(() => ok()).fetcher);
    await removeClaudeConnection(db as never, U);
    expect(tables['ai_connections']).toHaveLength(0); expect(tables['connector_secrets']).toHaveLength(0);
  });
});