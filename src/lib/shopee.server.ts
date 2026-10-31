// Server-only transport. Never import this module from a component.
import { Kind, parse } from 'graphql';
export const SHOPEE_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
export const CONNECTION_QUERY = '{ productOfferV2(keyword: "copo", limit: 1, page: 1) { nodes { itemId productName } pageInfo { hasNextPage } } }';
export type Credentials = { appId: string; secret: string };
export type GraphRequest = { query: string; operationName?: string; variables?: Record<string, unknown> };
export type SafeError = { message: string; path: (string | number)[]; extensions: { code: number; message: string } };
export type Diagnostic = { stage: 'antes de enviar' | 'durante o envio' | 'resposta'; errorName: string; detail: string; elapsedMs: number; httpStatus?: number; bodySnippet?: string };
export type GraphFailure = { ok: false; errors: SafeError[]; message: string; retryable: boolean; invalidCredentials: boolean; accountProblem: boolean; awaitingAccess: boolean; diagnostic?: Diagnostic };
export type GraphResult = { ok: true } | GraphFailure;
export type GraphDataResult = { ok: true; data: Record<string, unknown> } | GraphFailure;
export interface MarketplaceConnector { testConnection(): Promise<GraphResult> }

const encoder = new TextEncoder();
export async function signature(credentials: Credentials, timestamp: number, payload: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(credentials.appId + timestamp + payload + credentials.secret));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function authorization(credentials: Credentials, timestamp: number, payload: string) {
  return `SHA256 Credential=${credentials.appId}, Timestamp=${timestamp}, Signature=${await signature(credentials, timestamp, payload)}`;
}
export function redact(value: unknown, credentials: Credentials): string {
  let text = typeof value === 'string' ? value : '';
  // Provider text is untrusted: strip echoed auth/credential values before storing or displaying it.
  text = text.replace(/SHA256\s+Credential=[^\r\n]*/gi, '[credencial removida]').replace(/Signature\s*=\s*[^,\s]+/gi, '[assinatura removida]');
  for (const privateValue of [credentials.secret, credentials.appId]) {
    if (privateValue) text = text.split(privateValue).join('[removido]');
  }
  return text.slice(0, 2000);
}
export const ACCOUNT_PROBLEM_CODES = [10031, 10032, 10033, 10034];
export function translateError(code: number, message: string) {
  switch (code) {
    case 10000: return 'A Shopee teve um problema. Tente de novo mais tarde.';
    case 10010: return 'Não foi possível fazer a consulta. Registramos o problema no histórico.';
    case 10020: return 'Confira seu AppId e Secret e a liberação na Shopee. O horário do servidor também precisa estar correto.';
    case 10030: return 'A Shopee pediu uma pausa. Vamos esperar um pouco e tentar de novo.';
    case 10031: return 'A Shopee negou o acesso. Há um problema na sua conta de afiliado: fale com o suporte da Shopee.';
    case 10032: return 'A Shopee não reconheceu seu cadastro de afiliado. Fale com o suporte da Shopee.';
    case 10033: return 'Sua conta de afiliado na Shopee está congelada. Fale com o suporte da Shopee.';
    case 10034: return 'Sua conta de afiliado na Shopee está bloqueada. Fale com o suporte da Shopee.';
    case 10035: return 'Seu acesso à API da Shopee ainda não foi liberado.';
    case 11000: return message || 'A Shopee não conseguiu concluir o pedido.';
    case 11001: return message ? `A Shopee recusou a consulta: ${message}` : 'A Shopee recusou os dados da consulta.';
    case 11002: return message ? `Problema na vinculação da conta: ${message}` : 'A Shopee encontrou um problema na vinculação da sua conta.';
    default: return 'Não foi possível conectar à Shopee. Registramos o problema no histórico.';
  }
}
function failure(errors: SafeError[]): GraphFailure {
  const first = errors[0];
  const code = first?.extensions.code ?? 0;
  const has = (list: number[]) => errors.some(e => list.includes(e.extensions.code));
  return { ok: false, errors, message: translateError(code, first?.extensions.message || first?.message || ''), retryable: errors.length > 0 && errors.every(e => [10000, 10030].includes(e.extensions.code)), invalidCredentials: has([10020]), accountProblem: has(ACCOUNT_PROBLEM_CODES), awaitingAccess: has([10035]) };
}
export type TransportOptions = {
  fetcher?: typeof fetch; now?: () => number; wait?: (milliseconds: number) => Promise<void>;
  acquire: () => Promise<boolean>; slowDown: () => Promise<void>; maxAttempts?: number; retryBaseMs?: number;
};
const errorName = (e: unknown) => (e && typeof e === 'object' && 'name' in e && typeof e.name === 'string' ? e.name : 'Error').slice(0, 40);
const errorMessage = (e: unknown) => (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : '');
/** Masks an AppId: first 3 and last 2 digits. */
export function maskAppId(appId: string) { return appId.length <= 5 ? '•'.repeat(appId.length) : `${appId.slice(0, 3)}${'•'.repeat(appId.length - 5)}${appId.slice(-2)}`; }
export class ShopeeConnector implements MarketplaceConnector {
  constructor(private credentials: Credentials, private options: TransportOptions) {}
  async execute(request: GraphRequest): Promise<GraphDataResult> {
    try {
      const operations = parse(request.query).definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
      if (operations.length === 0 || (operations.length > 1 && !request.operationName) || (request.operationName && !operations.some(op => op.name?.value === request.operationName))) throw new Error('Invalid operation');
    } catch { return failure([{ message: 'Consulta inválida', path: [], extensions: { code: 10010, message: '' } }]); }
    // This exact string is signed and sent; never serialize again inside the loop.
    const payload = JSON.stringify(request);
    if (encoder.encode(payload).byteLength > 65536) return failure([{ message: 'Consulta muito grande', path: [], extensions: { code: 10010, message: '' } }]);
    const wait = this.options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const attempts = Math.max(1, Math.min(this.options.maxAttempts ?? 3, 3));
    let result: GraphDataResult = failure([{ message: 'Sem resposta', path: [], extensions: { code: 10000, message: '' } }]);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!(await this.options.acquire())) return failure([{ message: 'Pausa de segurança', path: [], extensions: { code: 10030, message: '' } }]);
      const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
      const started = Date.now();
      const elapsed = () => Date.now() - started;
      const fail = (code: number, message: string, diagnostic: Diagnostic) => ({ ...failure([{ message, path: [], extensions: { code, message: '' } }]), diagnostic });
      let auth: string;
      try { auth = await authorization(this.credentials, timestamp, payload); }
      catch (e) { return fail(0, 'Não foi possível preparar o pedido à Shopee', { stage: 'antes de enviar', errorName: errorName(e), detail: redact(errorMessage(e), this.credentials), elapsedMs: elapsed() }); }
      let response: Response;
      try {
        response = await (this.options.fetcher ?? fetch)(SHOPEE_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: payload, signal: AbortSignal.timeout(15000), redirect: 'error',
        });
      } catch (e) {
        // Only the error name and a redacted short message are kept; headers are never logged.
        const name = errorName(e); const detail = redact(errorMessage(e), this.credentials).slice(0, 200);
        const redirectRefused = /redirect/i.test(detail);
        const message = name === 'TimeoutError' || name === 'AbortError' ? 'Tempo esgotado: a Shopee não respondeu em 15 segundos'
          : redirectRefused ? 'A Shopee tentou redirecionar o pedido e recusamos por segurança'
          : 'Falha de rede ou conexão bloqueada até a Shopee';
        result = fail(10000, message, { stage: 'durante o envio', errorName: name, detail, elapsedMs: elapsed() });
        if (redirectRefused) return result;
        response = undefined as never;
      }
      if (response) {
        const text = await response.text().catch(() => '');
        const snippet = redact(text, this.credentials).slice(0, 200);
        if (!response.ok) {
          const code = response.status === 429 ? 10030 : response.status >= 500 ? 10000 : response.status === 401 || response.status === 403 ? 10020 : 0;
          result = fail(code, `A Shopee respondeu com erro HTTP ${response.status}`, { stage: 'resposta', errorName: 'HTTP', detail: `HTTP ${response.status}`, elapsedMs: elapsed(), httpStatus: response.status, bodySnippet: snippet });
        } else {
          let raw: unknown;
          try { raw = JSON.parse(text); } catch { raw = undefined; }
          if (!raw || typeof raw !== 'object') return fail(0, 'A Shopee enviou uma resposta que não é JSON', { stage: 'resposta', errorName: 'NotJSON', detail: 'Resposta não é JSON', elapsedMs: elapsed(), httpStatus: response.status, bodySnippet: snippet });
          const body = raw as { data?: unknown; errors?: unknown };
          if ('errors' in body) {
            const errors = Array.isArray(body.errors) && body.errors.length ? body.errors : [{}];
            result = failure(errors.map((item: unknown) => {
              const error = item && typeof item === 'object' ? item as Record<string, unknown> : {};
              const ext = error['extensions'] && typeof error['extensions'] === 'object' ? error['extensions'] as Record<string, unknown> : {};
              return { message: redact(error['message'], this.credentials), path: Array.isArray(error['path']) ? error['path'].filter((p): p is string | number => typeof p === 'string' || typeof p === 'number').map(p => typeof p === 'string' ? redact(p, this.credentials) : p) : [], extensions: { code: typeof ext['code'] === 'number' ? ext['code'] : 0, message: redact(ext['message'], this.credentials) } };
            }));
          } else result = body.data && typeof body.data === 'object' ? { ok: true, data: body.data as Record<string, unknown> } : failure([{ message: 'Resposta sem dados', path: [], extensions: { code: 0, message: '' } }]);
        }
      }
      if (result.ok) return result;
      if (result.errors.some(e => e.extensions.code === 10030)) await this.options.slowDown();
      if (!result.retryable || attempt === attempts - 1) return result;
      await wait((this.options.retryBaseMs ?? 3000) * 2 ** attempt);
    }
    return result;
  }
  async testConnection(): Promise<GraphResult> { const r = await this.execute({ query: CONNECTION_QUERY }); return r.ok ? { ok: true } : r; }
}
export class SimulatedMarketplaceConnector implements MarketplaceConnector {
  async testConnection(): Promise<GraphResult> { return { ok: true }; }
}