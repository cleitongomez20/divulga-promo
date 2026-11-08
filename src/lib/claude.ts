import { z } from 'zod';
import { zonedTimeToUtcIso } from './posts';
import { localDate } from './publishing';

/**
 * Models offered in the app, with list prices in US dollars per million tokens.
 * Source: Anthropic's pricing page as reported on 2026-10; review this table whenever Anthropic changes prices.
 * Because a token costs (price per million) micro-dollars, the cost in micro-dollars is simply tokens x price.
 */
export const CLAUDE_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5: o mais econômico', inputPerMTok: 0.1, outputPerMTok: 0.5 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5: recomendado', inputPerMTok: 2, outputPerMTok: 10 },
  { id: 'claude-opus-5-5', label: 'Opus 5.5: o mais caro', inputPerMTok: 4, outputPerMTok: 20 },
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id'];
const MODEL_IDS = CLAUDE_MODELS.map(model => model.id) as [ClaudeModelId, ...ClaudeModelId[]];
export const DEFAULT_MODEL: ClaudeModelId = 'claude-sonnet-5-5';
export const DEFAULT_CAP_USD = 10;
/** Haiku charges more for prompts above this size. */
const HAIKU_LONG_PROMPT_TOKENS = 100_000;

/** Estimated cost in micro-dollars. A model the table does not know is priced like the most expensive one, to stay on the safe side. */
export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const known = CLAUDE_MODELS.find(item => item.id === model) ?? CLAUDE_MODELS[2];
  const long = known.id === 'claude-haiku-5-5' && inputTokens > HAIKU_LONG_PROMPT_TOKENS;
  const inRate = long ? 0.5 : known.inputPerMTok; const outRate = long ? 2.5 : known.outputPerMTok;
  return Math.ceil(Math.max(0, inputTokens) * inRate + Math.max(0, outputTokens) * outRate);
}
export const capMicros = (capCents: number) => capCents * 10_000;
export const centsOfUsd = (usd: number) => Math.round(usd * 100);
export function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000;
  return `US$ ${dollars.toLocaleString('pt-BR', { minimumFractionDigits: dollars < 0.1 ? 4 : 2, maximumFractionDigits: dollars < 0.1 ? 4 : 2 })}`;
}
/** First instant of the current calendar month in the user's time zone. */
export function monthStartIso(ms: number, timeZone: string): string | null {
  return zonedTimeToUtcIso(`${localDate(ms, timeZone).slice(0, 7)}-01T00:00`, timeZone);
}

export const claudeKeySchema = z.string().trim().min(30, 'Cole a chave completa.').max(300, 'A chave está grande demais.')
  .regex(/^sk-ant-[A-Za-z0-9_-]+$/, 'A chave do Claude começa com sk-ant-. Confira se ela foi copiada inteira.');
const modelSchema = z.enum(MODEL_IDS);
const capSchema = z.number({ message: 'Informe o teto de gasto mensal.' }).min(1, 'O teto mínimo é US$ 1.').max(10_000, 'O teto máximo é US$ 10.000.');
export const connectClaudeSchema = z.object({ apiKey: claudeKeySchema, model: modelSchema, monthlyCapUsd: capSchema });
export const claudeSettingsSchema = z.object({ model: modelSchema, monthlyCapUsd: capSchema });

export type ClaudeErrorKind = 'auth' | 'permission' | 'credit' | 'rate_limit' | 'overloaded' | 'network' | 'timeout' | 'bad_request' | 'server' | 'cap' | 'not_connected';
export function claudeErrorMessage(kind: ClaudeErrorKind, detail = ''): string {
  switch (kind) {
    case 'auth': return 'O Claude recusou a chave. Confira se ela foi copiada inteira e se ainda está ativa no Claude Console.';
    case 'permission': return 'Essa chave não tem permissão para usar o modelo escolhido.';
    case 'credit': return 'A conta do Claude está sem crédito. Adicione saldo no Claude Console e tente de novo.';
    case 'rate_limit': return 'O Claude pediu para esperar um pouco. Tente de novo em instantes.';
    case 'overloaded': return 'O Claude está sobrecarregado agora. Tente de novo em instantes.';
    case 'network': return 'Não consegui falar com o Claude agora. Tente de novo.';
    case 'timeout': return 'O Claude demorou demais para responder. Tente de novo.';
    case 'bad_request': return `O Claude não aceitou o pedido${detail ? ` (${detail.slice(0, 160)})` : ''}.`;
    case 'cap': return 'O teto de gasto do mês foi atingido. Aumente o teto na tela Conexões para continuar.';
    case 'not_connected': return 'Conecte o Claude na tela Conexões primeiro.';
    default: return 'O Claude teve um problema do lado dele. Tente de novo.';
  }
}