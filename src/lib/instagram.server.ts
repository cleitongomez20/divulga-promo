import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/integrations/supabase/types';
import { sealJson, openJson } from './secret-box.server';
import { GRAPH_VERSION, REQUIRED_PERMISSIONS, type InstagramErrorCode } from './instagram';

type Admin = SupabaseClient<Database>;
type Fetcher = typeof fetch;
const encoder = new TextEncoder();
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const APP_PURPOSE = 'instagram-app';
const TOKEN_PURPOSE = 'instagram-token';

export type MetaError = { code: number | null; subcode: number | null; type: string | null; message: string | null };
/** Safe details about a failure (never a token or a secret), kept in the history to explain what happened. */
export type Detail = { step: string; status?: number; network?: boolean; meta?: MetaError | null; [key: string]: unknown };
export class InstagramError extends Error { constructor(readonly code: InstagramErrorCode, readonly detail: Detail = { step: 'desconhecido' }) { super(code); } }
export type AppCredentials = { appId: string; appSecret: string; configId: string };
type StoredToken = { accessToken: string; issuedAt: number; expiresAt: number | null };

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

/** The login window: Facebook Login with a configuration (the configuration decides which permissions are asked). */
export function buildAuthorizeUrl(p: { appId: string; configId: string; redirectUri: string; state: string }) {
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('client_id', p.appId);
  url.searchParams.set('config_id', p.configId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', p.state);
  return url.toString();
}

// ---- calls to the Meta Graph ----
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** Ids can have 17 digits, more than JavaScript numbers hold exactly, so they are turned into text before reading. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await res.text())
      .replace(/("(?:user_id|id)"\s*:\s*)(\d{15,})/g, '$1"$2"')
      .replace(/("target_ids"\s*:\s*\[)([^\]]*)\]/g, (_m, head: string, inner: string) => `${head}${inner.replace(/(^|,)(\s*)(\d{15,})(?=\s*(?:,|$))/g, '$1$2"$3"')}]`);
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}
export function metaErrorOf(json: Record<string, unknown> | null): MetaError | null {
  const error = json?.['error'];
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  return { code: num(e['code']), subcode: num(e['error_subcode']), type: text(e['type']), message: text(e['message'])?.slice(0, 200) ?? null };
}
async function graphGet(fetcher: Fetcher, url: URL, failure: InstagramErrorCode, step: string): Promise<Record<string, unknown>> {
  let res: Response; let json: Record<string, unknown> | null;
  try {
    res = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(15000), redirect: 'manual' });
    json = await readJson(res);
  } catch { throw new InstagramError(failure, { step, network: true }); }
  if (!res.ok || !json) throw new InstagramError(failure, { step, status: res.status, meta: metaErrorOf(json) });
  return json;
}
function graphUrl(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export async function exchangeCode(fetcher: Fetcher, p: { appId: string; appSecret: string; redirectUri: string; code: string }) {
  const json = await graphGet(fetcher, graphUrl('/oauth/access_token', { client_id: p.appId, client_secret: p.appSecret, redirect_uri: p.redirectUri, code: p.code }), 'troca', 'trocar_codigo');
  const token = text(json['access_token']);
  if (!token) throw new InstagramError('troca', { step: 'trocar_codigo', status: 200 });
  return { token };
}
/** Turns the short login token into a long-lived one. Page tokens taken from a long-lived token do not expire. */
export async function exchangeForLongLived(fetcher: Fetcher, p: { appId: string; appSecret: string; shortToken: string }) {
  const json = await graphGet(fetcher, graphUrl('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: p.appId, client_secret: p.appSecret, fb_exchange_token: p.shortToken }), 'troca', 'token_longo');
  const token = text(json['access_token']);
  if (!token) throw new InstagramError('troca', { step: 'token_longo', status: 200 });
  return { token, expiresInSeconds: num(json['expires_in']) };
}
export async function fetchGrantedPermissions(fetcher: Fetcher, token: string): Promise<string[]> {
  const json = await graphGet(fetcher, graphUrl('/me/permissions', { access_token: token }), 'perfil', 'permissoes');
  const data = Array.isArray(json['data']) ? (json['data'] as unknown[]) : [];
  return data.flatMap(item => (item && typeof item === 'object' && (item as Record<string, unknown>)['status'] === 'granted' ? [String((item as Record<string, unknown>)['permission'])] : []));
}

export type DiscoveredAccount = { pageId: string; pageName: string | null; pageToken: string; igUserId: string; igUsername: string | null };
/** Pages the user authorized, keeping the ones that have a professional Instagram account linked. */
export async function discoverAccounts(fetcher: Fetcher, token: string): Promise<{ accounts: DiscoveredAccount[]; pagesSeen: number }> {
  const json = await graphGet(fetcher, graphUrl('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: token }), 'perfil', 'paginas');
  const pages = Array.isArray(json['data']) ? (json['data'] as unknown[]) : [];
  const accounts: DiscoveredAccount[] = [];
  for (const raw of pages) {
    if (!raw || typeof raw !== 'object') continue;
    const page = raw as Record<string, unknown>;
    const instagram = page['instagram_business_account'];
    const igId = instagram && typeof instagram === 'object' ? text((instagram as Record<string, unknown>)['id']) : null;
    const pageId = text(page['id']); const pageToken = text(page['access_token']);
    if (!igId || !pageId || !pageToken) continue;
    accounts.push({ pageId, pageName: text(page['name']), pageToken, igUserId: igId, igUsername: text((instagram as Record<string, unknown>)['username']) });
  }
  return { accounts, pagesSeen: pages.length };
}

/**
 * Unified Login: no Facebook Page. The token belongs to the client's business portfolio and the Instagram accounts the
 * client shared are listed in the token's "granular scopes" (asked to Meta with the app's own id|secret).
 */
export async function discoverSharedInstagramIds(fetcher: Fetcher, p: { appId: string; appSecret: string; token: string }): Promise<string[]> {
  const json = await graphGet(fetcher, graphUrl('/debug_token', { input_token: p.token, access_token: `${p.appId}|${p.appSecret}` }), 'perfil', 'ler_token');
  const data = json['data'] && typeof json['data'] === 'object' ? (json['data'] as Record<string, unknown>) : {};
  const scopes = Array.isArray(data['granular_scopes']) ? (data['granular_scopes'] as unknown[]) : [];
  const ids: string[] = [];
  for (const raw of scopes) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const scope = String(entry['scope'] ?? '');
    if (!scope.startsWith('instagram_')) continue;
    for (const id of Array.isArray(entry['target_ids']) ? (entry['target_ids'] as unknown[]) : []) {
      const value = typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null;
      if (value && /^\d+$/.test(value) && !ids.includes(value)) ids.push(value);
    }
  }
  return ids;
}
/** Asks the Instagram account itself, which proves the saved access really works. */
export async function verifyAccount(fetcher: Fetcher, token: string, igUserId: string) {
  const json = await graphGet(fetcher, graphUrl(`/${encodeURIComponent(igUserId)}`, { fields: 'id,username', access_token: token }), 'perfil', 'verificar_conta');
  return { username: text(json['username']) };
}

// ---- storage (connector_secrets holds the sealed values; the tables hold only references) ----
async function appRow(admin: Admin, userId: string) {
  const { data } = await admin.from('marketplace_connections').select('id,credential_id').eq('user_id', userId).eq('marketplace', 'instagram_app').maybeSingle();
  return data;
}
async function accountRow(admin: Admin, userId: string) {
  const { data } = await admin.from('instagram_accounts').select('id,ig_user_id,username,page_id,credential_id,token_expires_at,status,warmup_started_at,created_at').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  return data;
}
async function insertSecret(admin: Admin, userId: string, masterKey: string, purpose: string, value: unknown) {
  const ciphertext = await sealJson(value, masterKey, userId, purpose);
  const { data, error } = await admin.from('connector_secrets').insert({ user_id: userId, ciphertext, key_version: 1 }).select('id').single();
  if (error || !data) throw new InstagramError('salvar', { step: 'guardar_segredo' });
  return data.id;
}
const dropSecret = (admin: Admin, userId: string, id: string | null) => (id ? admin.from('connector_secrets').delete().eq('id', id).eq('user_id', userId) : Promise.resolve(null));

export async function loadAppCredentials(admin: Admin, userId: string, masterKey: string): Promise<AppCredentials | null> {
  const row = await appRow(admin, userId);
  if (!row?.credential_id) return null;
  const { data } = await admin.from('connector_secrets').select('ciphertext').eq('id', row.credential_id).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  const app = await openJson<Partial<AppCredentials>>(data.ciphertext, masterKey, userId, APP_PURPOSE);
  return app.appId && app.appSecret && app.configId ? { appId: app.appId, appSecret: app.appSecret, configId: app.configId } : null;
}
export async function saveAppCredentials(admin: Admin, userId: string, masterKey: string, credentials: AppCredentials) {
  const previous = await loadAppCredentials(admin, userId, masterKey).catch(() => null);
  const secretId = await insertSecret(admin, userId, masterKey, APP_PURPOSE, credentials);
  const existing = await appRow(admin, userId);
  const { error } = existing
    ? await admin.from('marketplace_connections').update({ credential_id: secretId, status: 'configured' }).eq('id', existing.id).eq('user_id', userId)
    : await admin.from('marketplace_connections').insert({ user_id: userId, marketplace: 'instagram_app', status: 'configured', credential_id: secretId });
  if (error) { await dropSecret(admin, userId, secretId); throw new InstagramError('salvar', { step: 'guardar_app' }); }
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
  return row ? { username: row.username, igUserId: row.ig_user_id, pageId: row.page_id, status: row.status } : null;
}
export async function saveConnectedAccount(admin: Admin, userId: string, masterKey: string, p: { igUserId: string; username: string | null; pageId: string | null; token: string; issuedAt: number; expiresAt: number | null }) {
  const secretId = await insertSecret(admin, userId, masterKey, TOKEN_PURPOSE, { accessToken: p.token, issuedAt: p.issuedAt, expiresAt: p.expiresAt } satisfies StoredToken);
  const existing = await accountRow(admin, userId);
  const values = { ig_user_id: p.igUserId, username: p.username, page_id: p.pageId, credential_id: secretId, token_expires_at: p.expiresAt === null ? null : new Date(p.expiresAt).toISOString(), status: 'connected' };
  const { error } = existing
    ? await admin.from('instagram_accounts').update(values).eq('id', existing.id).eq('user_id', userId)
    : await admin.from('instagram_accounts').insert({ user_id: userId, ...values, warmup_started_at: new Date(p.issuedAt).toISOString() });
  if (error) { await dropSecret(admin, userId, secretId); throw new InstagramError('salvar', { step: 'guardar_conta' }); }
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
  return { stored: await openJson<StoredToken>(data.ciphertext, masterKey, userId, TOKEN_PURPOSE), igUserId: row.ig_user_id, pageId: row.page_id };
}
/** The token used for publishing (a Page token, which does not expire while the permission stands). */
export async function getPublishingToken(admin: Admin, userId: string, masterKey: string, now = Date.now()) {
  const current = await readToken(admin, userId, masterKey);
  if (!current) return null;
  if (current.stored.expiresAt !== null && current.stored.expiresAt <= now) throw new InstagramError('expirado', { step: 'validade' });
  return { token: current.stored.accessToken, igUserId: current.igUserId, pageId: current.pageId };
}
/** "Test connection": asks the Instagram account itself. A rejected token (code 190) means the user must connect again. */
export async function checkAccount(admin: Admin, userId: string, masterKey: string, fetcher: Fetcher = fetch) {
  const current = await getPublishingToken(admin, userId, masterKey);
  if (!current) throw new InstagramError('expirado', { step: 'sem_conta' });
  try {
    const { username } = await verifyAccount(fetcher, current.token, current.igUserId);
    if (username) await admin.from('instagram_accounts').update({ username, status: 'connected' }).eq('user_id', userId);
    return { username };
  } catch (error) {
    if (error instanceof InstagramError && error.detail.meta?.code === 190) {
      await admin.from('instagram_accounts').update({ status: 'expired' }).eq('user_id', userId);
      throw new InstagramError('expirado', error.detail);
    }
    throw error;
  }
}

/** Everything that happens when the user comes back from the login window. Each step leaves safe details in the history. */
export async function completeInstagramLogin(p: { admin: Admin; userId: string; masterKey: string; code: string; redirectUri: string; fetcher?: Fetcher; now?: number }): Promise<{ ok: true } | { ok: false; code: InstagramErrorCode }> {
  const fetcher = p.fetcher ?? fetch; const now = p.now ?? Date.now();
  const diagnostics: Record<string, unknown> = {};
  const record = (result: string) => p.admin.from('activity_log').insert({ user_id: p.userId, action: 'Conexão com o Instagram', result, details: diagnostics as Json });
  try {
    const app = await loadAppCredentials(p.admin, p.userId, p.masterKey);
    if (!app) return { ok: false, code: 'app' };
    const short = await exchangeCode(fetcher, { appId: app.appId, appSecret: app.appSecret, redirectUri: p.redirectUri, code: p.code });
    diagnostics['codigo_trocado'] = true;
    // Unified Login hands over a Business Integration System User token, which does not expire and needs no long-lived exchange.
    // Older configurations (Facebook user token) still get the exchange; if it is refused, the token received is kept.
    let token = short.token;
    await exchangeForLongLived(fetcher, { appId: app.appId, appSecret: app.appSecret, shortToken: short.token })
      .then(long => { token = long.token; diagnostics['token_longo'] = true; })
      .catch((error: unknown) => { diagnostics['token_longo'] = false; diagnostics['token_longo_erro'] = error instanceof InstagramError ? error.detail : true; });
    // A failure to list permissions is not fatal: finding the account below shows whether the access works.
    const granted = await fetchGrantedPermissions(fetcher, token).catch((error: unknown) => { diagnostics['permissoes_erro'] = error instanceof InstagramError ? error.detail : true; return null; });
    if (granted) {
      diagnostics['permissoes'] = granted;
      const missing = REQUIRED_PERMISSIONS.filter(permission => !granted.includes(permission));
      if (missing.length) { diagnostics['permissoes_faltando'] = missing; await record('Permissões insuficientes'); return { ok: false, code: 'permissao' }; }
    }
    // 1) Unified Login: accounts shared with the token (no Page involved).
    const sharedIds = await discoverSharedInstagramIds(fetcher, { appId: app.appId, appSecret: app.appSecret, token })
      .catch((error: unknown) => { diagnostics['ler_token_erro'] = error instanceof InstagramError ? error.detail : true; return [] as string[]; });
    diagnostics['contas_compartilhadas'] = sharedIds.length;
    if (sharedIds.length) {
      const igUserId = sharedIds[0] as string;
      const { username } = await verifyAccount(fetcher, token, igUserId);
      await saveConnectedAccount(p.admin, p.userId, p.masterKey, { igUserId, username, pageId: null, token, issuedAt: now, expiresAt: null });
      diagnostics['modo'] = 'unificado'; diagnostics['usuario'] = username;
    } else {
      // 2) Older configurations: Pages that have a professional Instagram account linked.
      const { accounts, pagesSeen } = await discoverAccounts(fetcher, token);
      diagnostics['paginas'] = pagesSeen; diagnostics['contas_instagram'] = accounts.length;
      const chosen = accounts[0];
      if (!chosen) { await record('Nenhuma conta do Instagram encontrada'); return { ok: false, code: 'sem_instagram' }; }
      await saveConnectedAccount(p.admin, p.userId, p.masterKey, { igUserId: chosen.igUserId, username: chosen.igUsername, pageId: chosen.pageId, token: chosen.pageToken, issuedAt: now, expiresAt: null });
      diagnostics['modo'] = 'paginas'; diagnostics['usuario'] = chosen.igUsername;
    }
    await record('Conta conectada');
    return { ok: true };
  } catch (error) {
    const code = error instanceof InstagramError ? error.code : 'troca';
    if (error instanceof InstagramError) diagnostics['falha'] = error.detail;
    await record(`Falha: ${code}`);
    return { ok: false, code };
  }
}