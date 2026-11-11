import { z } from 'zod';
import { isShopeeUrl } from './products';

/** Word the follower comments to receive the link (the automatic reply is built in a later step). */
export const TRIGGER_WORD = 'EU QUERO';
/** Added by the code to every AI caption, never left to the AI. */
export const DISCLOSURE = '#publi · Link de afiliado';
export const CAPTION_MAX = 2200;
export const POOL_SIZE = 12;
/** Prices and availability change: a product collected longer ago than this is not offered to the AI. */
export const MAX_PRODUCT_AGE_DAYS = 30;
export const MIN_RATING = 4;
/** Formats the brain can already finish by itself. Carousel, Story art and Reels need pictures and video made in the next steps. */
export const AI_FORMATS_NOW = ['photo'] as const;

/** Only Shopee image hosts are ever downloaded. */
export const IMAGE_HOST_SUFFIXES = ['susercontent.com', 'shopee.com.br', 'shopee.com', 'shopeemobile.com'] as const;
export function isShopeeImageUrl(value: string): boolean {
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && IMAGE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
}

export type ProductCandidate = {
  id: string; externalId: string; title: string; price: number | null; commission: number | null; sales: number | null; rating: number | null;
  imageUrl: string; url: string; collectedAt: string;
};

/** The products the AI may choose from: recent, with a usable photo and link, well rated, not used lately; the best sellers first. */
export function pickCandidates(products: readonly ProductCandidate[], options: { nowMs: number; recentProductIds: ReadonlySet<string> }): ProductCandidate[] {
  const oldest = options.nowMs - MAX_PRODUCT_AGE_DAYS * 86_400_000;
  return products
    .filter(item => item.title.trim() && isShopeeImageUrl(item.imageUrl) && isShopeeUrl(item.url) && Date.parse(item.collectedAt) >= oldest
      && !options.recentProductIds.has(item.id) && (item.rating === null || item.rating >= MIN_RATING))
    .sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1))
    .slice(0, POOL_SIZE);
}

export function buildPrompt(candidates: readonly ProductCandidate[]): { system: string; user: string } {
  const system = [
    'Você é o estrategista de conteúdo e redator de uma conta brasileira de Instagram que indica produtos da Shopee como afiliada.',
    'Tom: amiga indicando uma descoberta, em português do Brasil, informal, leve e direto. Frases curtas, parágrafos de 1 a 2 linhas, no máximo 3 emojis.',
    '',
    'Sua tarefa: escolher UM produto da lista e escrever a legenda de uma publicação de foto no feed.',
    'Escolha o produto com mais chance de gerar clique e venda: compra por impulso, utilidade fácil de entender, apelo visual, boa comissão e boa prova social.',
    '',
    'Use gatilhos mentais de forma VERDADEIRA: identificação com um problema do dia a dia, curiosidade, benefício claro, simplicidade, prova social em termos gerais (por exemplo "muita gente já levou") e vontade de ter.',
    '',
    'Regras que nunca podem ser quebradas:',
    '- Use somente o que está no nome do produto. Não invente medidas, materiais, funções, marcas, garantias, resultados nem comparações.',
    '- Nunca escreva preço, desconto, porcentagem, número de vendas, nota ou comissão. Esses dados são só para você escolher.',
    '- Nunca crie urgência ou escassez falsa: nada de "últimas unidades", "só hoje", "estoque acabando", "promoção relâmpago" ou prazo.',
    '- Nunca prometa cura, emagrecimento, resultado garantido nem fale de saúde de forma milagrosa.',
    '- Não escreva link, hashtags nem chamada para comentar: o sistema acrescenta isso depois.',
    '',
    'A legenda tem de 3 a 6 linhas curtas. A primeira linha é o gancho, com no máximo 90 caracteres, e precisa prender a atenção.',
    '',
    'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem blocos de código, neste formato:',
    '{"chosen_product_id":"<id exato da lista>","reason":"<por que escolheu este produto, em 1 ou 2 frases, usando só os dados da lista>","angle":"<o ângulo do conteúdo em poucas palavras>","hook":"<a primeira linha da legenda>","caption":"<a legenda completa, que começa com o gancho>","hashtags":["#...","#..."]}',
    'Use de 5 a 10 hashtags em português, relevantes ao produto.',
  ].join('\n');
  const list = candidates.map(item => ({
    id: item.id, nome: item.title, preco_reais: item.price, comissao_percentual: item.commission === null ? null : Math.round(item.commission * 1000) / 10,
    vendas: item.sales, nota: item.rating,
  }));
  return { system, user: `Produtos disponíveis (escolha um):\n${JSON.stringify(list, null, 1)}` };
}

/** Takes the JSON object out of the answer, even if the AI wrapped it in a code block or added a sentence around it. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{'); const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
}

export function normalizeHashtags(values: readonly string[]): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  for (const raw of values) {
    const word = raw.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!/^[\p{L}\p{N}_]{2,40}$/u.test(word)) continue;
    const tag = `#${word}`; const key = tag.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(tag); }
  }
  return result.slice(0, 12);
}

export const aiOutputSchema = z.object({
  chosen_product_id: z.string().min(1),
  reason: z.string().trim().min(10).max(500),
  angle: z.string().trim().min(2).max(120),
  hook: z.string().trim().min(5).max(140),
  caption: z.string().trim().min(40).max(1200),
  hashtags: z.array(z.string()).min(3).max(20),
});
export type AiOutput = z.infer<typeof aiOutputSchema>;

const RULES: { pattern: RegExp; message: string }[] = [
  { pattern: /R\$\s*\d|\d\s*reais|\bpor apenas\b|\bpor só\b/i, message: 'a legenda cita preço' },
  { pattern: /\d\s*%|\bpor cento\b|\bdesconto\b/i, message: 'a legenda cita porcentagem ou desconto' },
  { pattern: /\d[\d.,]*\s*(mil\s+)?(vendas|vendidos|vendidas|compras|avalia)/i, message: 'a legenda cita número de vendas ou avaliações' },
  { pattern: /últim[ao]s?\s+unidades?|\bestoque\b|só hoje|acaba hoje|termina hoje|corre que|rel[âa]mpago|por tempo limitado|poucas unidades|queima de/i, message: 'a legenda cria urgência ou escassez que não pode ser comprovada' },
  { pattern: /\bcura\b|emagrec|milagr|garantid[ao]|100\s*%\s*(eficaz|seguro)|sem efeitos? colaterais?|aprovado pela anvisa/i, message: 'a legenda faz promessa de saúde ou resultado garantido' },
  { pattern: /https?:\/\/|www\.|\.com\b/i, message: 'a legenda tem link' },
  { pattern: /#\p{L}/u, message: 'a legenda tem hashtag (elas vão em campo separado)' },
];
/** Problems found in a caption written by the AI. Empty list means it can be used. */
export function checkCaption(caption: string): string[] {
  return RULES.filter(rule => rule.pattern.test(caption)).map(rule => rule.message);
}

/** The caption as it will be posted: the AI text, then the call to comment, then the affiliate notice, then the hashtags. */
export function assembleCaption(output: Pick<AiOutput, 'caption' | 'hashtags'>): string {
  const tags = normalizeHashtags(output.hashtags).join(' ');
  return [output.caption.trim(), `👉 Comenta ${TRIGGER_WORD} que eu te envio o link!`, DISCLOSURE, tags].filter(Boolean).join('\n\n').slice(0, CAPTION_MAX);
}

export type BrainVerdict = { ok: true; output: AiOutput } | { ok: false; problems: string[] };
/** Reads the AI's answer and checks every rule. The problems are written so they can be sent back to the AI as feedback. */
export function judgeAnswer(text: string, candidateIds: ReadonlySet<string>): BrainVerdict {
  const json = extractJson(text);
  if (!json) return { ok: false, problems: ['a resposta não é um objeto JSON válido'] };
  const parsed = aiOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(issue => `campo ${issue.path.join('.') || 'resposta'}: ${issue.message}`).slice(0, 5) };
  const output = parsed.data;
  const problems: string[] = [];
  if (!candidateIds.has(output.chosen_product_id)) problems.push('o chosen_product_id não é um id da lista');
  problems.push(...checkCaption(`${output.hook}\n${output.caption}`));
  if (normalizeHashtags(output.hashtags).length < 3) problems.push('há menos de 3 hashtags válidas');
  return problems.length ? { ok: false, problems } : { ok: true, output };
}
export const feedbackMessage = (problems: readonly string[]) =>
  `A resposta tem problemas: ${problems.join('; ')}. Corrija e responda de novo SOMENTE com o objeto JSON, respeitando todas as regras.`;

/** First 12 letters and numbers of the publication id. Shopee returns it on every sale from the link, which ties the sale to the publication. */
export const subIdOf = (postId: string) => postId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
