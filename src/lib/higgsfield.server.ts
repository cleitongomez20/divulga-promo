// Server-only: the only place that talks to the Higgsfield API. The key ID and secret stay sealed in the database and are opened
// only here, right before a call; they are never returned to the browser, logged, or put in an error message.
import type { SupabaseClient } from '@supabase/supabase-js';
import { openJson, sealJson } from './secret-box.server';
import { capMicros, monthStartIso } from './claude';
import { HF_BASE_URL, higgsfieldErrorMessage, type HiggsfieldErrorKind } from './higgsfield';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
type Fetcher = typeof fetch;
export type HiggsfieldCredentials = { keyId: string; keySecret: string };

const PURPOSE = 'higgsfield';
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export class HiggsfieldError extends Error {
  constructor(readonly kind: HiggsfieldErrorKind, readonly detail = '', readonly retryAfterSeconds: number | null = null) { super(kind); }
}
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Turns an HTTP status into an error the app can explain (the table in Higgsfield's "Errors and retries" page). */
export function errorForStatus(status: number, detail: string, retryAfter: number | null): HiggsfieldError {
  if (status === 401) return new HiggsfieldError('auth');
  if (status === 403) return new HiggsfieldError('balance');
  if (status === 423) return new HiggsfieldError('blocked');
  if (status === 429) return new HiggsfieldError('busy', '', retryAfter);
  if (status === 404 || status === 503) return new HiggsfieldError('unavailable', detail);
  if (status === 400 || status === 422 || status === 409) return new HiggsfieldError('invalid', detail);
  return new HiggsfieldError('server');
}

/** One call to the Higgsfield API. Returns the status and JSON body; the caller decides what each status means. */
export async function hfCall(fetcher: Fetcher, credentials: HiggsfieldCredentials, p: { method: 'GET' | 'POST'; path: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number }): Promise<{ status: number; json: Row | null; retryAfter: number | null }> {
  let res: Response; let raw: string;
  try {
    res = await fetcher(`${HF_BASE_URL}${p.path}`, {
      method: p.method, redirect: 'manual', signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
      headers: { authorization: `Key ${credentials.keyId}:${credentials.keySecret}`, ...(p.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(p.idempotencyKey ? { 'idempotency-key': p.idempotencyKey } : {}) },
      ...(p.body !== undefined ? { body: JSON.stringify(p.body) } : {}),
    });
    raw = await res.text();
  } catch (error) {
    throw new HiggsfieldError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network');
  }
  let json: Row | null = null;
  try { const parsed: unknown = JSON.parse(raw); json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : null; } catch { json = null; }
  const retry = Number(res.headers.get('retry-after')); const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
  return { status: res.status, json, retryAfter };
}
const detailOf = (json: Row | null) => (typeof json?.['detail'] === 'string' ? json['detail'] : '');

/**
 * Checks the key without spending anything: asks for the status of a request that does not exist.
 * A wrong key is refused (401); a right key answers "not found" (404).
 */
export async function checkCredentials(fetcher: Fetcher, credentials: HiggsfieldCredentials): Promise<void> {
  const { status, json, retryAfter } = await hfCall(fetcher, credentials, { method: 'GET', path: `/requests/${crypto.randomUUID()}/status`, timeoutMs: 15_000 });
  if (status === 401) throw new HiggsfieldError('auth');
  if (status === 404 || status === 403 || (status >= 200 && status < 300)) return;
  throw errorForStatus(status, detailOf(json), retryAfter);
}

async function timezoneOf(db: Db, userId: string) {
  const { data } = await db.from('settings').select('timezone').eq('user_id', userId).maybeSingle();
  return str((data as Row | null)?.['timezone']) || DEFAULT_TIMEZONE;
}
/** Estimated spending of the current calendar month, in micro-dollars. */
export async function monthMediaSpentMicros(db: Db, userId: string, nowMs: number): Promise<number> {
  const start = monthStartIso(nowMs, await timezoneOf(db, userId));
  if (!start) return 0;
  const { data } = await db.from('media_usage').select('cost_micros').eq('user_id', userId).gte('created_at', start).limit(20_000);
  return ((data ?? []) as Row[]).reduce((sum, row) => sum + num(row['cost_micros']), 0);
}
export const recordMediaUsage = (db: Db, userId: string, p: { purpose: string; model: string; costMicros: number; at: number }) =>
  db.from('media_usage').insert({ user_id: userId, purpose: p.purpose, model: p.model, cost_micros: p.costMicros, created_at: new Date(p.at).toISOString() });

async function connectionOf(db: Db, userId: string) {
  const { data } = await db.from('media_connections').select('id,credential_id,status,monthly_cap_cents,last_tested_at,last_error').eq('user_id', userId).maybeSingle();
  return data as Row | null;
}
async function openCredentials(db: Db, userId: string, masterKey: string, credentialId: string): Promise<HiggsfieldCredentials> {
  const { data } = await db.from('connector_secrets').select('ciphertext').eq('id', credentialId).eq('user_id', userId).maybeSingle();
  const ciphertext = str((data as Row | null)?.['ciphertext']);
  if (!ciphertext) throw new HiggsfieldError('not_connected');
  try {
    const sealed = await openJson<{ keyId?: unknown; keySecret?: unknown }>(ciphertext, masterKey, userId, PURPOSE);
    if (typeof sealed.keyId === 'string' && typeof sealed.keySecret === 'string' && sealed.keyId && sealed.keySecret) return { keyId: sealed.keyId, keySecret: sealed.keySecret };
  } catch { /* falls through */ }
  throw new HiggsfieldError('auth');
}

/**
 * What every generation must ask first: is Higgsfield connected, is the key still accepted, and does the planned spending fit in the monthly cap?
 * Returns the opened credentials. `estimateMicros` is what this job is expected to cost.
 */
export async function credentialsForJob(db: Db, p: { userId: string; masterKey: string; estimateMicros: number; now?: () => number }): Promise<HiggsfieldCredentials> {
  const now = p.now ?? Date.now;
  const connection = await connectionOf(db, p.userId);
  const credentialId = str(connection?.['credential_id']);
  if (!connection || !credentialId) throw new HiggsfieldError('not_connected');
  if (str(connection['status']) === 'invalid') throw new HiggsfieldError('auth');
  if ((await monthMediaSpentMicros(db, p.userId, now())) + p.estimateMicros > capMicros(num(connection['monthly_cap_cents']))) throw new HiggsfieldError('cap');
  return openCredentials(db, p.userId, p.masterKey, credentialId);
}
/** A rejected key puts the connection in the "invalid" state, so nothing keeps trying with it. */
export async function markInvalid(db: Db, userId: string) {
  await db.from('media_connections').update({ status: 'invalid', last_error: higgsfieldErrorMessage('auth') }).eq('user_id', userId);
}

/** Checks the key and, only if Higgsfield accepts it, stores it sealed (replacing any previous key). */
export async function connectHiggsfieldKey(db: Db, p: { userId: string; masterKey: string; keyId: string; keySecret: string; capCents: number; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  await checkCredentials(fetcher, { keyId: p.keyId, keySecret: p.keySecret });
  const previous = await connectionOf(db, p.userId);
  const secretId = crypto.randomUUID();
  const ciphertext = await sealJson({ keyId: p.keyId, keySecret: p.keySecret }, p.masterKey, p.userId, PURPOSE);
  const stored = await db.from('connector_secrets').insert({ id: secretId, user_id: p.userId, ciphertext, key_version: 1 });
  if (stored.error) throw new HiggsfieldError('server');
  const saved = await db.from('media_connections').upsert({
    user_id: p.userId, provider: 'higgsfield', credential_id: secretId, status: 'connected', monthly_cap_cents: p.capCents, last_tested_at: new Date(now()).toISOString(), last_error: null,
  }, { onConflict: 'user_id' });
  if (saved.error) { await db.from('connector_secrets').delete().eq('id', secretId).eq('user_id', p.userId); throw new HiggsfieldError('server'); }
  const oldId = str(previous?.['credential_id']);
  if (oldId) await db.from('connector_secrets').delete().eq('id', oldId).eq('user_id', p.userId);
}

/** Tests the stored key again, at no cost. A working key puts a connection marked invalid back to connected. */
export async function testStoredHiggsfield(db: Db, p: { userId: string; masterKey: string; fetcher?: Fetcher; now?: () => number }): Promise<void> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now;
  const connection = await connectionOf(db, p.userId);
  const credentialId = str(connection?.['credential_id']);
  if (!connection || !credentialId) throw new HiggsfieldError('not_connected');
  try {
    await checkCredentials(fetcher, await openCredentials(db, p.userId, p.masterKey, credentialId));
    await db.from('media_connections').update({ status: 'connected', last_tested_at: new Date(now()).toISOString(), last_error: null }).eq('user_id', p.userId);
  } catch (error) {
    if (error instanceof HiggsfieldError) await db.from('media_connections').update({ last_tested_at: new Date(now()).toISOString(), last_error: higgsfieldErrorMessage(error.kind, error.detail), ...(error.kind === 'auth' ? { status: 'invalid' } : {}) }).eq('user_id', p.userId);
    throw error;
  }
}

export async function removeHiggsfieldConnection(db: Db, userId: string): Promise<void> {
  const connection = await connectionOf(db, userId);
  await db.from('media_connections').delete().eq('user_id', userId);
  const credentialId = str(connection?.['credential_id']);
  if (credentialId) await db.from('connector_secrets').delete().eq('id', credentialId).eq('user_id', userId);
}

export type HiggsfieldStatusData = { connected: boolean; status: string; monthlyCapCents: number; spentMicros: number; lastTestedAt: string | null; lastError: string | null };
export async function loadHiggsfieldStatus(db: Db, userId: string, nowMs: number): Promise<HiggsfieldStatusData> {
  const connection = await connectionOf(db, userId);
  if (!connection || !str(connection['credential_id'])) return { connected: false, status: 'disconnected', monthlyCapCents: 1000, spentMicros: 0, lastTestedAt: null, lastError: null };
  return {
    connected: true, status: str(connection['status']) || 'connected', monthlyCapCents: num(connection['monthly_cap_cents']) || 1000,
    spentMicros: await monthMediaSpentMicros(db, userId, nowMs), lastTestedAt: str(connection['last_tested_at']) || null, lastError: str(connection['last_error']) || null,
  };
}