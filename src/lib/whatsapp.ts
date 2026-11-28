// Regras simples da conexão do WhatsApp (sem acesso à rede), para poderem ser testadas.
export type WhatsAppStatus = 'disconnected' | 'waiting_qr' | 'connected';
export type WhatsAppErrorKind = 'not_configured' | 'auth' | 'network' | 'timeout' | 'server' | 'no_qr';

/** Nome da instância no servidor do WhatsApp: um por usuário, só letras e números. */
export const instanceNameFor = (userId: string) => `dp_${userId.replace(/[^a-zA-Z0-9]/g, '')}`;

/** Traduz o estado que o servidor devolve ("open", "connecting", "close") para o nosso. */
export function stateToStatus(state: string | null | undefined): WhatsAppStatus {
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'waiting_qr';
  return 'disconnected';
}

/** Aceita a imagem do QR com ou sem o prefixo "data:image" e devolve algo que o navegador consegue mostrar. */
export function normalizeQr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('data:image/')) return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
  return /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 100 ? `data:image/png;base64,${value}` : null;
}

/** "5581999999999@s.whatsapp.net" vira "5581999999999". */
export function phoneFromJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const digits = jid.split('@')[0]?.split(':')[0] ?? '';
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/** Mostra só o final do número na tela. */
export const maskPhone = (digits: string | null | undefined) => (digits && digits.length >= 4 ? `•••• ${digits.slice(-4)}` : null);

export function whatsappErrorMessage(kind: WhatsAppErrorKind): string {
  switch (kind) {
    case 'not_configured': return 'O servidor do WhatsApp ainda não foi configurado no app (faltam o endereço e a chave).';
    case 'auth': return 'O servidor do WhatsApp recusou a chave. Confira a chave cadastrada no app.';
    case 'network': return 'Não consegui falar com o servidor do WhatsApp agora. Confira se ele está ligado na Railway e tente de novo.';
    case 'timeout': return 'O servidor do WhatsApp demorou demais para responder. Tente de novo.';
    case 'no_qr': return 'O servidor ainda não gerou o QR code. Aguarde alguns segundos e clique em Conectar de novo.';
    default: return 'O servidor do WhatsApp teve um problema. Tente de novo em instantes.';
  }
}
