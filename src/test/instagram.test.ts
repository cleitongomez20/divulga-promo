import { describe, it, expect } from 'vitest';
import {
  InstagramError, signState, verifyState, buildAuthorizeUrl, exchangeCode, fetchGrantedPermissions, discoverAssignedAccounts, verifyAccount,
  completeInstagramLogin, saveAppCredentials, loadAppCredentials, removeAppCredentials, getPublishingToken, checkAccount, loadAccount, disconnectAccount, saveConnectedAccount,
} from '@/lib/instagram.server';
import { instagramAppSchema, instagramSecretSchema, instagramErrorMessage, maskId, REQUIRED_PERMISSIONS, CALLBACK_URL, META_APP_ID, META_CONFIG_ID } from '@/lib/instagram';
import { sealJson, openJson } from '@/lib/secret-box.server';

const KEY = 'chave-mestra-de-teste-com-tamanho-suficiente';
const USER = '11111111-1111-1111-1111-111111111111';
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const asFetch = (fn: (url: string, init: RequestInit) => Response) => (async (url: string | URL, init: RequestInit) => fn(String(url), init)) as unknown as typeof fetch;

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

const APP = { appId: '123456789012345', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', configId: META_CONFIG_ID };

describe('app data and messages', () => {
  it('accepts numeric ids and an alphanumeric secret only', () => {
    expect(instagramAppSchema.safeParse({ ...APP, appId: ' 123456789012345 ' }).success).toBe(true);
    expect(instagramAppSchema.safeParse({ ...APP, appId: '12ab' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ ...APP, appSecret: 'curto' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ ...APP, appSecret: 'abc def ghi jkl mno pqr stu' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ ...APP, configId: 'abc' }).success).toBe(false);
    expect(instagramAppSchema.safeParse({ appId: APP.appId, appSecret: APP.appSecret }).success).toBe(false);
  });
  it('has a plain message for each failure and masks ids', () => {
    expect(instagramErrorMessage('sem_instagram')).toContain('portfólio');
    expect(instagramErrorMessage('permissao')).toContain('instagram_content_publish');
    expect(instagramErrorMessage('qualquer-coisa')).toContain('Não foi possível');
    expect(maskId('123456789012345')).toBe('123••••••••••45');
    expect([...REQUIRED_PERMISSIONS]).toEqual(['instagram_basic', 'instagram_content_publish']);
  });
});

describe('fixed Meta app values', () => {
  it('always returns to the published address and asks only for the secret key', () => {
    expect(CALLBACK_URL).toBe('https://divulga-promo.lovable.app/api/public/instagram-callback');
    expect(instagramAppSchema.safeParse({ appId: META_APP_ID, appSecret: APP.appSecret, configId: META_CONFIG_ID }).success).toBe(true);
    expect(instagramSecretSchema.safeParse({ appSecret: APP.appSecret }).success).toBe(true);
    expect(instagramSecretSchema.safeParse({ appSecret: 'curto' }).success).toBe(false);
    const url = new URL(buildAuthorizeUrl({ appId: META_APP_ID, configId: META_CONFIG_ID, redirectUri: CALLBACK_URL, state: 'S' }));
    expect(url.searchParams.get('client_id')).toBe('1621449662157910');
    expect(url.searchParams.get('config_id')).toBe(META_CONFIG_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
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
    expect(await verifyState(await signState(USER, KEY, 5_000_000), KEY, 1_000_000)).toBeNull();
  });
  it('builds the login address with the configuration, the state and no permission list', () => {
    const url = new URL(buildAuthorizeUrl({ appId: '123456789', configId: '555666777', redirectUri: 'https://app.exemplo/api/public/instagram-callback', state: 'abc.def' }));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('123456789');
    expect(url.searchParams.get('config_id')).toBe('555666777');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.get('state')).toBe('abc.def');
    expect(url.searchParams.get('display')).toBe(false);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.exemplo/api/public/instagram-callback');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('calls to the Meta Graph', () => {
  it('exchanges the code for the system user token with the app id and secret', async () => {
    const urls: string[] = [];
    const fetcher = asFetch(url => { urls.push(url); return json({ access_token: 'SUAT' }); });
    expect(await exchangeCode(fetcher, { appId: '1', appSecret: 's', redirectUri: 'https://x/cb', code: 'COD' })).toEqual({ token: 'SUAT' });
    expect(urls[0]).toContain('graph.facebook.com/v27.0/oauth/access_token');
    expect(urls[0]).toContain('code=COD');
    expect(urls[0]).toContain('client_secret=s');
  });
  it('keeps what Meta says about a failure, with no token or secret in it', async () => {
    const fetcher = asFetch(() => json({ error: { message: 'Invalid verification code format.', type: 'OAuthException', code: 100, error_subcode: 33, fbtrace_id: 'x' } }, 400));
    const error = await exchangeCode(fetcher, { appId: '1', appSecret: 'segredo123', redirectUri: 'https://x', code: 'c' }).catch((e: unknown) => e) as InstagramError;
    expect(error).toBeInstanceOf(InstagramError);
    expect(error.code).toBe('troca');
    expect(error.detail).toMatchObject({ step: 'trocar_codigo', status: 400, meta: { code: 100, subcode: 33, type: 'OAuthException' } });
    expect(JSON.stringify(error.detail)).not.toContain('segredo123');
  });
  it('turns network failures and unreadable answers into typed errors', async () => {
    const bad = [asFetch(() => { throw new Error('rede com segredo123'); }), asFetch(() => json('não é json', 200)), asFetch(() => json({}, 500))];
    for (const fetcher of bad) {
      const error = await exchangeCode(fetcher, { appId: '1', appSecret: 'segredo123', redirectUri: 'x', code: 'c' }).catch((e: unknown) => e) as InstagramError;
      expect(error).toBeInstanceOf(InstagramError);
      expect(error.code).toBe('troca');
      expect(error.message).not.toContain('segredo123');
    }
    await expect(exchangeCode(asFetch(() => json({ nada: true })), { appId: '1', appSecret: 's', redirectUri: 'x', code: 'c' })).rejects.toMatchObject({ code: 'troca' });
  });
  it('lists only the permissions that were granted', async () => {
    const fetcher = asFetch(() => json({ data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'pages_show_list', status: 'granted' }, { permission: 'instagram_content_publish', status: 'declined' }] }));
    expect(await fetchGrantedPermissions(fetcher, 'T')).toEqual(['instagram_basic', 'pages_show_list']);
  });
  it('lists the accounts assigned to the system user and keeps 17-digit ids exact', async () => {
    let seen = '';
    const body = '{"data":[{"id":17841405793187218,"username":"minha.loja"},{"id":"17841400000000001"}]}';
    const result = await discoverAssignedAccounts(asFetch(url => { seen = url; return json(body); }), 'SUAT');
    expect(seen).toContain('/me/assigned_instagram_accounts');
    expect(result.accounts).toEqual([{ igUserId: '17841405793187218', username: 'minha.loja' }, { igUserId: '17841400000000001', username: null }]);
    expect((await discoverAssignedAccounts(asFetch(() => json({ data: [] })), 'T')).accounts).toEqual([]);
  });
  it('asks again when the first answer is an empty list, and connects when the account shows up', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetcher = asFetch(url => url.includes('/me/assigned_instagram_accounts') ? json({ data: ++calls < 3 ? [] : [{ id: '17841405793187218', username: 'minha.loja' }] }) : json({ data: [] }));
    const result = await discoverAssignedAccounts(fetcher, 'T', { extraTries: 3, delayMs: 10, wait: async ms => { waits.push(ms); } });
    expect(result.accounts).toEqual([{ igUserId: '17841405793187218', username: 'minha.loja' }]);
    expect(waits).toEqual([10, 10]);
    expect(result.tries.map(t => t['tentativa'])).toEqual([1, 2, 3]);
  });
  it('asks again without the field list when Meta refuses it', async () => {
    const urls: string[] = [];
    const fetcher = asFetch(url => { urls.push(url); return url.includes('fields=') ? json({ error: { code: 100, message: 'x' } }, 400) : json({ data: [{ id: '1784' }] }); });
    const result = await discoverAssignedAccounts(fetcher, 'T');
    expect(urls).toHaveLength(2);
    expect(result.accounts).toEqual([{ igUserId: '1784', username: null }]);
    expect(result.tries[0]).toMatchObject({ status: 400, fields: 'id,username' });
  });
  it('asks the Instagram account itself to prove the access works', async () => {
    let seen = '';
    expect(await verifyAccount(asFetch(url => { seen = url; return json({ id: '1', username: 'minha.loja' }); }), 'TOK', '17841405793187218')).toEqual({ username: 'minha.loja' });
    expect(seen).toContain('/17841405793187218');
    await expect(verifyAccount(asFetch(() => json({ error: { code: 190, message: 'expired' } }, 400)), 'T', '1')).rejects.toMatchObject({ code: 'perfil', detail: { meta: { code: 190 } } });
  });
});

describe('connecting the account', () => {
  const meta = (options: { permissions?: string[]; accounts?: unknown; manualOk?: boolean; failAt?: 'code' | 'perms' | 'accounts' } = {}) => asFetch(url => {
    const perms = options.permissions ?? ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'public_profile'];
    const accounts = options.accounts ?? [{ id: '17841405793187218', username: 'minha.loja' }];
    if (url.includes('/oauth/access_token')) return options.failAt === 'code' ? json({ error: { code: 100, message: 'bad code' } }, 400) : json({ access_token: 'SYSTEM-USER-TOKEN' });
    if (url.includes('fields=client_business_id')) return json({ client_business_id: '2020202020', id: '9' });
    if (url.includes('/me/permissions')) return options.failAt === 'perms' ? json({}, 500) : json({ data: perms.map(permission => ({ permission, status: 'granted' })) });
    if (url.includes('/me/assigned_instagram_accounts')) return options.failAt === 'accounts' ? json({ error: { code: 200, message: 'denied' } }, 400) : json(typeof accounts === 'string' ? accounts : { data: accounts });
    if (url.includes('/17841401258866570?')) return options.manualOk ? json({ id: '17841401258866570', username: 'cleito' }) : json({ error: { code: 100, message: 'x' } }, 400);
    if (url.includes('/17841405793187218?')) return json({ id: '17841405793187218', username: 'minha.loja' });
    return json({}, 404);
  });
  const login = (db: ReturnType<typeof fakeAdmin>, fetcher: typeof fetch, now = 1_800_000_000_000) => completeInstagramLogin({ admin: db.admin, userId: USER, masterKey: KEY, code: 'COD', redirectUri: 'https://x/cb', fetcher, now, wait: async () => {} });
  const lastLog = (db: ReturnType<typeof fakeAdmin>) => db.tables['activity_log']?.at(-1) as { result: string; details: Record<string, unknown> };

  it('saves the app, connects the account with the system user token and keeps secrets sealed', async () => {
    const db = fakeAdmin();
    await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await loadAppCredentials(db.admin, USER, KEY)).toEqual(APP);
    expect(JSON.stringify(db.tables)).not.toContain(APP.appSecret);
    expect(await login(db, meta())).toEqual({ ok: true });
    expect(await loadAccount(db.admin, USER)).toEqual({ username: 'minha.loja', igUserId: '17841405793187218', pageId: null, status: 'connected' });
    expect(await getPublishingToken(db.admin, USER, KEY)).toEqual({ token: 'SYSTEM-USER-TOKEN', igUserId: '17841405793187218', pageId: null });
    expect(JSON.stringify(db.tables)).not.toContain('SYSTEM-USER-TOKEN');
    expect(db.tables['instagram_accounts']?.[0]).toMatchObject({ status: 'connected', user_id: USER, token_expires_at: null });
    expect(lastLog(db)).toMatchObject({ result: 'Conta conectada', details: { contas_compartilhadas: 1, usuario: 'minha.loja', empresa_cliente: '2020202020' } });
    expect(JSON.stringify(db.tables['activity_log'])).not.toContain('SYSTEM-USER-TOKEN');
  });
  it('keeps a 17-digit account id exact when Meta sends it as a number', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ accounts: '{"data":[{"id":17841405793187218}]}' }))).toEqual({ ok: true });
    expect((await loadAccount(db.admin, USER))?.igUserId).toBe('17841405793187218');
  });
  it('explains what is missing when the configuration lacks permissions', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ permissions: ['instagram_basic'] }))).toEqual({ ok: false, code: 'permissao' });
    expect(lastLog(db).details).toMatchObject({ permissoes: ['instagram_basic'], permissoes_faltando: ['instagram_content_publish'] });
    expect(await loadAccount(db.admin, USER)).toBeNull();
  });
  it('says so when the client shared no Instagram account', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ accounts: [] }))).toEqual({ ok: false, code: 'sem_instagram' });
    expect(lastLog(db).details).toMatchObject({ sonda_id: [{ id: '17841401258866570', ok: false, status: 400 }], contas_compartilhadas: 0, empresa_cliente: '2020202020', tentativas: [{ tentativa: 1, encontradas: 0 }, { tentativa: 2 }, { tentativa: 3 }, { tentativa: 4, encontradas: 0, itens_recebidos: 0, chaves: ['data'] }] });
  });
  it('connects through a known Instagram id when Meta lists nothing but the token can read that account', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ accounts: [], manualOk: true }))).toEqual({ ok: true });
    expect(await loadAccount(db.admin, USER)).toMatchObject({ igUserId: '17841401258866570', username: 'cleito', pageId: null });
    expect(lastLog(db).details).toMatchObject({ modo: 'id_manual', sonda_id: [{ id: '17841401258866570', ok: true }] });
  });
  it('records which step failed, with what Meta answered', async () => {
    const db = fakeAdmin();
    expect(await login(db, meta())).toEqual({ ok: false, code: 'app' });
    await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ failAt: 'code' }))).toEqual({ ok: false, code: 'troca' });
    expect(lastLog(db).details).toMatchObject({ falha: { step: 'trocar_codigo', status: 400, meta: { code: 100 } } });
    expect(await login(db, meta({ failAt: 'accounts' }))).toEqual({ ok: false, code: 'perfil' });
    expect(lastLog(db).details).toMatchObject({ codigo_trocado: true, tentativas: [{ step: 'contas_atribuidas', status: 400, meta: { code: 200 } }, { step: 'contas_atribuidas', status: 400 }] });
    expect((lastLog(db).details['tentativas'] as unknown[]).length).toBe(2); // an error is not retried
    expect(await loadAccount(db.admin, USER)).toBeNull();
  });
  it('still connects when listing permissions fails, because the account search proves the access', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    expect(await login(db, meta({ failAt: 'perms' }))).toEqual({ ok: true });
    expect(lastLog(db).details).toHaveProperty('permissoes_erro');
  });
  it('replaces the previous token without leaving old secrets behind, and disconnects cleanly', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    await login(db, meta()); await login(db, meta());
    expect(db.tables['instagram_accounts']).toHaveLength(1);
    expect(db.tables['connector_secrets']).toHaveLength(2);
    await disconnectAccount(db.admin, USER);
    expect(db.tables['instagram_accounts']).toHaveLength(0);
    expect(db.tables['connector_secrets']).toHaveLength(1);
    await removeAppCredentials(db.admin, USER);
    expect(db.tables['connector_secrets']).toHaveLength(0);
    expect(db.tables['marketplace_connections']).toHaveLength(0);
  });
  it('disconnects the account when a different app is saved, and ignores old data without a configuration id', async () => {
    const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
    await login(db, meta());
    await saveAppCredentials(db.admin, USER, KEY, { ...APP, appSecret: 'ffffffffffffffffffffffffffffffff' });
    expect(await loadAccount(db.admin, USER)).not.toBeNull();
    await saveAppCredentials(db.admin, USER, KEY, { ...APP, appId: '999999999999999' });
    expect(await loadAccount(db.admin, USER)).toBeNull();
    const old = fakeAdmin();
    const id = await sealJson({ appId: '1', appSecret: 's' }, KEY, USER, 'instagram-app');
    old.tables['connector_secrets']!.push({ id: 's1', user_id: USER, ciphertext: id });
    old.tables['marketplace_connections']!.push({ id: 'm1', user_id: USER, marketplace: 'instagram_app', credential_id: 's1' });
    expect(await loadAppCredentials(old.admin, USER, KEY)).toBeNull();
  });

  describe('testing the saved access', () => {
    const connected = async () => { const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP); await login(db, meta()); return db; };
    it('confirms the account and refreshes the username', async () => {
      const db = await connected();
      expect(await checkAccount(db.admin, USER, KEY, asFetch(() => json({ id: '17841405793187218', username: 'novo.nome' })))).toEqual({ username: 'novo.nome' });
      expect((await loadAccount(db.admin, USER))?.username).toBe('novo.nome');
    });
    it('marks the account as expired when Meta rejects the token (code 190)', async () => {
      const db = await connected();
      await expect(checkAccount(db.admin, USER, KEY, asFetch(() => json({ error: { code: 190, message: 'Error validating access token' } }, 400)))).rejects.toMatchObject({ code: 'expirado' });
      expect((await loadAccount(db.admin, USER))?.status).toBe('expired');
    });
    it('keeps the account when the failure is something else', async () => {
      const db = await connected();
      await expect(checkAccount(db.admin, USER, KEY, asFetch(() => json({}, 500)))).rejects.toMatchObject({ code: 'perfil' });
      expect((await loadAccount(db.admin, USER))?.status).toBe('connected');
    });
    it('reports a missing account and refuses an expired token date', async () => {
      await expect(checkAccount(fakeAdmin().admin, USER, KEY, asFetch(() => json({})))).rejects.toMatchObject({ code: 'expirado' });
      const db = fakeAdmin(); await saveAppCredentials(db.admin, USER, KEY, APP);
      await saveConnectedAccount(db.admin, USER, KEY, { igUserId: '1', username: 'a', pageId: '2', token: 'T', issuedAt: 1, expiresAt: 1000 });
      await expect(getPublishingToken(db.admin, USER, KEY, 2000)).rejects.toMatchObject({ code: 'expirado' });
    });
  });
});
