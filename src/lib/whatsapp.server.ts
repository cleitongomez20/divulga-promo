// Conversa com o servidor da Evolution API (rodando na Railway). A chave nunca sai daqui.
import { normalizeQr, phoneFromJid, type WhatsAppErrorKind } from './whatsapp';

export class WhatsAppError extends Error {
  constructor(public kind: WhatsAppErrorKind) { super(kind); }
}

export function isWhatsAppConfigured() {
  return Boolean(process.env['EVOLUTION_API_URL'] && process.env['EVOLUTION_API_KEY']);
}

function config() {
  const raw = process.env['EVOLUTION_API_URL']?.trim(); const key = process.env['EVOLUTION_API_KEY']?.trim();
  if (!raw || !key) throw new WhatsAppError('not_configured');
  let url: URL;
  try { url = new URL(raw); } catch { throw new WhatsAppError('not_configured'); }
  if (url.protocol !== 'https:') throw new WhatsAppError('not_configured');
  return { base: url.origin, key };
}

type Reply = { status: number; json: Record<string, unknown> | unknown[] | null };

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Reply> {
  const { base, key } = config();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method, headers: { apikey: key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new WhatsAppError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network');
  }
  if (response.status === 401 || response.status === 403) throw new WhatsAppError('auth');
  let json: Reply['json'] = null;
  try { json = (await response.json()) as Reply['json']; } catch { json = null; }
  if (response.status >= 500) throw new WhatsAppError('server');
  return { status: response.status, json };
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const qrFrom = (json: Reply['json']) => { const o = obj(json); return normalizeQr(o['base64'] ?? obj(o['qrcode'])['base64']); };

/** Diz se a instância existe no servidor e em que estado está. */
export async function getInstanceState(name: string): Promise<{ exists: boolean; state: string | null }> {
  const { status, json } = await call('GET', `/instance/connectionState/${encodeURIComponent(name)}`);
  if (status === 404) return { exists: false, state: null };
  if (status >= 400) throw new WhatsAppError('server');
  const o = obj(json); const state = obj(o['instance'])['state'] ?? o['state'];
  return { exists: true, state: typeof state === 'string' ? state : null };
}

/** Cria a instância e já devolve o primeiro QR code (pode vir vazio; nesse caso use fetchQr). */
export async function createInstance(name: string): Promise<string | null> {
  const { status, json } = await call('POST', '/instance/create', { instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: true });
  if (status >= 400) throw new WhatsAppError('server');
  return qrFrom(json);
}

/** Pede um QR code novo (ele vence em poucos segundos). */
export async function fetchQr(name: string): Promise<string | null> {
  const { status, json } = await call('GET', `/instance/connect/${encodeURIComponent(name)}`);
  if (status >= 400) throw new WhatsAppError('server');
  return qrFrom(json);
}

/** Número e nome do perfil do WhatsApp conectado (se o servidor informar). */
export async function fetchOwner(name: string): Promise<{ phone: string | null; profileName: string | null }> {
  try {
    const { status, json } = await call('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`);
    if (status >= 400) return { phone: null, profileName: null };
    const first = Array.isArray(json) ? obj(json[0]) : obj(json);
    const inner = obj(first['instance']);
    const profile = first['profileName'] ?? inner['profileName'];
    return { phone: phoneFromJid(first['ownerJid'] ?? inner['owner'] ?? first['number']), profileName: typeof profile === 'string' && profile.trim() ? profile.trim().slice(0, 80) : null };
  } catch { return { phone: null, profileName: null }; }
}

/** Desconecta o aparelho e apaga a instância. Se ela já não existir, tudo bem. */
export async function removeInstance(name: string): Promise<void> {
  const safe = encodeURIComponent(name);
  try { await call('DELETE', `/instance/logout/${safe}`); } catch (error) { if (error instanceof WhatsAppError && error.kind === 'not_configured') throw error; }
  const { status } = await call('DELETE', `/instance/delete/${safe}`);
  if (status >= 400 && status !== 404) throw new WhatsAppError('server');
}
