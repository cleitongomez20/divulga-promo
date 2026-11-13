import { z } from 'zod';

/**
 * Models offered in the app, with list prices in US dollars per million tokens.
 * Model IDs: OpenAI's model catalog (developers.openai.com), checked on 2026-11-12.
 * GPT-6.1 Terra: $1 in / $5 out, as published with its release (2026-10-26). Sol and Luna: price comparison sites of 2026-11; review this table
 * on OpenAI's pricing page whenever prices change. Because a token costs (price per million) micro-dollars, the cost in micro-dollars is tokens x price.
 */
export const OPENAI_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna: o mais econômico', inputPerMTok: 0.1, outputPerMTok: 0.5 },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra: recomendado', inputPerMTok: 1, outputPerMTok: 5 },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol: o mais capaz', inputPerMTok: 2, outputPerMTok: 10 },
] as const;
export type OpenAiModelId = (typeof OPENAI_MODELS)[number]['id'];
const MODEL_IDS = OPENAI_MODELS.map(model => model.id) as [OpenAiModelId, ...OpenAiModelId[]];
export const DEFAULT_OPENAI_MODEL: OpenAiModelId = 'gpt-6.1-terra';
/** Above this many input tokens in one request, input costs double and output costs 1.5 times as much. */
const LONG_PROMPT_TOKENS = 272_000;
/** The writing tasks here need little reasoning. "low" is accepted by all three models offered. */
export const REASONING_EFFORT = 'low';
/** The output limit of the Responses API also counts the model's hidden reasoning, so the limit asked for the text gets this extra room. */
export const REASONING_HEADROOM_TOKENS = 1500;

/** Estimated cost in micro-dollars. Cached input is priced as normal input, which errs on the safe side. A model the table does not know is priced like the most expensive one. */
export function estimateOpenAiCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const known = OPENAI_MODELS.find(item => item.id === model) ?? OPENAI_MODELS[2];
  const long = inputTokens > LONG_PROMPT_TOKENS;
  const inRate = long ? known.inputPerMTok * 2 : known.inputPerMTok; const outRate = long ? known.outputPerMTok * 1.5 : known.outputPerMTok;
  return Math.ceil(Math.max(0, inputTokens) * inRate + Math.max(0, outputTokens) * outRate);
}

export const openAiKeySchema = z.string().trim().min(30, 'Cole a chave completa.').max(300, 'A chave está grande demais.')
  .refine(value => !value.startsWith('sk-ant-'), 'Essa é uma chave do Claude. Aqui vai a chave da OpenAI, que começa com sk-.')
  .refine(value => /^sk-[A-Za-z0-9_-]+$/.test(value), 'A chave da OpenAI começa com sk-. Confira se ela foi copiada inteira.');
const modelSchema = z.enum(MODEL_IDS);
/** Empty means no limit (null). A number must be a real amount between US$ 1 and US$ 10,000. */
export const openAiCapSchema = z.number({ message: 'Informe um valor para o teto ou deixe vazio para não ter limite.' })
  .min(1, 'O teto mínimo é US$ 1.').max(10_000, 'O teto máximo é US$ 10.000.').nullable();
export const connectOpenAiSchema = z.object({ apiKey: openAiKeySchema, model: modelSchema, monthlyCapUsd: openAiCapSchema });
export const openAiSettingsSchema = z.object({ model: modelSchema, monthlyCapUsd: openAiCapSchema });
export const aiProviderSchema = z.object({ provider: z.enum(['anthropic', 'openai']) });

export type OpenAiErrorKind = 'auth' | 'permission' | 'quota' | 'rate_limit' | 'overloaded' | 'network' | 'timeout' | 'bad_request' | 'server' | 'cap' | 'not_connected';
export function openAiErrorMessage(kind: OpenAiErrorKind, detail = ''): string {
  switch (kind) {
    case 'auth': return 'A OpenAI recusou a chave. Confira se ela foi copiada inteira e se ainda está ativa na plataforma da OpenAI.';
    case 'permission': return 'Essa chave não tem permissão para usar o modelo escolhido. Confira o acesso do projeto da chave na plataforma da OpenAI.';
    case 'quota': return 'A conta da OpenAI está sem crédito. Adicione saldo na plataforma da OpenAI e tente de novo.';
    case 'rate_limit': return 'A OpenAI pediu para esperar um pouco. Tente de novo em instantes.';
    case 'overloaded': return 'A OpenAI está sobrecarregada agora. Tente de novo em instantes.';
    case 'network': return 'Não consegui falar com a OpenAI agora. Tente de novo.';
    case 'timeout': return 'A OpenAI demorou demais para responder. Tente de novo.';
    case 'bad_request': return `A OpenAI não aceitou o pedido${detail ? ` (${detail.slice(0, 160)})` : ''}.`;
    case 'cap': return 'O teto de gasto do mês na OpenAI foi atingido. Aumente ou apague o teto na tela Conexões para continuar.';
    case 'not_connected': return 'Conecte a OpenAI na tela Conexões primeiro.';
    default: return 'A OpenAI teve um problema do lado dela. Tente de novo.';
  }
}

export const AI_PROVIDER_LABELS = { anthropic: 'Claude', openai: 'OpenAI' } as const;
export type AiProvider = keyof typeof AI_PROVIDER_LABELS;