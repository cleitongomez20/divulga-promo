import { describe, expect, it, vi } from 'vitest';
import { memoryDb, type Rows } from './memory-db';

const state = vi.hoisted(() => ({
  credentials: {
    token: 'SYSTEM-USER-TOKEN',
    igUserId: '17841401258866570',
    pageId: 'PAGE-123',
    pageAccessToken: 'PAGE-ACCESS-TOKEN',
    pageTasks: ['MESSAGING', 'CREATE_CONTENT'],
  } as { token: string; igUserId: string; pageId: string | null; pageAccessToken?: string | null; pageTasks?: string[] } | null,
  expired: false,
  appSecret: 'test-app-secret' as string | null,
  granted: [
    'instagram_manage_comments', 'pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement',
  ] as string[],
}));

vi.mock('@/lib/instagram.server', () => {
  class InstagramError extends Error { constructor(readonly code = 'expirado') { super(code); } }
  return {
    InstagramError,
    getPublishingToken: async () => {
      if (state.expired) throw new InstagramError();
      return state.credentials;
    },
    loadAppCredentials: async () => (state.appSecret ? { appSecret: state.appSecret } : null),
    fetchGrantedPermissions: async () => state.granted,
  };
});

import {
  DEFAULT_TEMPLATE,
  DEFAULT_TRIGGER,
  matchesTrigger,
  normalizeText,
  outcomeMessage,
  outcomeOf,
  parseWebhook,
  verifySignature,
} from '@/lib/comment-reply';
import {
  ReplyError,
  checkReplySetup,
  handleWebhookRequest,
  ingestEvents,
  loadReplyView,
  saveReplySettings,
  sendPending,
  sendPrivateReply,
  subscribeComments,
} from '@/lib/comment-reply.server';
import { META_APP_ID } from '@/lib/instagram';

const USER = 'user-1';
const IG_ID = '17841401258866570';
const PAGE_ID = 'PAGE-123';
const NOW = Date.parse('2026-11-19T15:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Reply = { status?: number; json?: unknown; throws?: boolean };
type Call = { method: string; path: string; search: string; authorization: string | null; body: Record<string, unknown> | undefined };
type Options = { posts?: Rows; events?: Rows; settings?: Rows; accounts?: Rows; replies?: Reply[]; wait?: number };

function queued(extra: Record<string, unknown> = {}) {
  return {
    id: 'event-1', user_id: USER, post_id: 'post-1', comment_id: 'comment-1', author_id: 'person-1',
    author_username: 'ana', status: 'detected', attempts: 0, commented_at: iso(NOW), created_at: iso(NOW),
    updated_at: iso(NOW), sent_at: null, error: null, message_id: null, ...extra,
  };
}

function comment(extra: Record<string, unknown> = {}) {
  return {
    id: 'comment-1', media: { id: 'media-1' }, from: { id: 'person-1', username: 'ana' }, text: 'eu quero', ...extra,
  };
}

function notification(value = comment(), igUserId = IG_ID) {
  return { object: 'instagram', entry: [{ id: igUserId, changes: [{ field: 'comments', value }] }] };
}

function world(options: Options = {}) {
  const calls: Call[] = [];
  const replies = [...(options.replies ?? [])];
  const sleeps: number[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      method: init.method ?? 'GET',
      path: parsed.pathname.replace(/^\/v[\d.]+/, ''),
      search: parsed.search,
      authorization: new Headers(init.headers).get('authorization'),
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    });
    const reply = replies.shift() ?? { json: { message_id: 'message-1', recipient_id: 'person-1' } };
    if (reply.throws) throw new TypeError('network error');
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;

  const built = memoryDb({
    instagram_accounts: options.accounts ?? [{ id: 'account-row', user_id: USER, ig_user_id: IG_ID, page_id: PAGE_ID, status: 'connected' }],
    comment_reply_settings: options.settings ?? [{ user_id: USER, enabled: true, template: 'Oi! Seu link: {link}', last_message: null, last_event_at: null }],
    posts: options.posts ?? [{ id: 'post-1', user_id: USER, ig_media_id: 'media-1', status: 'published', trigger_word: 'EU QUERO', affiliate_link: 'https://shope.ee/produto' }],
    comment_events: options.events ?? [],
    activity_log: [],
  });
  const originalFrom = built.db.from.bind(built.db);
  const db = Object.assign(built.db, {
    rpc: async () => ({ data: options.wait ?? 0, error: null }),
    from: (name: string) => {
      const chain = originalFrom(name) as Record<string, unknown>;
      if (name === 'comment_events') {
        const originalInsert = chain['insert'] as (payload: Record<string, unknown>) => unknown;
        chain['insert'] = (payload: Record<string, unknown>) => originalInsert({
          id: crypto.randomUUID(), created_at: iso(NOW), updated_at: iso(NOW), ...payload,
        });
      }
      return chain;
    },
  });
  const sleep = async (ms: number) => { sleeps.push(ms); };
  return { ...built, db, calls, fetcher, sleeps, sleep };
}

async function sign(body: string, secret = 'test-app-secret') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${signature}`;
}

describe('identificação da frase-gatilho', () => {
  it('normaliza caixa, acentos, pontuação e emojis', () => {
    expect(normalizeText('EU QUERO!!! 😍')).toBe('eu quero');
    expect(matchesTrigger('Eu quero!!! 😍', DEFAULT_TRIGGER)).toBe(true);
    expect(matchesTrigger('quero o link, por favor', 'QUERO O LINK')).toBe(true);
    expect(matchesTrigger('eu queria', DEFAULT_TRIGGER)).toBe(false);
  });

  it('interpreta apenas eventos de comentário do Instagram e preserva os IDs como texto', () => {
    expect(parseWebhook(notification())).toEqual([{
      igUserId: IG_ID, commentId: 'comment-1', mediaId: 'media-1', fromId: 'person-1', username: 'ana', text: 'eu quero', parentId: null,
    }]);
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWebhook(notification({ ...comment(), id: 18000000000000000 }))).toEqual([]);
  });
});

describe('assinatura do webhook', () => {
  it('aceita somente a assinatura HMAC correta do corpo recebido', async () => {
    const body = JSON.stringify(notification());
    const signature = await sign(body);
    expect(await verifySignature(body, signature, 'test-app-secret')).toBe(true);
    expect(await verifySignature(`${body} `, signature, 'test-app-secret')).toBe(false);
    expect(await verifySignature(body, signature, 'segredo-incorreto')).toBe(false);
    expect(await verifySignature(body, null, 'test-app-secret')).toBe(false);
  });

  it('responde ao desafio de verificação e recusa o token incorreto', async () => {
    const w = world();
    const request = (query: Record<string, string>) => handleWebhookRequest(w.db as never, {
      method: 'GET', query: new URLSearchParams(query), signature: null, rawBody: '', verifyToken: 'verify-me', masterKey: 'key',
    });
    await expect(request({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' }))
      .resolves.toEqual({ status: 200, body: '12345' });
    await expect(request({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' }))
      .resolves.toMatchObject({ status: 403 });
  });
});

describe('resposta privada usando Page Access Token', () => {
  it('envia a resposta pelo endpoint da Página e autentica com Page Access Token', async () => {
    const w = world();
    const result = await sendPrivateReply(w.fetcher, { pageId: PAGE_ID, pageAccessToken: 'PAGE-ONLY-TOKEN', commentId: 'comment-1', text: 'Aqui está o link' });
    expect(result).toEqual({ messageId: 'message-1' });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      method: 'POST', path: `/${PAGE_ID}/messages`, authorization: 'Bearer PAGE-ONLY-TOKEN',
      body: { recipient: { comment_id: 'comment-1' }, message: { text: 'Aqui está o link' } },
    });
  });

  it('não tenta o endpoint do Instagram quando a Página ou o Page Access Token estão ausentes', async () => {
    const w = world();
    await expect(sendPrivateReply(w.fetcher, { pageId: null, pageAccessToken: 'PAGE-TOKEN', commentId: 'c1', text: 'oi' }))
      .rejects.toMatchObject({ outcome: 'permission' });
    await expect(sendPrivateReply(w.fetcher, { pageId: PAGE_ID, pageAccessToken: '', commentId: 'c1', text: 'oi' }))
      .rejects.toMatchObject({ outcome: 'permission' });
    expect(w.calls).toHaveLength(0);
  });

  it('não tenta um segundo endpoint quando a Meta recusa a resposta privada', async () => {
    const w = world({ replies: [{ status: 400, json: { error: { code: 100, message: 'Unsupported request' } } }] });
    await expect(sendPrivateReply(w.fetcher, { pageId: PAGE_ID, pageAccessToken: 'PAGE-TOKEN', commentId: 'c1', text: 'oi' }))
      .rejects.toBeInstanceOf(ReplyError);
    expect(w.calls.map(call => call.path)).toEqual([`/${PAGE_ID}/messages`]);
  });
});

describe('fila de comentários e envio automático', () => {
  it('coloca na fila somente comentários com a frase-gatilho em publicações publicadas', async () => {
    const w = world();
    const events = parseWebhook(notification());
    expect(await ingestEvents(w.db as never, events, { now: () => NOW })).toBe(1);
    expect(w.tables['comment_events']).toHaveLength(1);
    expect(w.tables['comment_events']?.[0]).toMatchObject({ comment_id: 'comment-1', author_username: 'ana', status: 'detected' });
  });

  it('ignora comentário próprio, post não publicado, gatilho diferente e automação desligada', async () => {
    const cases: [Options, Record<string, unknown>][] = [
      [{}, { from: { id: IG_ID, username: 'loja' } }],
      [{ posts: [{ id: 'post-1', user_id: USER, ig_media_id: 'media-1', status: 'scheduled', trigger_word: DEFAULT_TRIGGER }] }, {}],
      [{}, { text: 'lindo produto' }],
      [{ settings: [{ user_id: USER, enabled: false, template: 'Oi {link}' }] }, {}],
    ];
    for (const [options, extra] of cases) {
      const w = world(options);
      expect(await ingestEvents(w.db as never, parseWebhook(notification(comment(extra))), { now: () => NOW })).toBe(0);
      expect(w.tables['comment_events']).toHaveLength(0);
    }
  });

  it('envia mensagem pela Página com Page Access Token e atualiza o evento', async () => {
    const w = world({ events: [queued()] });
    const result = await sendPending(w.db as never, { masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep });
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ path: `/${PAGE_ID}/messages`, authorization: 'Bearer PAGE-ACCESS-TOKEN' });
    expect(w.tables['comment_events']?.[0]).toMatchObject({ status: 'sent', message_id: 'message-1' });
  });

  it('não envia quando falta permissão de tarefa MESSAGING na Página', async () => {
    state.credentials = { ...state.credentials!, pageTasks: ['CREATE_CONTENT'] };
    const w = world({ events: [queued()] });
    const result = await sendPending(w.db as never, { masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep });
    state.credentials = { ...state.credentials!, pageTasks: ['MESSAGING', 'CREATE_CONTENT'] };
    expect(result).toMatchObject({ sent: 0, waiting: 1 });
    expect(w.calls).toHaveLength(0);
    expect(String(w.tables['comment_reply_settings']?.[0]?.['last_message'])).toMatch(/permissão/i);
  });

  it('não envia se o comentário expirou, se a automação está desligada ou se não há link', async () => {
    const expired = world({ events: [queued({ commented_at: iso(NOW - 8 * DAY) })] });
    await sendPending(expired.db as never, { masterKey: 'key', fetcher: expired.fetcher, now: () => NOW, sleep: expired.sleep });
    expect(expired.calls).toHaveLength(0);
    expect(expired.tables['comment_events']?.[0]).toMatchObject({ status: 'expired' });

    const off = world({ events: [queued()], settings: [{ user_id: USER, enabled: false, template: 'Oi {link}' }] });
    await sendPending(off.db as never, { masterKey: 'key', fetcher: off.fetcher, now: () => NOW, sleep: off.sleep });
    expect(off.calls).toHaveLength(0);
    expect(off.tables['comment_events']?.[0]).toMatchObject({ status: 'skipped' });

    const noLink = world({ events: [queued()], posts: [{ id: 'post-1', user_id: USER, affiliate_link: null }] });
    await sendPending(noLink.db as never, { masterKey: 'key', fetcher: noLink.fetcher, now: () => NOW, sleep: noLink.sleep });
    expect(noLink.calls).toHaveLength(0);
    expect(noLink.tables['comment_events']?.[0]).toMatchObject({ status: 'failed' });
  });
});

describe('verificação e inscrição na Página', () => {
  it('verifica permissões, Page token, tarefa e assinatura feed do aplicativo correto', async () => {
    const w = world({ replies: [{ json: { data: [{ id: META_APP_ID, subscribed_fields: ['feed'] }] } }] });
    const check = await checkReplySetup(w.db as never, { userId: USER, masterKey: 'key', fetcher: w.fetcher, now: () => NOW });
    expect(check.permissions).toEqual({
      granted: state.granted,
      missing: [],
      ok: true,
    });
    expect(check.subscription).toEqual({ ok: true, fields: ['feed'] });
    expect(w.calls[0]).toMatchObject({ method: 'GET', path: `/${PAGE_ID}/subscribed_apps`, authorization: 'Bearer PAGE-ACCESS-TOKEN' });
  });

  it('não considera suficiente a assinatura feed de outro aplicativo', async () => {
    const w = world({ replies: [{ json: { data: [{ id: 'OTHER-APP', subscribed_fields: ['feed'] }] } }] });
    const check = await checkReplySetup(w.db as never, { userId: USER, masterKey: 'key', fetcher: w.fetcher, now: () => NOW });
    expect(check.subscription).toEqual({ ok: false, fields: [] });
  });

  it('inscreve a Página no campo feed usando Page Access Token', async () => {
    const w = world();
    await subscribeComments(w.db as never, { userId: USER, masterKey: 'key', fetcher: w.fetcher, now: () => NOW });
    expect(w.calls[0]).toMatchObject({
      method: 'POST', path: `/${PAGE_ID}/subscribed_apps`, search: '?subscribed_fields=feed',
      authorization: 'Bearer PAGE-ACCESS-TOKEN',
    });
  });

  it('informa permissões e tarefas ausentes e recusa conexão expirada', async () => {
    state.granted = ['instagram_manage_comments'];
    state.credentials = { ...state.credentials!, pageAccessToken: null, pageTasks: [] };
    const w = world();
    const check = await checkReplySetup(w.db as never, { userId: USER, masterKey: 'key', fetcher: w.fetcher, now: () => NOW });
    expect(check.permissions.ok).toBe(false);
    expect(check.permissions.missing).toContain('pages_messaging');
    expect(check.permissions.missing).toContain('page_access_token');
    expect(check.permissions.missing).toContain('tarefa_MESSAGING');
    expect(w.calls).toHaveLength(0);

    state.granted = ['instagram_manage_comments', 'pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'pages_read_engagement'];
    state.credentials = { token: 'SYSTEM-USER-TOKEN', igUserId: IG_ID, pageId: PAGE_ID, pageAccessToken: 'PAGE-ACCESS-TOKEN', pageTasks: ['MESSAGING', 'CREATE_CONTENT'] };
    state.expired = true;
    await expect(checkReplySetup(world().db as never, { userId: USER, masterKey: 'key' })).rejects.toMatchObject({ code: 'expirado' });
    state.expired = false;
  });
});

describe('webhook e tela de configuração', () => {
  it('recebe evento assinado, cria o evento e dispara a mensagem privada', async () => {
    const w = world();
    const body = JSON.stringify(notification());
    const result = await handleWebhookRequest(w.db as never, {
      method: 'POST', query: new URLSearchParams(), signature: await sign(body), rawBody: body,
      verifyToken: 'verify-me', masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep,
    });
    expect(result).toEqual({ status: 200, body: 'ok' });
    expect(w.tables['comment_events']).toHaveLength(1);
    expect(w.tables['comment_events']?.[0]).toMatchObject({ status: 'sent', comment_id: 'comment-1' });
    expect(w.calls[0]).toMatchObject({ path: `/${PAGE_ID}/messages`, authorization: 'Bearer PAGE-ACCESS-TOKEN' });
  });

  it('recusa corpo com assinatura incorreta e responde normalmente a eventos sem comentários', async () => {
    const w = world();
    const body = JSON.stringify(notification());
    const invalid = await handleWebhookRequest(w.db as never, {
      method: 'POST', query: new URLSearchParams(), signature: 'sha256=00', rawBody: body,
      verifyToken: 'verify-me', masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep,
    });
    expect(invalid.status).toBe(401);
    const noComment = await handleWebhookRequest(w.db as never, {
      method: 'POST', query: new URLSearchParams(), signature: null,
      rawBody: JSON.stringify({ object: 'instagram', entry: [{ id: IG_ID, changes: [{ field: 'mentions', value: {} }] }] }),
      verifyToken: 'verify-me', masterKey: 'key', fetcher: w.fetcher, now: () => NOW, sleep: w.sleep,
    });
    expect(noComment).toEqual({ status: 200, body: 'ok' });
    expect(w.tables['comment_events']).toHaveLength(0);
  });

  it('carrega o histórico, contadores e mensagem padrão; salva e desliga a automação', async () => {
    const w = world({ events: [
      queued({ status: 'sent', author_username: 'ana' }),
      queued({ id: 'event-2', status: 'detected', comment_id: 'comment-2' }),
      queued({ id: 'event-3', status: 'failed', comment_id: 'comment-3', error: 'Falha de teste' }),
    ] });
    const view = await loadReplyView(w.db as never, USER);
    expect(view).toMatchObject({ enabled: true, template: 'Oi! Seu link: {link}', webhookPath: '/api/public/meta-webhook' });
    expect(view.counts).toEqual({ sent: 1, waiting: 1, failed: 1 });
    expect(view.recent).toHaveLength(3);
    expect(await saveReplySettings(w.db as never, USER, { enabled: false, template: 'Nova mensagem {link}' })).toBe(true);
    expect(w.tables['comment_reply_settings']?.[0]).toMatchObject({ enabled: false, template: 'Nova mensagem {link}' });
    expect(DEFAULT_TEMPLATE).toContain('{link}');
  });
});

describe('classificação de erros da Meta', () => {
  it('diferencia comentário repetido, expirado, bloqueado, permissão e indisponibilidade', () => {
    expect(outcomeOf({ code: 100, subcode: 2534023, status: 400 })).toBe('already');
    expect(outcomeOf({ code: 100, subcode: 2534025, status: 400 })).toBe('expired');
    expect(outcomeOf({ code: 100, subcode: 2534022, status: 400 })).toBe('blocked');
    expect(outcomeOf({ code: 10, subcode: null, status: 403 })).toBe('permission');
    expect(outcomeOf({ code: 2, subcode: null, status: 500 })).toBe('retry');
    expect(outcomeMessage('permission')).toMatch(/permissão/i);
  });
});
