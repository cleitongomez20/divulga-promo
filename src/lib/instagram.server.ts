import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/integrations/supabase/types';
import { sealJson, openJson } from './secret-box.server';
import { INSTAGRAM_SCOPES, type InstagramErrorCode } from './instagram';

type Admin = SupabaseClient<Database>;
type Fetcher = typeof fetch;
const encoder = new TextEncoder();
const DAY = 86_400_000;
const APP_PURPOSE = 'instagram-app';
const TOKEN_PURPOSE = 'instagram-token';
const REFRESH_WHEN_LEFT_MS = 10 * DAY;
const MIN_TOKEN_AGE_MS = DAY; // the Instagram only refreshes tokens that are at least 24 hours old

export class InstagramError extends Error { constructor(readonly code: InstagramErrorCode) { super(code); } }
export type AppCredentials = { appId: string; appSecret: string };
type StoredToken = { accessToken: string; issuedAt: number; expiresAt: number };

// ---- signed "state" that ties the login round trip to the user who started it ----
const toB64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hmacKey = (masterKey: string) => crypto.subtle.importKey('raw', encoder.encode(`instagram-state:${masterKey}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signState(userId: string, masterKey: string, now = Date.now()) {
  const nonce = toB64Url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = toB64Url(encoder.encode(JSON.stringify({ u: userId, t: now, n: nonce })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(masterKey), encoder.encode(payload)));
  return `${payload}.${toB64Url(signature)}`;
}
/** Returns the user id when the state is genuine and recent (15 minutes), otherwise null. */
export async function verifyState(state: string, masterKey: string, now = Date.now(), maxAgeMs = 15 * 60_000): Promise<string | null> {
  try {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(masterKey), fromB64Url(signature), encoder.encode(payload)))) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64Url(payload))) as { u?: unknown; t?: unknown };
    if (typeof data.u !== 'string' || typeof data.t !== 'number') return null;
    if (now - data.t > maxAgeMs || data.t - now > 60_000) return null;
    return data.u;
  } catch { return null; }
}

export function buildAuthorizeUrl(p: { appId: string; redirectUri: string; state: string }) {
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', p.appId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  url.searchParams.set('state', p.state);
  url.searchParams.set('force_authentication', '1');
  return url.toString();
}

// ---- calls to the Instagram ----
/** Instagram ids have 17 digits, more than JavaScript numbers hold exactly, so they are turned into text before reading. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = (await res.text()).replace(/("(?:user_id|id)"\s*:\s*)(\d{15,})/g, '$1"$2"');
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}
async function send(fetcher: Fetcher, url: string | URL, init: RequestInit, code: InstagramErrorCode): Promise<{ res: Response; json: Record<string, unknown> | null }> {
  try {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    return { res, json: await readJson(res) };
  } catch { throw new InstagramError(code); }
}

export async function exchangeCode(fetcher: Fetcher, p: { appId: string; appSecret: string; redirectUri: string; code: string }) {
  const body = new URLSearchParams({ client_id: p.appId, client_secret: p.appSecret, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code: p.code });
  const { res, json } = await send(fetcher, 'https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 'troca');
  const data = Array.isArray(json?.['data']) ? (json?.['data'] as unknown[])[0] : json;
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const token = record?.['access_token'];
  if (!res.ok || typeof token !== 'string' || !token) throw new InstagramError('troca');
  const granted = record?.['permissions'];
  const permissions = Array.isArray(granted) ? granted.map(String) : typeof granted === 'string' ? granted.split(',').map(s => s.trim()).filter(Boolean) : [];
  const userId = record?.['user_id'];
  return { token, userId: userId === undefined || userId === null ? null : String(userId), permissions };
}

async function longLived(fetcher: Fetcher, url: URL, failure: InstagramErrorCode) {
  const { res, json } = await send(fetcher, url, { method: 'GET' }, failure);
  const token = json?.['access_token']; const seconds = json?.['expires_in'];
  if (!res.ok || typeof token !== 'string' || !token || typeof seconds !== 'number' || !(seconds > 0)) throw new InstagramError(failure);
  return { token, expiresInSeconds: seconds };
}
export function exchangeForLongLived(fetcher: Fetcher, p: { appSecret: string; shortToken: string }) {
  const url = new URL('https://graph.instagram.com/access_token');
  url.searchParams.set('grant_type', 'ig_exchange_token'); url.searchParams.set('client_secret', p.appSecret); url.searchParams.set('access_token', p.shortToken);
  return longLived(fetcher, url, 'troca');
}
export function refreshLongLived(fetcher: Fetcher, token: string) {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token'); url.searchParams.set('access_token', token);
  return longLived(fetcher, url, 'renovacao');
}

export async function fetchProfile(fetcher: Fetcher, token: string) {
  const { res, json } = await send(fetcher, 'https://graph.instagram.com/me?fields=user_id,username,account_type', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, 'perfil');
  if (!res.ok || !json) throw new InstagramError('perfil');
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return { userId: text(json['user_id']) ?? text(json['id']), username: text(json['username']), accountType: text(json['account_type']) };
}

// ---- storage (connector_secrets holds the sealed values; the tables hold only references) ----
async function appRow(admin: Admin, userId: string) {
  const { data } = await admin.from('marketplace_connections').select('id,credential_id').eq('user_id', userId).eq('marketplace', 'instagram_app').maybeSingle();
  return data;
}
async function accountRow(admin: Admin, userId: string) {
  const { data } = await admin.from('instagram_accounts').select('id,ig_user_id,username,credential_id,token_expires_at,status,warmup_started_at').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  return data;
}
async function insertSecret(admin: Admin, userId: string, masterKey: string, purpose: string, value: unknown) {
  const ciphertext = await sealJson(value, masterKey, userId, purpose);
  const { data, error } = await admin.from('connector_secrets').insert({ user_id: userId, ciphertext, key_version: 1 }).select('id').single();
  if (error || !data) throw new InstagramError('salvar');
  return data.id;
}
const dropSecret = (admin: Admin, userId: string, id: string | null) => (id ? admin.from('connector_secrets').delete().eq('id', id).eq('user_id', userId) : Promise.resolve(null));

export async function loadAppCredentials(admin: Admin, userId: string, masterKey: string): Promise<AppCredentials | null> {
  const row = await appRow(admin, userId);
  if (!row?.credential_id) return null;
  const { data } = await admin.from('connector_secrets').select('ciphertext').eq('id', row.credential_id).eq('user_id', userId).maybeSingle();
  return data ? openJson<AppCredentials>(data.ciphertext, masterKey, userId, APP_PURPOSE) : null;
}
export async function saveAppCredentials(admin: Admin, userId: string, masterKey: string, credentials: AppCredentials) {
  const previous = await loadAppCredentials(admin, userId, masterKey).catch(() => null);
  const secretId = await insertSecret(admin, userId, masterKey, APP_PURPOSE, credentials);
  const existing = await appRow(admin, userId);
  const { error } = existing
    ? await admin.from('marketplace_connections').update({ credential_id: secretId, status: 'configured' }).eq('id', existing.id).eq('user_id', userId)
    : await admin.from('marketplace_connections').insert({ user_id: userId, marketplace: 'instagram_app', status: 'configured', credential_id: secretId });
  if (error) { await dropSecret(admin, userId, secretId); throw new InstagramError('salvar'); }
  await dropSecret(admin, userId, existing?.credential_id ?? null);
  // A token belongs to one app: a different app means the account has to be connected again.
  if (previous && previous.appId !== credentials.appId) await disconnectAccount(admin, userId);
}
export async function removeAppCredentials(admin: Admin, userId: string) {
  await disconnectAccount(admin, userId);
  const existing = await appRow(admin, userId);
  if (!existing) return;
  await admin.from('marketplace_connections').delete().eq('id', existing.id).eq('user_id', userId);
  await dropSecret(admin, userId, existing.credential_id);
}

export async function loadAccount(admin: Admin, userId: string) {
  const row = await accountRow(admin, userId);
  return row ? { username: row.username, igUserId: row.ig_user_id, expiresAt: row.token_expires_at ? Date.parse(row.token_expires_at) : null } : null;
}
export async function saveConnectedAccount(admin: Admin, userId: string, masterKey: string, p: { igUserId: string; username: string | null; token: string; issuedAt: number; expiresAt: number }) {
  const secretId = await insertSecret(admin, userId, masterKey, TOKEN_PURPOSE, { accessToken: p.token, issuedAt: p.issuedAt, expiresAt: p.expiresAt } satisfies StoredToken);
  const existing = await accountRow(admin, userId);
  const values = { ig_user_id: p.igUserId, username: p.username, credential_id: secretId, token_expires_at: new Date(p.expiresAt).toISOString(), status: 'connected' };
  const { error } = existing
    ? await admin.from('instagram_accounts').update(values).eq('id', existing.id).eq('user_id', userId)
    : await admin.from('instagram_accounts').insert({ user_id: userId, ...values, warmup_started_at: new Date(p.issuedAt).toISOString() });
  if (error) { await dropSecret(admin, userId, secretId); throw new InstagramError('salvar'); }
  await dropSecret(admin, userId, existing?.credential_id ?? null);
}
export async function disconnectAccount(admin: Admin, userId: string) {
  const row = await accountRow(admin, userId);
  if (!row) return;
  await admin.from('instagram_accounts').delete().eq('id', row.id).eq('user_id', userId);
  await dropSecret(admin, userId, row.credential_id);
}

async function readToken(admin: Admin, userId: string, masterKey: string) {
  const row = await accountRow(admin, userId);
  if (!row?.credential_id || !row.ig_user_id) return null;
  const { data } = await admin.from('connector_secrets').select('ciphertext').eq('id', row.credential_id).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  return { stored: await openJson<StoredToken>(data.ciphertext, masterKey, userId, TOKEN_PURPOSE), igUserId: row.ig_user_id, accountId: row.id, credentialId: row.credential_id };
}

/** Renews the 60-day access. Returns false when it was renewed less than 24 hours ago (the Instagram refuses that). */
export async function refreshAccount(admin: Admin, userId: string, masterKey: string, fetcher: Fetcher = fetch, now = Date.now()) {
  const current = await readToken(admin, userId, masterKey);
  if (!current) throw new InstagramError('expirado');
  if (current.stored.expiresAt <= now) throw new InstagramError('expirado');
  if (now - current.stored.issuedAt < MIN_TOKEN_AGE_MS) return { refreshed: false, expiresAt: current.stored.expiresAt };
  const fresh = await refreshLongLived(fetcher, current.stored.accessToken);
  const expiresAt = now + fresh.expiresInSeconds * 1000;
  await saveConnectedAccount(admin, userId, masterKey, { igUserId: current.igUserId, username: (await loadAccount(admin, userId))?.username ?? null, token: fresh.token, issuedAt: now, expiresAt });
  return { refreshed: true, expiresAt };
}

/** The token used for publishing. Renews it first when it is close to expiring. */
export async function ensureFreshToken(admin: Admin, userId: string, masterKey: string, fetcher: Fetcher = fetch, now = Date.now()) {
  const current = await readToken(admin, userId, masterKey);
  if (!current) return null;
  if (current.stored.expiresAt <= now) throw new InstagramError('expirado');
  if (current.stored.expiresAt - now < REFRESH_WHEN_LEFT_MS && now - current.stored.issuedAt >= MIN_TOKEN_AGE_MS) {
    try { await refreshAccount(admin, userId, masterKey, fetcher, now); const renewed = await readToken(admin, userId, masterKey); if (renewed) return { token: renewed.stored.accessToken, igUserId: renewed.igUserId }; } catch { /* the old token is still valid */ }
  }
  return { token: current.stored.accessToken, igUserId: current.igUserId };
}

/** Everything that happens when the user comes back from the Instagram authorization window. */
export async function completeInstagramLogin(p: { admin: Admin; userId: string; masterKey: string; code: string; redirectUri: string; fetcher?: Fetcher; now?: number }): Promise<{ ok: true } | { ok: false; code: InstagramErrorCode }> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now();
  try {
    const app = await loadAppCredentials(p.admin, p.userId, p.masterKey);
    if (!app) return { ok: false, code: 'app' };
    const short = await exchangeCode(fetcher, { appId: app.appId, appSecret: app.appSecret, redirectUri: p.redirectUri, code: p.code });
    if (short.permissions.length > 0 && !short.permissions.includes('instagram_business_content_publish')) return { ok: false, code: 'permissao' };
    const long = await exchangeForLongLived(fetcher, { appSecret: app.appSecret, shortToken: short.token });
    const profile = await fetchProfile(fetcher, long.token);
    if (profile.accountType && !['BUSINESS', 'MEDIA_CREATOR'].includes(profile.accountType.toUpperCase())) return { ok: false, code: 'conta_pessoal' };
    const igUserId = profile.userId ?? short.userId;
    if (!igUserId) return { ok: false, code: 'perfil' };
    await saveConnectedAccount(p.admin, p.userId, p.masterKey, { igUserId, username: profile.username, token: long.token, issuedAt: now, expiresAt: now + long.expiresInSeconds * 1000 });
    await p.admin.from('activity_log').insert({ user_id: p.userId, action: 'Instagram conectado', result: 'Conta conectada', details: { username: profile.username, account_type: profile.accountType } as Json });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof InstagramError ? error.code : 'troca' };
  }
}