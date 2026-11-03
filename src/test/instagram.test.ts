import { describe, it, expect, vi } from 'vitest';
import {
  InstagramError, signState, verifyState, buildAuthorizeUrl, exchangeCode, exchangeForLongLived, refreshLongLived, fetchProfile,
  completeInstagramLogin, saveAppCredentials, loadAppCredentials, removeAppCredentials, ensureFreshToken, refreshAccount, loadAccount, disconnectAccount,
} from '@/lib/instagram.server';
import { instagramAppSchema, instagramErrorMessage, daysLeft, maskId, INSTAGRAM_SCOPES } from '@/lib/instagram';
import { sealJson, openJson } from '@/lib/secret-box.server';

const KEY = 'chave-mestra-de-teste-com-tamanho-suficiente';
const USER = '11111111-1111-1111-1111-111111111111';
const DAY = 86_400_000;
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

// A small in-memory stand-in for the database calls used by the Instagram code.
function fakeAdmin() {
  const tables: Record<string, Record<string, unknown>[]> = { connector_secrets: [], marketplace_connections: [], instagram_accounts: [], activity_log: [] };
  let seq = 0;
  const from = (name: string) => {
    const rows = tables[name] as Record<string, unknown>[];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'; let values: Record<string, unknown> = {}; const filters: [string, unknown][] = []; let single: 'one' | 'maybe' | null = null; let limit = Infinity; let selected = false;
    const run = () => {
      const match = (row: Record<string, unknown>) => filters.every(([k, v]) => row[k] === v);
      if (op === 'insert') { const row = { id: `id${++seq}`, created_at: new Date(1_800_000_000_000 + seq).toISOString(), ...values }; rows.push(row); return { data: selected ? { ...row } : null, error: null }; }
      if (op === 'update') { rows.filter(match).forEach(row => Object.assign(row, values)); return { data: null, error: null }; }
      if (op === 'delete') { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i] as Record<string, unknown>)) rows.splice(i, 1); return { data: null, error: null }; }
      const found = rows.filter(match).slice(0, limit).map(row => ({ ...row })); // copies, like a real database answer
      if (single === 'maybe') return { data: found[0] ?? null, error: null };
      if (single === 'one') return found[0] ? { data: found[0], error: null } : { data: null, error: { message: 'not found' } };
      return { data: found, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => { selected = true; return builder; }, insert: (v: Record<string, unknown>) => { op = 'insert'; values = v; return builder; }, update: (v: Record<string, unknown>) => { op = 'update'; values = v; return builder; },
      delete: () => { op = 'delete'; return builder; }, eq: (k: string, v: unknown) => { filters.push([k, v]); return builder; }, order: () => builder, limit: (n: number) => { limit = n; return builder; },
      maybeSingle: () => { single = 'maybe'; return builder; }, single: () => { single = 'one'; return builder; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => { try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return reject(e); } },
    };
    return builder;
  };
  return { admin: { from } as never, tables };
}

describe('app credentials and scopes', () => {
  it('accepts a numeric app id and an alphanumeric secret only', () => {
    expect(instagramAppSchema.safeParse({ appId: ' 123456789012345 ', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }).success).toBe(true);
    expect(instagramAppSchema.safeParse({ appId: '12ab', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ appId: '123456789012345', appSecret: 'curto' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ appId: '123456789012345', appSecret: 'abc def ghi jkl mno pqr stu' }).success).toBe(false);
  });
  it('asks only for the profile and publishing permissions', () => {
    expect([...INSTAGRAM_SCOPES]).toEqual(['instagram_business_basic', 'instagram_business_content_publish']);
  });
  it('has a plain message for each failure and masks ids', () => {
    expect(instagramErrorMessage('conta_pessoal')).toContain('profissional');
    expect(instagramErrorMessage('qualquer-coisa')).toContain('Não foi possível');
    expect(maskId('123456789012345')).toBe('123••••••••••45');
    expect(daysLeft(10 * DAY + 5, 0)).toBe(10);
  });
});

describe('sealed values', () => {
  it('opens only for the same user and purpose', async () => {
    const sealed = await sealJson({ a: 1 }, KEY, USER, 'instagram-token');
    expect(await openJson(sealed, KEY, USER, 'instagram-token')).toEqual({ a: 1 });
    await expect(openJson(sealed, KEY, 'outro-usuario', 'instagram-token')).rejects.toBeTruthy();
    await expect(openJson(sealed, KEY, USER, 'instagram-app')).rejects.toBeTruthy();
    await expect(openJson(sealed, 'outra-chave-mestra-qualquer-123456', USER, 'instagram-token')).rejects.toBeTruthy();
    expect(sealed).not.toContain('"a"');
  });
});

describe('signed state of the login', () => {
  it('returns the user for a genuine recent state', async () => {
    const state = await signState(USER, KEY, 1_000_000);
    expect(await verifyState(state, KEY, 1_000_000 + 60_000)).toBe(USER);
  });
  it('refuses a forged, altered, expired or foreign state', async () => {
    const state = await signState(USER, KEY, 1_000_000);
    expect(await verifyState(state, KEY, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(await verifyState(state, 'outra-chave-mestra-qualquer-123456', 1_000_000)).toBeNull();
    const [payload, signature] = state.split('.') as [string, string];
    const forged = btoa(JSON.stringify({ u: 'outro-usuario', t: 1_000_000, n: 'x' })).replace(/=+$/, '');
    expect(await verifyState(`${forged}.${signature}`, KEY, 1_000_000)).toBeNull();
    expect(await verifyState(`${payload}.`, KEY, 1_000_000)).toBeNull();
    expect(await verifyState('lixo', KEY, 1_000_000)).toBeNull();
    expect(await verifyState('', KEY, 1_000_000)).toBeNull();
    expect(await verifyState(await signState(USER, KEY, 5_000_000), KEY, 1_000_000)).toBeNull(); // from the future
  });
  it('builds the authorization address with the state and the two permissions', () => {
    const url = new URL(buildAuthorizeUrl({ appId: '123456789', redirectUri: 'https://app.exemplo/api/public/instagram-callback', state: 'abc.def' }));
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish');
    expect(url.searchParams.get('state')).toBe('abc.def');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.exemplo/api/public/instagram-callback');
  });
});

describe('calls to the Instagram', () => {
  const asFetch = (fn: (url: string, init: RequestInit) => Response) => (async (url: string | URL, init: RequestInit) => fn(String(url), init)) as unknown as typeof fetch;
  it('keeps 17-digit ids exact (numbers lose digits in JavaScript)', async () => {
    const fetcher = asFetch(() => json('{"data":[{"access_token":"SHORT","user_id":17841405793187218,"permissions":"instagram_business_basic,instagram_business_content_publish"}]}'));
    const result = await exchangeCode(fetcher, { appId: '1', appSecret: 's', redirectUri: 'https://x/', code: 'c' });
    expect(result).toEqual({ token: 'SHORT', userId: '17841405793187218', permissions: ['instagram_business_basic', 'instagram_business_content_publish'] });
    const profile = await fetchProfile(asFetch(() => json('{"user_id":17841405793187218,"username":"minha.loja","account_type":"BUSINESS","id":"123"}')), 'T');
    expect(profile).toEqual({ userId: '17841405793187218', username: 'minha.loja', accountType: 'BUSINESS' });
  });
  it('also reads the older answer shape and sends the code as a form', async () => {
    let sent: RequestInit | undefined;
    const fetcher = asFetch((_url, init) => { sent = init; return json({ access_token: 'SHORT', user_id: '99', permissions: ['instagram_business_basic'] }); });
    const result = await exchangeCode(fetcher, { appId: '111', appSecret: 'segredo', redirectUri: 'https://x/cb', code: 'COD' });
    expect(result.userId).toBe('99');
    expect(String(sent?.body)).toContain('grant_type=authorization_code');
    expect(String(sent?.body)).toContain('code=COD');
    expect(sent?.method).toBe('POST');
  });
  it('turns every failure into a typed error, with no secret in the message', async () => {
    const bad = [asFetch(() => json({ error_message: 'x' }, 400)), asFetch(() => json('não é json', 200)), asFetch(() => { throw new Error('rede com segredo123'); })];
    for (const fetcher of bad) {
      const error = await exchangeCode(fetcher, { appId: '1', appSecret: 'segredo123', redirectUri: 'x', code: 'c' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InstagramError);
      expect((error as InstagramError).code).toBe('troca');
      expect((error as InstagramError).message).not.toContain('segredo123');
    }
  });
  it('exchanges for the 60-day token and refreshes it with the token in the query', async () => {
    const urls: string[] = [];
    const fetcher = asFetch(url => { urls.push(url); return json({ access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 }); });
    expect(await exchangeForLongLived(fetcher, { appSecret: 'seg', shortToken: 'SHORT' })).toEqual({ token: 'LONG', expiresInSeconds: 5183944 });
    expect(await refreshLongLived(fetcher, 'LONG')).toEqual({ token: 'LONG', expiresInSeconds: 5183944 });
    expect(urls[0]).toContain('grant_type=ig_exchange_token');
    expect(urls[1]).toContain('grant_type=ig_refresh_token');
    await expect(exchangeForLongLived(asFetch(() => json({ access_token: 'x' })), { appSecret: 's', shortToken: 't' })).rejects.toMatchObject({ code: 'troca' });
    await expect(refreshLongLived(asFetch(() => json({}, 400)), 't')).rejects.toMatchObject({ code: 'renovacao' });
  });
  it('reads the profile with the token in the header, not in the address', async () => {
    let seen: { url: string; headers: HeadersInit | undefined } | undefined;
    await fetchProfile(asFetch((url, init) => { seen = { url, headers: init.headers }; return json({ user_id: '5', username: 'a' }); }), 'TOKEN123');
    expect(seen?.url).not.toContain('TOKEN123');
    expect(new Headers(seen?.headers).get('Authorization')).toBe('Bearer TOKEN123');
  });
});

describe('connecting the account', () => {
  const APP = { appId: '123456789012345', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' };
  const instagram = (account: Record<string, unknown> | { fail: number }, perms = 'instagram_business_basic,instagram_business_content_publish') => (async (url: string | URL) => {
    const address = String(url);
    if (address.includes('/oauth/access_token')) return json(`{"data":[{"access_token":"SHORT-TOKEN","user_id":17841405793187218,"permissions":"${perms}"}]}`);
    if (address.includes('/access_token?')) return json({ access_token: 'LONG-TOKEN', expires_in: 5184000 });
    if (address.includes('/me?')) return 'fail' in account ? json({}, Number(account['fail'])) : json(account);
    return json({}, 404);
  }) as unknown as typeof fetch;
  const login = (db: ReturnType<typeof fakeAdmin>, fetcher: typeof fetch, now = 1_800_000_000_000) => completeInstagramLogin({ admin: db.admin, userId: USER, masterKey: KEY, code: 'COD', redirectUri: 'https://x/cb', fetcher, now });

  it('saves the app, connects the account and keeps secrets sealed', async () => {
    const db = fakeAdmin();
    await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await loadAppCredentials(db.admin, USER, KEY)).toEqual(APP);
    expect(JSON.stringify(db.tables)).not.toContain(APP.appSecret);
    const result = await login(db, instagram({ user_id: '17841405793187218', username: 'minha.loja', account_type: 'BUSINESS' }));
    expect(result).toEqual({ ok: true });
    const account = await loadAccount(db.admin, USER);
    expect(account).toEqual({ username: 'minha.loja', igUserId: '17841405793187218', expiresAt: 1_800_000_000_000 + 5_184_000_000 });
    expect(JSON.stringify(db.tables)).not.toContain('LONG-TOKEN');
    expect(db.tables['instagram_accounts']?.[0]).toMatchObject({ status: 'connected', user_id: USER });
    expect(db.tables['activity_log']).toHaveLength(1);
  });
  it('answers with a clear reason when something is wrong', async () => {
    const db = fakeAdmin();
    expect(await login(db, instagram({ user_id: '1', username: 'a', account_type: 'BUSINESS' }))).toEqual({ ok: false, code: 'app' });
    await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, instagram({ user_id: '1', username: 'a', account_type: 'PERSONAL' }))).toEqual({ ok: false, code: 'conta_pessoal' });
    expect(await login(db, instagram({ user_id: '1', username: 'a', account_type: 'BUSINESS' }))).toEqual({ ok: true });
    const db2 = fakeAdmin(); await saveAppCredentials(db2.admin, USER, KEY, APP);
    expect(await login(db2, instagram({ user_id: '1', username: 'a', account_type: 'BUSINESS' }, 'instagram_business_basic'))).toEqual({ ok: false, code: 'permissao' });
    expect(await login(db2, instagram({ fail: 500 }))).toEqual({ ok: false, code: 'perfil' });
    expect(await loadAccount(db2.admin, USER)).toBeNull();
  });
  it('replaces the previous token without leaving old secrets behind, and disconnects cleanly', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    const profile = { user_id: '1', username: 'a', account_type: 'MEDIA_CREATOR' };
    await login(db, instagram(profile)); await login(db, instagram(profile));
    expect(db.tables['instagram_accounts']).toHaveLength(1);
    expect(db.tables['connector_secrets']).toHaveLength(2); // the app and one token
    await disconnectAccount(db.admin, USER);
    expect(db.tables['instagram_accounts']).toHaveLength(0);
    expect(db.tables['connector_secrets']).toHaveLength(1);
    await removeAppCredentials(db.admin, USER);
    expect(db.tables['connector_secrets']).toHaveLength(0);
    expect(db.tables['marketplace_connections']).toHaveLength(0);
  });
  it('disconnects the account when a different app is saved', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    await login(db, instagram({ user_id: '1', username: 'a', account_type: 'BUSINESS' }));
    await saveAppCredentials(db.admin, USER, KEY, { ...APP, appSecret: 'ffffffffffffffffffffffffffffffff' }); // same app id: account stays
    expect(await loadAccount(db.admin, USER)).not.toBeNull();
    await saveAppCredentials(db.admin, USER, KEY, { appId: '999999999999999', appSecret: APP.appSecret });
    expect(await loadAccount(db.admin, USER)).toBeNull();
  });

  describe('keeping the 60-day access alive', () => {
    const connected = async (now: number) => { const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP); await login(db, instagram({ user_id: '1', username: 'a', account_type: 'BUSINESS' }), now); return db; };
    const refresher = () => { const fn = vi.fn(async () => json({ access_token: 'RENEWED', expires_in: 5184000 })); return { fn, fetcher: fn as unknown as typeof fetch }; };
    const T0 = 1_800_000_000_000;
    it('does not touch a fresh token', async () => {
      const db = await connected(T0); const { fn, fetcher } = refresher();
      expect(await ensureFreshToken(db.admin, USER, KEY, fetcher, T0 + 5 * DAY)).toEqual({ token: 'LONG-TOKEN', igUserId: '1' });
      expect(fn).not.toHaveBeenCalled();
    });
    it('renews a token that is close to expiring', async () => {
      const db = await connected(T0); const { fn, fetcher } = refresher();
      const result = await ensureFreshToken(db.admin, USER, KEY, fetcher, T0 + 55 * DAY);
      expect(result).toEqual({ token: 'RENEWED', igUserId: '1' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect((await loadAccount(db.admin, USER))?.expiresAt).toBe(T0 + 55 * DAY + 5_184_000_000);
    });
    it('keeps using the old token if the renewal fails, and refuses an expired one', async () => {
      const db = await connected(T0);
      const failing = (async () => json({}, 500)) as unknown as typeof fetch;
      expect((await ensureFreshToken(db.admin, USER, KEY, failing, T0 + 58 * DAY))?.token).toBe('LONG-TOKEN');
      await expect(ensureFreshToken(db.admin, USER, KEY, failing, T0 + 61 * DAY)).rejects.toMatchObject({ code: 'expirado' });
      expect(await ensureFreshToken(fakeAdmin().admin, USER, KEY, failing, T0)).toBeNull();
    });
    it('does not renew twice within 24 hours', async () => {
      const db = await connected(T0); const { fn, fetcher } = refresher();
      expect(await refreshAccount(db.admin, USER, KEY, fetcher, T0 + 3_600_000)).toMatchObject({ refreshed: false });
      expect(fn).not.toHaveBeenCalled();
      expect(await refreshAccount(db.admin, USER, KEY, fetcher, T0 + 2 * DAY)).toMatchObject({ refreshed: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});