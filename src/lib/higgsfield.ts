import { z } from 'zod';

export const HF_BASE_URL = 'https://api.higgsfield.ai';
/** Budgeting estimate per generated image (Ads Studio, as published by Higgsfield). The real charge varies and is shown in the Higgsfield Console. */
export const ESTIMATED_IMAGE_USD = 0.084;
export const estimatedImageMicros = (images: number) => Math.round(ESTIMATED_IMAGE_USD * 1_000_000 * Math.max(0, images));
export const DEFAULT_HF_CAP_USD = 10;

/** The key ID and the secret are separate values in the Higgsfield Console; neither may hold spaces, quotes or the colon that joins them. */
const credentialPart = (label: string) => z.string().trim().min(8, `Cole o ${label} completo.`).max(300, `O ${label} está grande demais.`)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, `O ${label} tem caracteres que não fazem parte de uma chave. Confira se copiou só o valor.`);
export const hfKeyIdSchema = credentialPart('ID da chave');
export const hfKeySecretSchema = credentialPart('segredo da chave');
const capSchema = z.number({ message: 'Informe o teto de gasto mensal.' }).min(1, 'O teto mínimo é US$ 1.').max(10_000, 'O teto máximo é US$ 10.000.');
export const connectHiggsfieldSchema = z.object({ keyId: hfKeyIdSchema, keySecret: hfKeySecretSchema, monthlyCapUsd: capSchema });
export const higgsfieldSettingsSchema = z.object({ monthlyCapUsd: capSchema });

export type HiggsfieldErrorKind = 'auth' | 'balance' | 'invalid' | 'blocked' | 'busy' | 'unavailable' | 'server' | 'network' | 'timeout' | 'cap' | 'not_connected';
export function higgsfieldErrorMessage(kind: HiggsfieldErrorKind, detail = ''): string {
  switch (kind) {
    case 'auth': return 'O Higgsfield recusou a chave. Confira o ID e o segredo, e se a chave ainda está ativa no Console do Higgsfield.';
    case 'balance': return 'A conta do Higgsfield está sem saldo. Adicione saldo no Console do Higgsfield e tente de novo.';
    case 'invalid': return `O Higgsfield não aceitou o pedido${detail ? ` (${detail.slice(0, 160)})` : ''}.`;
    case 'blocked': return 'Esse modelo do Higgsfield está bloqueado por enquanto. Tente de novo mais tarde.';
    case 'busy': return 'O Higgsfield pediu para esperar um pouco. Tente de novo em instantes.';
    case 'unavailable': return 'O Higgsfield está indisponível agora. Tente de novo em instantes.';
    case 'network': return 'Não consegui falar com o Higgsfield agora. Tente de novo.';
    case 'timeout': return 'O Higgsfield demorou demais para responder. Tente de novo.';
    case 'cap': return 'O teto de gasto do Higgsfield no mês foi atingido. Aumente o teto na tela Conexões para continuar.';
    case 'not_connected': return 'Conecte o Higgsfield na tela Conexões primeiro.';
    default: return 'O Higgsfield teve um problema do lado dele. Tente de novo.';
  }
}