import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import {
  OPENAI_MODELS, REASONING_HEADROOM_TOKENS, connectOpenAiSchema, estimateOpenAiCostMicros, openAiErrorMessage, openAiKeySchema, openAiSettingsSchema,
} from '@/lib/openai';
import { OPENAI_URL, OpenAiError, askOpenAi, callOpenAi, connectOpenAiKey, loadOpenAiStatus, removeOpenAiConnection, testStoredOpenAi } from '@/lib/openai.server';
import { ClaudeError } from '@/lib/claude.server';
import { activeProviderOf, activeProviderReady, aiErrorMessage, askAi, switchProvider } from '@/lib/ai.server';
import { openJson } from '@/lib/secret-box.server';

const NOW = Date.parse('2026-11-12T15:00:00.000Z');
const KEY = 'sk-proj-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const CLAUDE_KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const MASTER = 'master-key-for-tests';
const U = 'user-1';

describe('OpenAI cost estimate', () => {
  it('prices Terra by tokens: 1,000 in and 500 out is 3,500 micro-dollars', () => {
    expect(estimateOpenAiCostMicros('gpt-6.1-terra', 1000, 500)).toBe(3500);
  });
  it('prices Luna and Sol', () => {
    expect(estimateOpenAiCostMicros('gpt-6-luna', 10_000, 2000)).toBe(2000); // 1,000 + 1,000
    expect(estimateOpenAiCostMicros('gpt-6.1-sol', 1000, 1000)).toBe(12_000);
  });
  it('doubles input and raises output 1.5 times above 272,000 input tokens', () => {
    expect(estimateOpenAiCostMicros('gpt-6.1-terra', 300_000, 1000)).toBe(300_000 * 2 + 1000 * 7.5);
  });
  it('prices an unknown model like the most expensive one', () => {
    expect(estimateOpenAiCostMicros('modelo-novo', 1000, 1000)).toBe(estimateOpenAiCostMicros('gpt-6.1-sol', 1000, 1000));
  });
  it('offers three models, from the cheapest to the most capable', () => {
    expect(OPENAI_MODELS.map(model => model.id)).toEqual(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol']);
  });
});

describe('OpenAI input validation', () => {
  it('accepts a key that starts with sk- and rejects other text', () => {
    expect(openAiKeySchema.safeParse(KEY).success).toBe(true);
    expect(openAiKeySchema.safeParse(`  ${KEY}  `).success).toBe(true);
    expect(openAiKeySchema.safeParse('sk-curta').success).toBe(false);
    expect(openAiKeySchema.safeParse('abc'.repeat(15)).success).toBe(false);
  });
  it('explains that a Claude key does not belong here', () => {
    const result = openAiKeySchema.safeParse(CLAUDE_KEY);
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]?.message).toMatch(/chave do Claude/);
  });
  it('the cap is optional: empty (null) means no limit, a number must be between 1 and 10,000', () => {
    expect(connectOpenAiSchema.safeParse({ apiKey: KEY, model: 'gpt-6.1-terra', monthlyCapUsd: null }).success).toBe(true);
    expect(connectOpenAiSchema.safeParse({ apiKey: KEY, model: 'gpt-6.1-terra', monthlyCapUsd: 10 }).success).toBe(true);
    expect(openAiSettingsSchema.safeParse({ model: 'gpt-6-luna', monthlyCapUsd: 0 }).success).toBe(false);
    expect(openAiSettingsSchema.safeParse({ model: 'gpt-6-luna', monthlyCapUsd: 20_000 }).success).toBe(false);
    expect(openAiSettingsSchema.safeParse({ model: 'gpt-6-luna', monthlyCapUsd: Number.NaN }).success).toBe(false);
    expect(openAiSettingsSchema.safeParse({ model: 'claude-sonnet-5-5', monthlyCapUsd: null }).success).toBe(false);
  });
});

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function scripted(reply: (index: number) => { status?: number; json?: unknown; throws?: Error }) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = reply(seen.length - 1);
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const ok = (text = 'ok', input = 20, output = 3) => ({
  json: { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: input, output_tokens: output } },
});
const apiError = (status: number, code: string, message = 'x', type = 'invalid_request_error') => ({ status, json: { error: { message, type, code } } });

describe('callOpenAi', () => {
  it('sends the key as a bearer token to the Responses API and reads text and usage', async () => {
    const { fetcher, seen } = scripted(() => ok('Olá', 120, 40));
    const result = await callOpenAi(fetcher, { apiKey: KEY, model: 'gpt-6.1-terra', system: 'Você é um redator.', messages: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'Escreva' }], maxTokens: 500 });
    expect(result).toEqual({ text: 'Olá', inputTokens: 120, outputTokens: 40, stopReason: 'completed' });
    expect(seen[0]?.url).toBe(OPENAI_URL);
    expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(seen[0]?.body).toEqual({
      model: 'gpt-6.1-terra', instructions: 'Você é um redator.', max_output_tokens: 500 + REASONING_HEADROOM_TOKENS, reasoning: { effort: 'low' }, store: false,
      input: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'Escreva' }],
    });
  });
  it('joins several text parts and ignores reasoning items and other parts', async () => {
    const { fetcher } = scripted(() => ({ json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'A' }, { type: 'refusal', refusal: 'x' }, { type: 'output_text', text: 'B' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    expect((await callOpenAi(fetcher, { apiKey: KEY, model: 'm', messages: [], maxTokens: 10 })).text).toBe('AB');
  });
  it('reports an answer cut short by the output limit', async () => {
    const { fetcher } = scripted(() => ({ json: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 5, output_tokens: 99 } } }));
    expect(await callOpenAi(fetcher, { apiKey: KEY, model: 'm', messages: [], maxTokens: 10 })).toMatchObject({ text: '', stopReason: 'max_output_tokens' });
  });
  const kindOf = async (reply: ReturnType<typeof apiError> | { throws: Error }) => {
    const { fetcher } = scripted(() => reply);
    try { await callOpenAi(fetcher, { apiKey: KEY, model: 'm', messages: [], maxTokens: 10 }); return 'none'; } catch (error) { return error instanceof OpenAiError ? error.kind : 'other'; }
  };
  it('turns every kind of failure into an explainable error', async () => {
    expect(await kindOf(apiError(401, 'invalid_api_key'))).toBe('auth');
    expect(await kindOf(apiError(429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.'))).toBe('quota');
    expect(await kindOf(apiError(429, 'rate_limit_exceeded', 'Rate limit reached', 'requests'))).toBe('rate_limit');
    expect(await kindOf(apiError(403, 'unsupported_country_region_territory'))).toBe('permission');
    expect(await kindOf(apiError(404, 'model_not_found', 'The model does not exist or you do not have access to it.'))).toBe('permission');
    expect(await kindOf(apiError(503, 'server_error', 'The server is overloaded'))).toBe('overloaded');
    expect(await kindOf(apiError(500, 'server_error'))).toBe('server');
    expect(await kindOf(apiError(400, 'invalid_request_error', 'Unsupported parameter'))).toBe('bad_request');
    expect(await kindOf({ throws: new TypeError('fetch failed') })).toBe('network');
    expect(await kindOf({ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) })).toBe('timeout');
  });
  it('never puts the key in an error message', () => {
    for (const kind of ['auth', 'permission', 'quota', 'rate_limit', 'overloaded', 'network', 'timeout', 'bad_request', 'server', 'cap', 'not_connected'] as const) {
      expect(openAiErrorMessage(kind, 'detalhe')).not.toContain('sk-');
    }
  });
});

const seed = (extra: Record<string, Rows> = {}): Record<string, Rows> => ({ settings: [], connector_secrets: [], openai_connections: [], openai_usage: [], ai_connections: [], ai_settings: [], activity_log: [], ...extra });
const connect = (db: unknown, fetcher: typeof fetch, extra: { model?: string; capCents?: number | null; at?: number } = {}) =>
  connectOpenAiKey(db as never, { userId: U, masterKey: MASTER, apiKey: KEY, model: extra.model ?? 'gpt-6.1-terra', capCents: extra.capCents === undefined ? 1000 : extra.capCents, fetcher, now: () => extra.at ?? NOW });

describe('connecting the OpenAI key', () => {
  it('tests the key, then saves it sealed and creates the connection', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher, seen } = scripted(() => ok('ok', 25, 2));
    await connect(db, fetcher);
    expect(seen).toHaveLength(1);
    const secret = tables['connector_secrets']?.[0] as Record<string, string>;
    expect(secret['ciphertext']).not.toContain(KEY);
    await expect(openJson<{ apiKey: string }>(secret['ciphertext'] as string, MASTER, U, 'openai')).resolves.toEqual({ apiKey: KEY });
    await expect(openJson(secret['ciphertext'] as string, MASTER, 'other-user', 'openai')).rejects.toBeDefined();
    await expect(openJson(secret['ciphertext'] as string, MASTER, U, 'claude')).rejects.toBeDefined();
    expect(tables['openai_connections']?.[0]).toMatchObject({ user_id: U, provider: 'openai', status: 'connected', model: 'gpt-6.1-terra', monthly_cap_cents: 1000, credential_id: secret['id'], last_error: null });
    expect(tables['openai_usage']?.[0]).toMatchObject({ purpose: 'teste', model: 'gpt-6.1-terra', input_tokens: 25, output_tokens: 2, cost_micros: 35 });
  });
  it('saves a connection without cap when the user chose no limit', async () => {
    const { tables, db } = memoryDb(seed());
    await connect(db, scripted(() => ok()).fetcher, { capCents: null });
    expect(tables['openai_connections']?.[0]).toMatchObject({ monthly_cap_cents: null });
  });
  it('saves nothing when OpenAI refuses the key', async () => {
    const { tables, db } = memoryDb(seed());
    await expect(connect(db, scripted(() => apiError(401, 'invalid_api_key')).fetcher)).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['connector_secrets']).toHaveLength(0); expect(tables['openai_connections']).toHaveLength(0);
  });
  it('replaces the old key when a new one is connected', async () => {
    const { tables, db } = memoryDb(seed());
    const { fetcher } = scripted(() => ok());
    await connect(db, fetcher); const first = (tables['connector_secrets']?.[0] as Record<string, string>)['id'];
    await connect(db, fetcher, { model: 'gpt-6-luna', capCents: 500 });
    expect(tables['connector_secrets']).toHaveLength(1);
    expect((tables['connector_secrets']?.[0] as Record<string, string>)['id']).not.toBe(first);
    expect(tables['openai_connections']).toHaveLength(1);
    expect(tables['openai_connections']?.[0]).toMatchObject({ model: 'gpt-6-luna', monthly_cap_cents: 500 });
  });
});

describe('askOpenAi', () => {
  const connected = async (extra: Record<string, Rows> = {}, options: { capCents?: number | null } = {}) => {
    const built = memoryDb(seed(extra)); await connect(built.db, scripted(() => ok()).fetcher, { capCents: options.capCents === undefined ? 1000 : options.capCents });
    built.tables['openai_usage']!.length = 0; return built;
  };
  const ask = (db: unknown, fetcher: typeof fetch, at = NOW) => askOpenAi(db as never, { userId: U, masterKey: MASTER, purpose: 'legenda', system: 'Redator', messages: [{ role: 'user', content: 'Escreva' }], maxTokens: 400, fetcher, now: () => at });

  it('answers, and records the tokens and the estimated cost', async () => {
    const { tables, db } = await connected();
    const { fetcher, seen } = scripted(() => ok('Legenda pronta', 1000, 500));
    const reply = await ask(db, fetcher);
    expect(reply).toMatchObject({ text: 'Legenda pronta', inputTokens: 1000, outputTokens: 500, costMicros: 3500 });
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(tables['openai_usage']).toHaveLength(1);
    expect(tables['openai_usage']?.[0]).toMatchObject({ user_id: U, purpose: 'legenda', cost_micros: 3500 });
  });
  it('refuses to call OpenAI once the monthly cap is reached', async () => {
    const { tables, db } = await connected({}, { capCents: 100 }); // US$ 1.00
    tables['openai_usage']!.push({ id: 'u1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 1_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    const { fetcher, seen } = scripted(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'cap' });
    expect(seen).toHaveLength(0);
  });
  it('never blocks on spending when there is no cap', async () => {
    const { tables, db } = await connected({}, { capCents: null });
    tables['openai_usage']!.push({ id: 'u1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 900_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    await expect(ask(db, scripted(() => ok()).fetcher)).resolves.toBeDefined();
  });
  it('counts only the current month and only this user toward the cap', async () => {
    const { tables, db } = await connected({}, { capCents: 100 });
    tables['openai_usage']!.push({ id: 'u1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 5_000_000, created_at: '2026-10-20T12:00:00.000Z' });
    tables['openai_usage']!.push({ id: 'u2', user_id: 'someone-else', purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 9_000_000, created_at: '2026-11-03T12:00:00.000Z' });
    await expect(ask(db, scripted(() => ok()).fetcher)).resolves.toBeDefined();
  });
  it('does not count Claude spending toward the OpenAI cap', async () => {
    const { tables, db } = await connected({ ai_usage: [{ id: 'c1', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 9_000_000, created_at: '2026-11-03T12:00:00.000Z' }] }, { capCents: 100 });
    expect(tables['ai_usage']).toHaveLength(1);
    await expect(ask(db, scripted(() => ok()).fetcher)).resolves.toBeDefined();
  });
  it('asks to connect when there is no connection', async () => {
    const { db } = memoryDb(seed());
    const { fetcher, seen } = scripted(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'not_connected' }); expect(seen).toHaveLength(0);
  });
  it('marks the connection invalid when OpenAI rejects the key, and then stops calling', async () => {
    const { tables, db } = await connected();
    await expect(ask(db, scripted(() => apiError(401, 'invalid_api_key')).fetcher)).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['openai_connections']?.[0]).toMatchObject({ status: 'invalid' });
    const { fetcher, seen } = scripted(() => ok());
    await expect(ask(db, fetcher)).rejects.toMatchObject({ kind: 'auth' }); expect(seen).toHaveLength(0);
  });
  it('keeps the connection when the failure is only temporary, and records no cost', async () => {
    const { tables, db } = await connected();
    await expect(ask(db, scripted(() => apiError(503, 'server_error', 'overloaded')).fetcher)).rejects.toMatchObject({ kind: 'overloaded' });
    expect(tables['openai_connections']?.[0]).toMatchObject({ status: 'connected' }); expect(tables['openai_usage']).toHaveLength(0);
  });
});

describe('testing, status and removal', () => {
  it('a working test brings an invalid connection back', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scripted(() => ok()).fetcher);
    (tables['openai_connections']![0] as Record<string, unknown>)['status'] = 'invalid';
    await testStoredOpenAi(db as never, { userId: U, masterKey: MASTER, fetcher: scripted(() => ok()).fetcher, now: () => NOW });
    expect(tables['openai_connections']?.[0]).toMatchObject({ status: 'connected', last_error: null, last_tested_at: new Date(NOW).toISOString() });
  });
  it('a failed test records the reason without exposing anything else', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scripted(() => ok()).fetcher);
    await expect(testStoredOpenAi(db as never, { userId: U, masterKey: MASTER, fetcher: scripted(() => apiError(401, 'invalid_api_key')).fetcher, now: () => NOW })).rejects.toMatchObject({ kind: 'auth' });
    expect(tables['openai_connections']?.[0]).toMatchObject({ status: 'invalid' });
    expect(String((tables['openai_connections']?.[0] as Record<string, unknown>)['last_error'])).toMatch(/recusou a chave/);
  });
  it('reports the status with the month spending, and no cap as null', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scripted(() => ok('ok', 200_000, 0)).fetcher);
    tables['openai_usage']!.push({ id: 'old', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: 777, created_at: '2026-09-01T00:00:00.000Z' });
    expect(await loadOpenAiStatus(db as never, U, NOW)).toMatchObject({ connected: true, status: 'connected', model: 'gpt-6.1-terra', monthlyCapCents: 1000, spentMicros: 200_000 });
    (tables['openai_connections']![0] as Record<string, unknown>)['monthly_cap_cents'] = null;
    expect(await loadOpenAiStatus(db as never, U, NOW)).toMatchObject({ monthlyCapCents: null });
    expect(await loadOpenAiStatus(memoryDb(seed()).db as never, U, NOW)).toMatchObject({ connected: false, monthlyCapCents: null });
  });
  it('removing the connection also erases the stored key', async () => {
    const { tables, db } = memoryDb(seed()); await connect(db, scripted(() => ok()).fetcher);
    await removeOpenAiConnection(db as never, U);
    expect(tables['openai_connections']).toHaveLength(0); expect(tables['connector_secrets']).toHaveLength(0);
  });
});

describe('the provider router', () => {
  const claudeOk = () => ({ json: { type: 'message', content: [{ type: 'text', text: 'resposta do Claude' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } });
  const params = (fetcher: typeof fetch) => ({ userId: U, masterKey: MASTER, purpose: 'conteudo', system: 'S', messages: [{ role: 'user' as const, content: 'Oi' }], maxTokens: 200, fetcher, now: () => NOW });
  const both = async () => {
    const built = memoryDb(seed());
    const { connectClaudeKey } = await import('@/lib/claude.server');
    await connectClaudeKey(built.db as never, { userId: U, masterKey: MASTER, apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5', capCents: 1000, fetcher: scripted(claudeOk).fetcher, now: () => NOW });
    await connect(built.db, scripted(() => ok()).fetcher);
    return built;
  };
  const urls = (fetcher: typeof fetch, run: () => Promise<unknown>) => run().then(() => fetcher);

  it('answers with Claude when no choice was saved', async () => {
    const { db } = await both();
    const spy = scripted(claudeOk);
    const reply = await askAi(db as never, params(spy.fetcher));
    expect(reply.text).toBe('resposta do Claude');
    expect(spy.seen[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(await activeProviderOf(db as never, U)).toBe('anthropic');
  });
  it('answers with OpenAI after the switch, and spends only on the OpenAI side', async () => {
    const { tables, db } = await both();
    await expect(switchProvider(db as never, U, 'openai')).resolves.toEqual({ ok: true, provider: 'openai' });
    const claudeSpent = tables['ai_usage']!.length; tables['openai_usage']!.length = 0;
    const spy = scripted(() => ok('resposta da OpenAI', 100, 50));
    const reply = await askAi(db as never, params(spy.fetcher));
    expect(reply).toMatchObject({ text: 'resposta da OpenAI', inputTokens: 100, outputTokens: 50, costMicros: 350 });
    expect(spy.seen[0]?.url).toBe(OPENAI_URL);
    expect(tables['ai_usage']).toHaveLength(claudeSpent); expect(tables['openai_usage']).toHaveLength(1);
  });
  it('can switch back to Claude at any time', async () => {
    const { db } = await both();
    await switchProvider(db as never, U, 'openai'); await switchProvider(db as never, U, 'anthropic');
    const spy = scripted(claudeOk);
    await expect(askAi(db as never, params(spy.fetcher))).resolves.toMatchObject({ text: 'resposta do Claude' });
  });
  it('refuses to switch to a provider that is not connected, and keeps the current one', async () => {
    const { tables, db } = memoryDb(seed());
    const result = await switchProvider(db as never, U, 'openai');
    expect(result).toMatchObject({ ok: false }); expect(result.ok ? '' : result.message).toMatch(/Conecte a OpenAI/);
    expect(tables['ai_settings']).toHaveLength(0);
    await connect(db, scripted(() => ok()).fetcher);
    (tables['openai_connections']![0] as Record<string, unknown>)['status'] = 'invalid';
    expect(await switchProvider(db as never, U, 'openai')).toMatchObject({ ok: false });
  });
  it('reports the active provider and whether it is ready', async () => {
    const { db } = memoryDb(seed());
    expect(await activeProviderReady(db as never, U)).toEqual({ provider: 'anthropic', ready: false });
    await connect(db, scripted(() => ok()).fetcher); await switchProvider(db as never, U, 'openai');
    expect(await activeProviderReady(db as never, U)).toEqual({ provider: 'openai', ready: true });
  });
  it('explains the errors of both AIs and ignores the others', () => {
    expect(aiErrorMessage(new OpenAiError('quota'))).toMatch(/sem crédito/);
    expect(aiErrorMessage(new ClaudeError('credit'))).toMatch(/sem crédito/);
    expect(aiErrorMessage(new Error('x'))).toBeNull();
    void urls;
  });
});