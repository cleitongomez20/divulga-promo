// Server-only transport. Never import this module from a component.
export const SHOPEE_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
export const CONNECTION_QUERY = '{\nbrandOffer{\n    nodes{\n        commissionRate\n        offerName\n    }\n}\n}';
export type Credentials = { appId: string; secret: string };
export type GraphRequest = { query: string; operationName?: string; variables?: Record<string, unknown> };
export type SafeError = { message: string; path: (string | number)[]; extensions: { code: number; message: string } };
export type GraphResult = { ok: true } | { ok: false; errors: SafeError[]; message: string; retryable: boolean; invalidCredentials: boolean };
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
export function translateError(code: number, message: string) {
  switch (code) {
    case 10000: return 'A Shopee teve um problema. Tente de novo mais tarde.';
    case 10010: return 'Não foi possível fazer a consulta. Registramos o problema no histórico.';
    case 10020: return 'Confira seu AppId e Secret e a liberação na Shopee. O horário do servidor também precisa estar correto.';
    case 10030: return 'A Shopee pediu uma pausa. Aguarde um pouco antes de tentar de novo.';
    case 11000: return message || 'A Shopee não conseguiu concluir o pedido.';
    default: return 'Não foi possível conectar à Shopee. Registramos o problema no histórico.';
  }
}
function failure(errors: SafeError[]): GraphResult {
  const first = errors[0];
  const code = first?.extensions.code ?? 0;
  return { ok: false, errors, message: translateError(code, first?.extensions.message || first?.message || ''), retryable: errors.length > 0 && errors.every(e => [10000, 10030].includes(e.extensions.code)), invalidCredentials: errors.some(e => e.extensions.code === 10020) };
}
export type TransportOptions = {
  fetcher?: typeof fetch; now?: () => number; wait?: (milliseconds: number) => Promise<void>;
  acquire: () => Promise<boolean>; slowDown: () => Promise<void>; maxAttempts?: number; retryBaseMs?: number;
};
export class ShopeeConnector implements MarketplaceConnector {
  constructor(private credentials: Credentials, private options: TransportOptions) {}
  async execute(request: GraphRequest): Promise<GraphResult> {
    // This exact string is signed and sent; never serialize again inside the loop.
    const payload = JSON.stringify(request);
    const wait = this.options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const attempts = Math.max(1, Math.min(this.options.maxAttempts ?? 3, 3));
    let result: GraphResult = failure([{ message: 'Sem resposta', path: [], extensions: { code: 10000, message: '' } }]);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!(await this.options.acquire())) return failure([{ message: 'Pausa de segurança', path: [], extensions: { code: 10030, message: '' } }]);
      const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
      try {
        const response = await (this.options.fetcher ?? fetch)(SHOPEE_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: await authorization(this.credentials, timestamp, payload) },
          body: payload, signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (!response.ok) {
          const code = response.status === 429 ? 10030 : response.status >= 500 ? 10000 : response.status === 401 || response.status === 403 ? 10020 : 0;
          result = failure([{ message: `HTTP ${response.status}`, path: [], extensions: { code, message: '' } }]);
        } else {
          const raw: unknown = await response.json();
          if (!raw || typeof raw !== 'object') throw new Error('Invalid response');
          const body = raw as { data?: unknown; errors?: unknown };
          if ('errors' in body) {
            const errors = Array.isArray(body.errors) && body.errors.length ? body.errors : [{}];
            result = failure(errors.map((item: unknown) => {
              const error = item && typeof item === 'object' ? item as Record<string, unknown> : {};
              const ext = error['extensions'] && typeof error['extensions'] === 'object' ? error['extensions'] as Record<string, unknown> : {};
              return { message: redact(error['message'], this.credentials), path: Array.isArray(error['path']) ? error['path'].filter((p): p is string | number => typeof p === 'string' || typeof p === 'number').map(p => typeof p === 'string' ? redact(p, this.credentials) : p) : [], extensions: { code: typeof ext['code'] === 'number' ? ext['code'] : 0, message: redact(ext['message'], this.credentials) } };
            }));
          } else result = body.data && typeof body.data === 'object' ? { ok: true } : failure([{ message: 'Resposta sem dados', path: [], extensions: { code: 0, message: '' } }]);
        }
      } catch {
        // Never log fetch errors: they may contain request headers.
        result = failure([{ message: 'Sem resposta da Shopee', path: [], extensions: { code: 10000, message: '' } }]);
      }
      if (result.ok) return result;
      if (result.errors.some(e => e.extensions.code === 10030)) await this.options.slowDown();
      if (!result.retryable || attempt === attempts - 1) return result;
      await wait((this.options.retryBaseMs ?? 3000) * 2 ** attempt);
    }
    return result;
  }
  testConnection() { return this.execute({ query: CONNECTION_QUERY }); }
}
export class SimulatedMarketplaceConnector implements MarketplaceConnector {
  async testConnection(): Promise<GraphResult> { return { ok: true }; }
}