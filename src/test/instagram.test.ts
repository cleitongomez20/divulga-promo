import { describe, expect, it } from 'vitest';
import {
  InstagramError,
  buildAuthorizeUrl,
  checkAccount,
  completeInstagramLogin,
  connectOwnAccount,
  discoverAssignedAccounts,
  discoverLinkedPage,
  disconnectAccount,
  exchangeCode,
  fetchGrantedPermissions,
  getPublishingToken,
  loadAccount,
  loadAppCredentials,
  saveAppCredentials,
  signState,
  verifyAccount,
  verifyState,
} from '@/lib/instagram.server';
import {
  CALLBACK_URL,
  GRAPH_VERSION,
  META_APP_ID,
  META_CONFIG_ID,
  REQUIRED_PERMISSIONS,
  REQUIRED_REPLY_PERMISSIONS,
  instagramAppSchema,
  instagramErrorMessage,
  instagramSecretSchema,
  maskId,
  ownAccountSchema,
} from '@/lib/instagram';

const KEY = 'chave-mestra-de-teste-com-tamanho-suficiente';
const USER = '11111111-1111-1111-1111-111111111111';
const IG_ID = '17841401258866570';
const SYSTEM_TOKEN = 'SYSTEM-USER-TOKEN-TEST';
const PAGE_TOKEN = 'PAGE-ACCESS-TOKEN-TEST';
const APP = { appId: '1621449662157910', appSecret: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', configId: META_CONFIG_ID };

const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const asFetch = (fn: (url: string, init: RequestInit) => Response) =>
  (async (url: string | URL, init: RequestInit = {}) => fn(String(url), init)) as unknown as typeof fetch;

function fakeAdmin() {
  const tables: Record<string, Record<string, unknown>[]> = {
    connector_secrets: [], marketplace_connections: [], instagram_accounts: [], activity_log: [],
  };
  let sequence = 0;
  const from = (name: string) => {
    const rows = tables[name] as Record<string, unknown>[];
    let operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let values: Record<string, unknown> = {};
    const filters: [string, unknown][] = [];
    let single: 'one' | 'maybe' | null = null;
    let limit = Infinity;
    let selected = false;
    const run = () => {
      const matches = (row: Record<string, unknown>) => filters.every(([key, value]) => row[key] === value);
      if (operation === 'insert') {
        const row = { id: `id-${++sequence}`, created_at: new Date(1_800_000_000_000 + sequence).toISOString(), ...values };
        rows.push(row);
        return { data: selected ? { ...row } : null, error: null };
      }
      if (operation === 'update') {
        rows.filter(matches).forEach(row => Object.assign(row, values));
        return { data: null, error: null };
      }
      if (operation === 'delete') {
        for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index] as Record<string, unknown>)) rows.splice(index, 1);
        return { data: null, error: null };
      }
      const found = rows.filter(matches).slice(0, limit).map(row => ({ ...row }));
      if (single === 'maybe') return { data: found[0] ?? null, error: null };
      if (single === 'one') return found[0] ? { data: found[0], error: null } : { data: null, error: { message: 'not found' } };
      return { data: found, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => { selected = true; return builder; },
      insert: (payload: Record<string, unknown>) => { operation = 'insert'; values = payload; return builder; },
      update: (payload: Record<string, unknown>) => { operation = 'update'; values = payload; return builder; },
      delete: () => { operation = 'delete'; return builder; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      order: () => builder,
      limit: (amount: number) => { limit = amount; return builder; },
      maybeSingle: () => { single = 'maybe'; return builder; },
      single: () => { single = 'one'; return builder; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (error) { return reject(error); }
      },
    };
    return builder;
  };
  return { admin: { from } as never, tables };
}

const granted = [
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments',
  'pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement',
];

function graphFetch(options: { pages?: unknown[]; accounts?: unknown[]; permissions?: string[]; pageError?: boolean } = {}) {
  const pages = options.pages ?? [{
    id: 'PAGE-123', name: 'Página da Loja', access_token: PAGE_TOKEN,
    tasks: ['MESSAGING', 'CREATE_CONTENT'], instagram_business_account: { id: IG_ID },
  }];
  const accounts = options.accounts ?? [{ id: IG_ID, username: '_cleitosantos_' }];
  return asFetch(url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/oauth/access_token')) return json({ access_token: SYSTEM_TOKEN });
    if (parsed.pathname.endsWith('/me/permissions')) {
      return json({ data: (options.permissions ?? granted).map(permission => ({ permission, status: 'granted' })) });
    }
    if (parsed.pathname.endsWith('/me') && parsed.searchParams.get('fields') === 'client_business_id') return json({ id: 'system-user', client_business_id: 'BUSINESS-1' });
    if (parsed.pathname.endsWith('/me/assigned_instagram_accounts')) return json({ data: accounts });
    if (parsed.pathname.endsWith('/me/accounts')) return options.pageError ? json({ error: { code: 200, message: 'Page access denied' } }, 400) : json({ data: pages });
    if (parsed.pathname.endsWith(`/${IG_ID}`)) return json({ id: IG_ID, username: '_cleitosantos_' });
    return json({ error: { code: 100, message: `Unexpected request: ${parsed.pathname}` } }, 404);
  });
}

describe('configuração da aplicação Meta', () => {
  it('mantém os identificadores públicos e a URL de callback', () => {
    expect(META_APP_ID).toBe('1621449662157910');
    expect(META_CONFIG_ID).toBe('1592981445966230');
    expect(CALLBACK_URL).toBe('https://divulga-promo.lovable.app/api/public/instagram-callback');
    expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('separa permissões de publicação e permissões de Private Reply', () => {
    expect([...REQUIRED_PERMISSIONS]).toEqual(['instagram_basic', 'instagram_content_publish']);
    expect([...REQUIRED_REPLY_PERMISSIONS]).toEqual([
      'instagram_manage_comments', 'pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement',
    ]);
  });

  it('valida credenciais e informa falhas de conexão', () => {
    expect(instagramAppSchema.safeParse(APP).success).toBe(true);
    expect(instagramSecretSchema.safeParse({ appSecret: APP.appSecret }).success).toBe(true);
    expect(instagramSecretSchema.safeParse({ appSecret: 'curto' }).success).toBe(false);
    expect(ownAccountSchema.safeParse({ accessToken: SYSTEM_TOKEN, igUserId: IG_ID }).success).toBe(true);
    expect(instagramErrorMessage('permissao')).toContain('instagram_content_publish');
    expect(instagramErrorMessage('qualquer-coisa')).toContain('Não foi possível');
    expect(maskId('123456789012345')).toBe('123••••••••••45');
  });

  it('monta o endereço do Facebook Login com a configuração correta', () => {
    const url = new URL(buildAuthorizeUrl({ appId: META_APP_ID, configId: META_CONFIG_ID, redirectUri: CALLBACK_URL, state: 'state.assinado' }));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(META_APP_ID);
    expect(url.searchParams.get('config_id')).toBe(META_CONFIG_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state.assinado');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('segurança do state OAuth', () => {
  it('aceita um state assinado e recente e recusa alteração ou expiração', async () => {
    const state = await signState(USER, KEY, 1_000_000);
    expect(await verifyState(state, KEY, 1_060_000)).toBe(USER);
    expect(await verifyState(state, KEY, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(await verifyState(state, 'outra-chave-mestra-qualquer-123456', 1_000_000)).toBeNull();
    expect(await verifyState('inválido', KEY, 1_000_000)).toBeNull();
  });
});

describe('consultas à Graph API', () => {
  it('troca o código OAuth e identifica somente permissões concedidas', async () => {
    const urls: string[] = [];
    const fetcher = asFetch(url => { urls.push(url); return url.includes('/oauth/access_token')
      ? json({ access_token: SYSTEM_TOKEN })
      : json({ data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'pages_show_list', status: 'declined' }] });
    });
    expect(await exchangeCode(fetcher, { appId: '1', appSecret: 'secret', redirectUri: 'https://x/cb', code: 'COD' })).toEqual({ token: SYSTEM_TOKEN });
    expect(await fetchGrantedPermissions(fetcher, SYSTEM_TOKEN)).toEqual(['instagram_basic']);
    expect(urls[0]).toContain(`graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  });

  it('preserva IDs longos ao listar contas atribuídas', async () => {
    const body = '{"data":[{"id":17841401258866570,"username":"_cleitosantos_"}]}';
    const result = await discoverAssignedAccounts(asFetch(() => json(body)), SYSTEM_TOKEN);
    expect(result.accounts).toEqual([{ igUserId: IG_ID, username: '_cleitosantos_' }]);
  });

  it('encontra a Página cujo Instagram profissional corresponde ao ID conectado', async () => {
    const fetcher = graphFetch({ pages: [
      { id: 'WRONG-PAGE', name: 'Outra Página', access_token: 'WRONG-TOKEN', tasks: ['MESSAGING'], instagram_business_account: { id: '17840000000000000' } },
      { id: 'PAGE-123', name: 'Página da Loja', access_token: PAGE_TOKEN, tasks: ['MESSAGING', 'CREATE_CONTENT'], instagram_business_account: { id: IG_ID } },
    ] });
    expect(await discoverLinkedPage(fetcher, SYSTEM_TOKEN, IG_ID)).toEqual({
      pageId: 'PAGE-123', pageName: 'Página da Loja', pageAccessToken: PAGE_TOKEN, pageTasks: ['MESSAGING', 'CREATE_CONTENT'],
    });
  });

  it('não escolhe uma Página que pertence a outra conta do Instagram', async () => {
    const fetcher = graphFetch({ pages: [{ id: 'PAGE-OTHER', access_token: 'OTHER-TOKEN', instagram_business_account: { id: '17840000000000000' } }] });
    expect(await discoverLinkedPage(fetcher, SYSTEM_TOKEN, IG_ID)).toBeNull();
  });

  it('recusa uma Página correspondente sem Page Access Token', async () => {
    const fetcher = graphFetch({ pages: [{ id: 'PAGE-123', instagram_business_account: { id: IG_ID } }] });
    await expect(discoverLinkedPage(fetcher, SYSTEM_TOKEN, IG_ID)).rejects.toMatchObject({ code: 'perfil', detail: { step: 'pagina_sem_token' } });
  });
});

describe('armazenamento e conexão da conta', () => {
  it('conecta a conta própria, grava Page ID e criptografa separadamente os tokens', async () => {
    const db = fakeAdmin();
    const result = await connectOwnAccount({ admin: db.admin, userId: USER, masterKey: KEY, accessToken: SYSTEM_TOKEN, igUserId: IG_ID, fetcher: graphFetch() });
    expect(result).toEqual({ ok: true, username: '_cleitosantos_' });
    expect(await loadAccount(db.admin, USER)).toEqual({ username: '_cleitosantos_', igUserId: IG_ID, pageId: 'PAGE-123', status: 'connected' });
    expect(await getPublishingToken(db.admin, USER, KEY)).toEqual({
      token: SYSTEM_TOKEN, igUserId: IG_ID, pageId: 'PAGE-123', pageAccessToken: PAGE_TOKEN, pageTasks: ['MESSAGING', 'CREATE_CONTENT'],
    });
    const serialized = JSON.stringify(db.tables);
    expect(serialized).not.toContain(SYSTEM_TOKEN);
    expect(serialized).not.toContain(PAGE_TOKEN);
    expect(db.tables['connector_secrets']).toHaveLength(1);
  });

  it('conecta pelo OAuth e também recupera a Página vinculada', async () => {
    const db = fakeAdmin();
    await saveAppCredentials(db.admin, USER, KEY, APP);
    const result = await completeInstagramLogin({ admin: db.admin, userId: USER, masterKey: KEY, code: 'CODE', redirectUri: CALLBACK_URL, fetcher: graphFetch() });
    expect(result).toEqual({ ok: true });
    expect(await getPublishingToken(db.admin, USER, KEY)).toMatchObject({
      token: SYSTEM_TOKEN, igUserId: IG_ID, pageId: 'PAGE-123', pageAccessToken: PAGE_TOKEN,
    });
    expect(await loadAppCredentials(db.admin, USER, KEY)).toEqual(APP);
    expect(JSON.stringify(db.tables)).not.toContain(PAGE_TOKEN);
  });

  it('mantém a conta conectada para publicação mesmo quando não consegue localizar a Página', async () => {
    const db = fakeAdmin();
    const result = await connectOwnAccount({
      admin: db.admin, userId: USER, masterKey: KEY, accessToken: SYSTEM_TOKEN, igUserId: IG_ID,
      fetcher: graphFetch({ pages: [] }),
    });
    expect(result.ok).toBe(true);
    expect(await getPublishingToken(db.admin, USER, KEY)).toMatchObject({ token: SYSTEM_TOKEN, igUserId: IG_ID, pageId: null });
    expect(await getPublishingToken(db.admin, USER, KEY)).not.toHaveProperty('pageAccessToken');
  });

  it('limpa Page ID e credenciais ao desconectar, sem apagar a linha histórica', async () => {
    const db = fakeAdmin();
    await connectOwnAccount({ admin: db.admin, userId: USER, masterKey: KEY, accessToken: SYSTEM_TOKEN, igUserId: IG_ID, fetcher: graphFetch() });
    await disconnectAccount(db.admin, USER);
    expect(db.tables['instagram_accounts']).toHaveLength(1);
    expect(db.tables['instagram_accounts']?.[0]).toMatchObject({ status: 'disconnected', credential_id: null, ig_user_id: null, page_id: null });
    expect(db.tables['connector_secrets']).toHaveLength(0);
    expect(await getPublishingToken(db.admin, USER, KEY)).toBeNull();
  });

  it('marca token expirado quando a validade cadastrada passou', async () => {
    const db = fakeAdmin();
    const { saveConnectedAccount } = await import('@/lib/instagram.server');
    await saveConnectedAccount(db.admin, USER, KEY, {
      igUserId: IG_ID, username: '_cleitosantos_', pageId: 'PAGE-123', token: SYSTEM_TOKEN,
      pageAccessToken: PAGE_TOKEN, pageTasks: ['MESSAGING'], issuedAt: 1000, expiresAt: 2000,
    });
    await expect(getPublishingToken(db.admin, USER, KEY, 3000)).rejects.toMatchObject({ code: 'expirado' });
    expect(InstagramError).toBeDefined();
  });

  it('testa a conexão consultando a conta do Instagram', async () => {
    const db = fakeAdmin();
    await connectOwnAccount({ admin: db.admin, userId: USER, masterKey: KEY, accessToken: SYSTEM_TOKEN, igUserId: IG_ID, fetcher: graphFetch() });
    await expect(checkAccount(db.admin, USER, KEY, graphFetch())).resolves.toEqual({ username: '_cleitosantos_' });
    expect(verifyAccount).toBeDefined();
  });
});
