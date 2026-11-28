import { z } from 'zod';

/** 1 = segunda ... 7 = domingo. */
export const WEEKDAYS = [
  { value: 1, short: 'Seg', long: 'Segunda' }, { value: 2, short: 'Ter', long: 'Terça' }, { value: 3, short: 'Qua', long: 'Quarta' },
  { value: 4, short: 'Qui', long: 'Quinta' }, { value: 5, short: 'Sex', long: 'Sexta' }, { value: 6, short: 'Sáb', long: 'Sábado' }, { value: 7, short: 'Dom', long: 'Domingo' },
] as const;
export const INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_RULES = { enabled: false, categoryId: null, keyword: '', days: [1, 2, 3, 4, 5, 6, 7], windowStart: '06:00', windowEnd: '22:00', intervalMinutes: 30 } as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use um horário no formato 06:00.');
export const groupRulesSchema = z.object({
  groupId: z.string().uuid(),
  enabled: z.boolean(),
  categoryId: z.number({ message: 'Informe o ID da categoria da Shopee.' }).int('Informe o ID da categoria da Shopee.').positive('Informe o ID da categoria da Shopee.').max(2_000_000_000, 'Confira o ID da categoria.').nullable(),
  keyword: z.string().trim().max(60, 'A palavra-chave pode ter até 60 letras.'),
  days: z.array(z.number().int().min(1).max(7)).min(1, 'Escolha pelo menos um dia da semana.').max(7).refine(list => new Set(list).size === list.length, 'Dias repetidos.'),
  windowStart: time, windowEnd: time,
  intervalMinutes: z.number().int().min(5, 'O intervalo mínimo é 5 minutos.').max(60, 'O intervalo máximo é 60 minutos.'),
}).strict()
  .refine(r => r.windowStart < r.windowEnd, { message: 'O horário final precisa ser depois do inicial.', path: ['windowEnd'] })
  .refine(r => !r.enabled || r.categoryId !== null || r.keyword.length > 0, { message: 'Para postar neste grupo, informe uma categoria ou uma palavra-chave.', path: ['categoryId'] });
export type GroupRulesInput = z.infer<typeof groupRulesSchema>;

/** Resumo curto das regras, para mostrar na lista. */
export function describeRules(r: { enabled: boolean; days: number[]; windowStart: string; windowEnd: string; intervalMinutes: number }): string {
  if (!r.enabled) return 'Pausado';
  const days = r.days.length === 7 ? 'todos os dias' : WEEKDAYS.filter(d => r.days.includes(d.value)).map(d => d.short).join(', ');
  return `A cada ${r.intervalMinutes} min, ${r.windowStart} às ${r.windowEnd}, ${days}`;
}
