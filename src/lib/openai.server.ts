// Server-only: the only place that talks to the OpenAI API. The key stays sealed in the database and is opened only here,
// right before a call; it is never returned to the browser, logged, or put in an error message.
// It mirrors claude.server.ts on purpose: same questions, same checks, same shape of answer, so the rest of the app does not care which AI answered.
import type { SupabaseClient } from '@supabase/supabase-js';
import { openJson, sealJson } from './secret-box.server';
import { capMicros, monthStartIso } from './claude';
import type { ClaudeMessage } from './claude.server';
import {
  DEFAULT_OPENAI_MODEL, IMAGE_QUALITY, IMAGE_SIZE, REASONING_EFFORT, REASONING_HEADROOM_TOKENS, estimateOpenAiCostMicros, estimateOpenAiImageCostMicros, openAiErrorMessage, type OpenAiErrorKind,
} from './openai';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_IMAGE_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
export const OPENAI_IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const PURPOSE = 'openai';
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export class OpenAiError extends Error {
  constructor(readonly kind: OpenAiErrorKind, readonly detail = '') { super(kind); }
}
export type OpenAiMessage = ClaudeMessage;
export type OpenAiCall = { text: string; inputTokens: number; outputTokens: number; stopReason: string | null };
export type OpenAiReply = OpenAiCall & { costMicros: number };

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Row => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {});

/** Turns a failed answer from the OpenAI API (any endpoint) into an error the app can explain. */
export function openAiFailure(status: number, json: Row | null): OpenAiError {
  const error = obj(json?.['error']);
  const code = str(error['code']); const type = str(error['type']); const message = str(error['message']);
  if (status === 401 || code === 'invalid_api_key') return new OpenAiError('auth');
  if (code === 'insufficient_quota' || /exceeded your current quota|billing|credit/i.test(message)) return new OpenAiError('quota');
  if (code === 'moderation_blocked' || /safety system|content[_ ]policy/i.test(message)) return new OpenAiError('moderation');
  if (status === 403 || code === 'model_not_found' || (status === 404 && /model/i.test(message))) return new OpenAiError('permission');
  if (status === 429 || code === 'rate_limit_exceeded' || type === 'rate_limit_error') return new OpenAiError('rate_limit');
  if (status === 503 || /overloaded/i.test(message)) return new OpenAiError('overloaded');
  if (status >= 500) return new OpenAiError('server');
  return new OpenAiError('bad_request', message);
}

/** One call to the Responses API. Maps every failure to an OpenAiError the app can explain. */
export async function callOpenAi(fetcher: Fetcher, p: { apiKey: string; model: string; system?: string; messages: OpenAiMessage[]; maxTokens: number; timeoutMs?: number }): Promise<OpenAiCall> {
  let res: Response; let raw: string;
  try {
    res = await fetcher(OPENAI_URL, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(p.timeoutMs ?? 45_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model, ...(p.system ? { instructions: p.system } : {}), input: p.messages.map(message => ({ role: message.role, content: message.content })),
        max_output_tokens: p.maxTokens + REASONING_HEADROOM_TOKENS, reasoning: { effort: REASONING_EFFORT }, store: false,
      }),
    });
    raw = await res.text();
  } catch (error) {
    throw new OpenAiError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network');
  }
  let json: Row | null = null;
  try { const parsed: unknown = JSON.parse(raw); json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : null; } catch { json = null; }
  if (!res.ok || !json || (json['error'] && typeof json['error'] === 'object')) throw openAiFailure(res.status, json);
  // The text is in the "message" items of the output, as "output_text" parts (reasoning items carry no text we use).
  const items = Array.isArray(json['output']) ? (json['output'] as unknown[]) : [];
  const text = items.map(obj).filter(item => item['type'] === 'message')
    .flatMap(item => (Array.isArray(item['content']) ? (item['content'] as unknown[]) : []).map(obj))
    .filter(part => part['type'] === 'output_text').map(part => str(part['text'])).join('');
  const usage = obj(json['usage']);
  const incomplete = str(json['status']) === 'incomplete';
  return { text, inputTokens: num(usage['input_tokens']), outputTokens: num(usage['output_tokens']), stopReason: incomplete ? str(obj(json['incomplete_details'])['reason']) || 'incomplete' : 'completed' };
}

async function timezoneOf(db: Db, userId: string) {
  const { data } = await db.from('settings').select('timezone').eq('user_id', userId).maybeSingle();
  return str((data as Row | null)?.['timezone']) || DEFAULT_TIMEZONE;
}
/** Estimated spending on OpenAI in the current calendar month, in micro-dollars. */
export async function monthOpenAiSpentMicros(db: Db, userId: string, nowMs: number): Promise<number> {
  const start = monthStartIso(nowMs, await timezoneOf(db, userId));
  if (!start) return 0;
  const { data } = await db.from('openai_usage').select('cost_micros').eq('user_id', userId).gte('created_at', start).limit(20_000);
  return ((data ?? []) as Row[]).reduce((sum, row) => sum + num(row['cost_micros']), 0);
}
const recordUsage = (db: Db, userId: string, purpose: string, model: string, call: OpenAiCall, costMicros: number, nowMs: number) =>
  db.from('openai_usage').insert({ user_id: userId, purpose, model, input_tokens: call.inputTokens, output_tokens: call.outputTokens, cost_micros: costMicros, created_at: new Date(nowMs).toISOString() });

async function connectionOf(db: Db, userId: string) {
  const { data } = await db.from('openai_connections').select('id,credential_id,status,model,monthly_cap_cents,last_tested_at,last_error').eq('user_id', userId).maybeSingle();
  return data as Row | null;
}
/** The monthly cap in cents, or null when the user chose no limit. */
const capOf = (connection: Row): number | null => (typeof connection['monthly_cap_cents'] === 'number' && connection['monthly_cap_cents'] > 0 ? connection['monthly_cap_cents'] : null);

async function openKey(db: Db, userId: string, masterKey: string, credentialId: string): Promise<string> {
  const { data } = await db.from('connector_secrets').select('ciphertext').eq('id', credentialId).eq('user_id', userId).maybeSingle();
  const ciphertext = str((data as Row | null)?.['ciphertext']);
  if (!ciphertext) throw new OpenAiError('not_connected');
  try { const sealed = await openJson<{ apiKey?: unknown }>(ciphertext, masterKey, userId, PURPOSE); if (typeof sealed.apiKey === 'string' && sealed.apiKey) return sealed.apiKey; } catch { /* falls through */ }
  throw new OpenAiError('auth');
}

/**
 * The call the app uses to ask OpenAI something, with the same parameters and the same kind of answer as askClaude: it checks the connection and
 * the monthly cap (only when the user set one), makes the call, and records the tokens and the estimated cost.
 */
export async function askOpenAi(db: Db, p: { userId: string; masterKey: string; purpose: string; system?: string; messages: OpenAiMessage[]; maxTokens: number; timeoutMs?: number; test?: boolean; fetcher?: Fetcher; now?: () => number }): Promise<OpenAiReply> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const connection = await connectionOf(db, p.userId);
  const credentialId = str(connection?.['credential_id']);
  if (!connection || !credentialId) throw new OpenAiError('not_connected');
  if (!p.test && str(connection['status']) === 'invalid') throw new OpenAiError('auth');
  const cap = capOf(connection);
  if (!p.test && cap !== null && (await monthOpenAiSpentMicros(db, p.userId, now())) >= capMicros(cap)) throw new OpenAiError('cap');
  const apiKey = await openKey(db, p.userId, p.masterKey, credentialId);
  const model = str(connection['model']) || DEFAULT_OPENAI_MODEL;
  try {
    const call = await callOpenAi(fetcher, { apiKey, model, ...(p.system ? { system: p.system } : {}), messages: p.messages, maxTokens: p.maxTokens, ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}) });
    const costMicros = estimateOpenAiCostMicros(model, call.inputTokens, call.outputTokens);
    await recordUsage(db, p.userId, p.purpose, model, call, costMicros, now());
    return { ...call, costMicros };
  } catch (error) {
    if (error instanceof OpenAiError && error.kind === 'auth') await db.from('openai_connections').update({ status: 'invalid', last_error: openAiErrorMessage('auth') }).eq('user_id', p.userId);
    throw error;
  }
}

export type OpenAiImageCall = { bytes: Uint8Array; inputTokens: number; outputTokens: number; textInputTokens: number | null; imageInputTokens: number | null };
export type OpenAiImageReply = { bytes: Uint8Array; inputTokens: number; outputTokens: number; costMicros: number };

const fromBase64 = (value: string): Uint8Array => { const raw = atob(value); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes; };
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** A stable, private identifier OpenAI recommends sending with image requests: a hash of the user id, never the id itself. */
export async function safetyIdentifier(userId: string): Promise<string> { return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`divulga-promo:${userId}`))).slice(0, 48); }

/**
 * One call to the Image API. With reference photos it uses the edits endpoint (the model sees the real product); without them, generations.
 * It asks for a JPEG, which is what Instagram takes, and reads the picture from the base64 field of the answer.
 */
export async function callOpenAiImage(fetcher: Fetcher, p: { apiKey: string; model: string; prompt: string; references: Uint8Array[]; safetyId?: string; timeoutMs?: number }): Promise<OpenAiImageCall> {
  const edit = p.references.length > 0;
  const fields = { model: p.model, prompt: p.prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, output_format: 'jpeg', n: 1, ...(p.safetyId ? { safety_identifier: p.safetyId } : {}) };
  let init: RequestInit;
  if (edit) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    p.references.forEach((bytes, index) => form.append('image[]', new Blob([bytes as BlobPart], { type: 'image/jpeg' }), `referencia-${index + 1}.jpg`));
    init = { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}` }, body: form };
  } else {
    init = { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(fields) };
  }
  let res: Response; let raw: string;
  try {
    res = await fetcher(edit ? OPENAI_IMAGE_EDITS_URL : OPENAI_IMAGE_GENERATIONS_URL, { ...init, redirect: 'manual', signal: AbortSignal.timeout(p.timeoutMs ?? 100_000) });
    raw = await res.text();
  } catch (error) {
    throw new OpenAiError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network');
  }
  let json: Row | null = null;
  try { const parsed: unknown = JSON.parse(raw); json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : null; } catch { json = null; }
  if (!res.ok || !json || (json['error'] && typeof json['error'] === 'object')) throw openAiFailure(res.status, json);
  const first = obj(Array.isArray(json['data']) ? (json['data'] as unknown[])[0] : null);
  const encoded = str(first['b64_json']);
  if (!encoded) throw new OpenAiError('server');
  let bytes: Uint8Array;
  try { bytes = fromBase64(encoded); } catch { throw new OpenAiError('server'); }
  if (bytes.length < 1000) throw new OpenAiError('server');
  const usage = obj(json['usage']); const details = obj(usage['input_tokens_details']);
  const hasSplit = typeof details['text_tokens'] === 'number' && typeof details['image_tokens'] === 'number';
  return { bytes, inputTokens: num(usage['input_tokens']), outputTokens: num(usage['output_tokens']), textInputTokens: hasSplit ? num(details['text_tokens']) : null, imageInputTokens: hasSplit ? num(details['image_tokens']) : null };
}

/**
 * Asks OpenAI for one image, with the same checks as every other call: connected, key accepted, monthly cap (only if the user set one).
 * The tokens and the estimated cost are recorded in the OpenAI usage, like the text calls.
 */
export async function askOpenAiImage(db: Db, p: { userId: string; masterKey: string; purpose: string; model: string; prompt: string; references: Uint8Array[]; timeoutMs?: number; fetcher?: Fetcher; now?: () => number }): Promise<OpenAiImageReply> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const connection = await connectionOf(db, p.userId);
  const credentialId = str(connection?.['credential_id']);
  if (!connection || !credentialId) throw new OpenAiError('not_connected');
  if (str(connection['status']) === 'invalid') throw new OpenAiError('auth');
  const cap = capOf(connection);
  if (cap !== null && (await monthOpenAiSpentMicros(db, p.userId, now())) >= capMicros(cap)) throw new OpenAiError('cap');
  const apiKey = await openKey(db, p.userId, p.masterKey, credentialId);
  try {
    const call = await callOpenAiImage(fetcher, { apiKey, model: p.model, prompt: p.prompt, references: p.references, safetyId: await safetyIdentifier(p.userId), ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}) });
    const costMicros = estimateOpenAiImageCostMicros(call);
    await recordUsage(db, p.userId, p.purpose, p.model, { text: '', inputTokens: call.inputTokens, outputTokens: call.outputTokens, stopReason: 'completed' }, costMicros, now());
    return { bytes: call.bytes, inputTokens: call.inputTokens, outputTokens: call.outputTokens, costMicros };
  } catch (error) {
    if (error instanceof OpenAiError && error.kind === 'auth') await db.from('openai_connections').update({ status: 'invalid', last_error: openAiErrorMessage('auth') }).eq('user_id', p.userId);
    throw error;
  }
}

const TEST_MESSAGE: OpenAiMessage[] = [{ role: 'user', content: 'Responda somente com a palavra: ok' }];

/** Checks the key with a tiny call and, only if it works, stores it sealed (replacing any previous key). `capCents` null means no limit. */
export async function connectOpenAiKey(db: Db, p: { userId: string; masterKey: string; apiKey: string; model: string; capCents: number | null; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const call = await callOpenAi(fetcher, { apiKey: p.apiKey, model: p.model, messages: TEST_MESSAGE, maxTokens: 16, timeoutMs: 30_000 });
  const previous = await connectionOf(db, p.userId);
  const secretId = crypto.randomUUID();
  const ciphertext = await sealJson({ apiKey: p.apiKey }, p.masterKey, p.userId, PURPOSE);
  const stored = await db.from('connector_secrets').insert({ id: secretId, user_id: p.userId, ciphertext, key_version: 1 });
  if (stored.error) throw new OpenAiError('server');
  const saved = await db.from('openai_connections').upsert({
    user_id: p.userId, provider: 'openai', credential_id: secretId, status: 'connected', model: p.model, monthly_cap_cents: p.capCents,
    last_tested_at: new Date(now()).toISOString(), last_error: null,
  }, { onConflict: 'user_id' });
  if (saved.error) { await db.from('connector_secrets').delete().eq('id', secretId).eq('user_id', p.userId); throw new OpenAiError('server'); }
  const oldId = str(previous?.['credential_id']);
  if (oldId) await db.from('connector_secrets').delete().eq('id', oldId).eq('user_id', p.userId);
  await recordUsage(db, p.userId, 'teste', p.model, call, estimateOpenAiCostMicros(p.model, call.inputTokens, call.outputTokens), now());
}

/** Tests the stored key again. A working key puts a connection marked invalid back to connected. */
export async function testStoredOpenAi(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const now = p.now ?? Date.now;
  try {
    await askOpenAi(db, { ...p, purpose: 'teste', messages: TEST_MESSAGE, maxTokens: 16, timeoutMs: 30_000, test: true });
    await db.from('openai_connections').update({ status: 'connected', last_tested_at: new Date(now()).toISOString(), last_error: null }).eq('user_id', p.userId);
  } catch (error) {
    if (error instanceof OpenAiError) await db.from('openai_connections').update({ last_tested_at: new Date(now()).toISOString(), last_error: openAiErrorMessage(error.kind, error.detail), ...(error.kind === 'auth' ? { status: 'invalid' } : {}) }).eq('user_id', p.userId);
    throw error;
  }
}

export async function removeOpenAiConnection(db: Db, userId: string): Promise<void> {
  const connection = await connectionOf(db, userId);
  await db.from('openai_connections').delete().eq('user_id', userId);
  const credentialId = str(connection?.['credential_id']);
  if (credentialId) await db.from('connector_secrets').delete().eq('id', credentialId).eq('user_id', userId);
}

export type OpenAiStatusData = { connected: boolean; status: string; model: string; monthlyCapCents: number | null; spentMicros: number; lastTestedAt: string | null; lastError: string | null };
export async function loadOpenAiStatus(db: Db, userId: string, nowMs: number): Promise<OpenAiStatusData> {
  const connection = await connectionOf(db, userId);
  if (!connection || !str(connection['credential_id'])) return { connected: false, status: 'disconnected', model: DEFAULT_OPENAI_MODEL, monthlyCapCents: null, spentMicros: 0, lastTestedAt: null, lastError: null };
  return {
    connected: true, status: str(connection['status']) || 'connected', model: str(connection['model']) || DEFAULT_OPENAI_MODEL, monthlyCapCents: capOf(connection),
    spentMicros: await monthOpenAiSpentMicros(db, userId, nowMs), lastTestedAt: str(connection['last_tested_at']) || null, lastError: str(connection['last_error']) || null,
  };
}