// Server-only: the only place that talks to the Claude API. The key stays sealed in the database and is opened only here,
// right before a call; it is never returned to the browser, logged, or put in an error message.
import type { SupabaseClient } from '@supabase/supabase-js';
import { openJson, sealJson } from './secret-box.server';
import { DEFAULT_MODEL, capMicros, estimateCostMicros, monthStartIso, claudeErrorMessage, type ClaudeErrorKind } from './claude';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

export const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
const PURPOSE = 'claude';
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export class ClaudeError extends Error {
  constructor(readonly kind: ClaudeErrorKind, readonly detail = '') { super(kind); }
}
export type ClaudeMessage = { role: 'user' | 'assistant'; content: string };
export type ClaudeCall = { text: string; inputTokens: number; outputTokens: number; stopReason: string | null };
export type ClaudeReply = ClaudeCall & { costMicros: number };

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** One call to the Messages API. Maps every failure to a ClaudeError the app can explain. */
export async function callClaude(fetcher: Fetcher, p: { apiKey: string; model: string; system?: string; messages: ClaudeMessage[]; maxTokens: number; timeoutMs?: number }): Promise<ClaudeCall> {
  let res: Response; let raw: string;
  try {
    res = await fetcher(CLAUDE_URL, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(p.timeoutMs ?? 45_000),
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, max_tokens: p.maxTokens, ...(p.system ? { system: p.system } : {}), messages: p.messages }),
    });
    raw = await res.text();
  } catch (error) {
    throw new ClaudeError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network');
  }
  let json: Row | null = null;
  try { const parsed: unknown = JSON.parse(raw); json = parsed && typeof parsed === 'object' ? (parsed as Row) : null; } catch { json = null; }
  if (!res.ok || !json || json['type'] === 'error') {
    const error = (json?.['error'] && typeof json['error'] === 'object' ? (json['error'] as Row) : {}) as Row;
    const type = str(error['type']); const message = str(error['message']);
    if (res.status === 401 || type === 'authentication_error') throw new ClaudeError('auth');
    if (res.status === 403 || type === 'permission_error') throw new ClaudeError('permission');
    if (/credit balance/i.test(message)) throw new ClaudeError('credit');
    if (res.status === 429 || type === 'rate_limit_error') throw new ClaudeError('rate_limit');
    if (res.status === 529 || res.status === 503 || type === 'overloaded_error') throw new ClaudeError('overloaded');
    if (res.status >= 500) throw new ClaudeError('server');
    throw new ClaudeError('bad_request', message);
  }
  const blocks = Array.isArray(json['content']) ? (json['content'] as Row[]) : [];
  const text = blocks.filter(block => block['type'] === 'text').map(block => str(block['text'])).join('');
  const usage = (json['usage'] && typeof json['usage'] === 'object' ? (json['usage'] as Row) : {}) as Row;
  return { text, inputTokens: num(usage['input_tokens']), outputTokens: num(usage['output_tokens']), stopReason: typeof json['stop_reason'] === 'string' ? json['stop_reason'] : null };
}

async function timezoneOf(db: Db, userId: string) {
  const { data } = await db.from('settings').select('timezone').eq('user_id', userId).maybeSingle();
  return str((data as Row | null)?.['timezone']) || DEFAULT_TIMEZONE;
}
/** Estimated spending of the current calendar month, in micro-dollars. */
export async function monthSpentMicros(db: Db, userId: string, nowMs: number): Promise<number> {
  const start = monthStartIso(nowMs, await timezoneOf(db, userId));
  if (!start) return 0;
  const { data } = await db.from('ai_usage').select('cost_micros').eq('user_id', userId).gte('created_at', start).limit(20_000);
  return ((data ?? []) as Row[]).reduce((sum, row) => sum + num(row['cost_micros']), 0);
}
const recordUsage = (db: Db, userId: string, purpose: string, model: string, call: ClaudeCall, costMicros: number, nowMs: number) =>
  db.from('ai_usage').insert({ user_id: userId, purpose, model, input_tokens: call.inputTokens, output_tokens: call.outputTokens, cost_micros: costMicros, created_at: new Date(nowMs).toISOString() });

async function connectionOf(db: Db, userId: string) {
  const { data } = await db.from('ai_connections').select('id,credential_id,status,model,monthly_cap_cents,last_tested_at,last_error').eq('user_id', userId).maybeSingle();
  return data as Row | null;
}
async function openKey(db: Db, userId: string, masterKey: string, credentialId: string): Promise<string> {
  const { data } = await db.from('connector_secrets').select('ciphertext').eq('id', credentialId).eq('user_id', userId).maybeSingle();
  const ciphertext = str((data as Row | null)?.['ciphertext']);
  if (!ciphertext) throw new ClaudeError('not_connected');
  try { const sealed = await openJson<{ apiKey?: unknown }>(ciphertext, masterKey, userId, PURPOSE); if (typeof sealed.apiKey === 'string' && sealed.apiKey) return sealed.apiKey; } catch { /* falls through */ }
  throw new ClaudeError('auth');
}

/**
 * The call every part of the app uses to ask Claude something: it checks the connection and the monthly cap, makes the call,
 * and records the tokens and the estimated cost. Tests (`test: true`) skip the cap and may run on a connection marked invalid.
 */
export async function askClaude(db: Db, p: { userId: string; masterKey: string; purpose: string; system?: string; messages: ClaudeMessage[]; maxTokens: number; timeoutMs?: number; test?: boolean; fetcher?: Fetcher; now?: () => number }): Promise<ClaudeReply> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const connection = await connectionOf(db, p.userId);
  const credentialId = str(connection?.['credential_id']);
  if (!connection || !credentialId) throw new ClaudeError('not_connected');
  if (!p.test && str(connection['status']) === 'invalid') throw new ClaudeError('auth');
  const cap = capCentsOf(connection); // no cap saved means no limit
  if (!p.test && cap !== null && (await monthSpentMicros(db, p.userId, now())) >= capMicros(cap)) throw new ClaudeError('cap');
  const apiKey = await openKey(db, p.userId, p.masterKey, credentialId);
  const model = str(connection['model']) || DEFAULT_MODEL;
  try {
    const call = await callClaude(fetcher, { apiKey, model, ...(p.system ? { system: p.system } : {}), messages: p.messages, maxTokens: p.maxTokens, ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}) });
    const costMicros = estimateCostMicros(model, call.inputTokens, call.outputTokens);
    await recordUsage(db, p.userId, p.purpose, model, call, costMicros, now());
    return { ...call, costMicros };
  } catch (error) {
    if (error instanceof ClaudeError && error.kind === 'auth') await db.from('ai_connections').update({ status: 'invalid', last_error: claudeErrorMessage('auth') }).eq('user_id', p.userId);
    throw error;
  }
}

const TEST_MESSAGE: ClaudeMessage[] = [{ role: 'user', content: 'Responda somente com a palavra: ok' }];

/** Checks the key with a tiny call and, only if it works, stores it sealed (replacing any previous key). */
export async function connectClaudeKey(db: Db, p: { userId: string; masterKey: string; apiKey: string; model: string; capCents: number | null; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const call = await callClaude(fetcher, { apiKey: p.apiKey, model: p.model, messages: TEST_MESSAGE, maxTokens: 16, timeoutMs: 20_000 });
  const previous = await connectionOf(db, p.userId);
  const secretId = crypto.randomUUID();
  const ciphertext = await sealJson({ apiKey: p.apiKey }, p.masterKey, p.userId, PURPOSE);
  const stored = await db.from('connector_secrets').insert({ id: secretId, user_id: p.userId, ciphertext, key_version: 1 });
  if (stored.error) throw new ClaudeError('server');
  const saved = await db.from('ai_connections').upsert({
    user_id: p.userId, provider: 'anthropic', credential_id: secretId, status: 'connected', model: p.model, monthly_cap_cents: p.capCents,
    last_tested_at: new Date(now()).toISOString(), last_error: null,
  }, { onConflict: 'user_id' });
  if (saved.error) { await db.from('connector_secrets').delete().eq('id', secretId).eq('user_id', p.userId); throw new ClaudeError('server'); }
  const oldId = str(previous?.['credential_id']);
  if (oldId) await db.from('connector_secrets').delete().eq('id', oldId).eq('user_id', p.userId);
  await recordUsage(db, p.userId, 'teste', p.model, call, estimateCostMicros(p.model, call.inputTokens, call.outputTokens), now());
}

/** Tests the stored key again. A working key puts a connection marked invalid back to connected. */
export async function testStoredClaude(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const now = p.now ?? Date.now;
  try {
    await askClaude(db, { ...p, purpose: 'teste', messages: TEST_MESSAGE, maxTokens: 16, timeoutMs: 20_000, test: true });
    await db.from('ai_connections').update({ status: 'connected', last_tested_at: new Date(now()).toISOString(), last_error: null }).eq('user_id', p.userId);
  } catch (error) {
    if (error instanceof ClaudeError) await db.from('ai_connections').update({ last_tested_at: new Date(now()).toISOString(), last_error: claudeErrorMessage(error.kind, error.detail), ...(error.kind === 'auth' ? { status: 'invalid' } : {}) }).eq('user_id', p.userId);
    throw error;
  }
}

export async function removeClaudeConnection(db: Db, userId: string): Promise<void> {
  const connection = await connectionOf(db, userId);
  await db.from('ai_connections').delete().eq('user_id', userId);
  const credentialId = str(connection?.['credential_id']);
  if (credentialId) await db.from('connector_secrets').delete().eq('id', credentialId).eq('user_id', userId);
}

/** The monthly cap in cents, or null when there is no limit. */
const capCentsOf = (connection: Row): number | null => (typeof connection['monthly_cap_cents'] === 'number' && connection['monthly_cap_cents'] > 0 ? connection['monthly_cap_cents'] : null);
export type ClaudeStatusData = { connected: boolean; status: string; model: string; monthlyCapCents: number | null; spentMicros: number; lastTestedAt: string | null; lastError: string | null };
export async function loadClaudeStatus(db: Db, userId: string, nowMs: number): Promise<ClaudeStatusData> {
  const connection = await connectionOf(db, userId);
  if (!connection || !str(connection['credential_id'])) return { connected: false, status: 'disconnected', model: DEFAULT_MODEL, monthlyCapCents: null, spentMicros: 0, lastTestedAt: null, lastError: null };
  return {
    connected: true, status: str(connection['status']) || 'connected', model: str(connection['model']) || DEFAULT_MODEL, monthlyCapCents: capCentsOf(connection),
    spentMicros: await monthSpentMicros(db, userId, nowMs), lastTestedAt: str(connection['last_tested_at']) || null, lastError: str(connection['last_error']) || null,
  };
}