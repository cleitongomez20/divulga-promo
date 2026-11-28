import { describe, expect, it } from 'vitest';
import { describeRules, groupRulesSchema, needsGroupSync } from '@/lib/whatsapp-groups';

const base = { groupId: '0f8c1b6e-3c1a-4d2e-9a77-1b2c3d4e5f60', enabled: true, categoryId: 100017, keyword: '', days: [1, 2, 3], windowStart: '06:00', windowEnd: '22:00', intervalMinutes: 15 };

describe('regras de envio por grupo', () => {
  it('aceita regras válidas', () => { expect(groupRulesSchema.safeParse(base).success).toBe(true); });
  it('exige categoria ou palavra-chave para ativar', () => {
    expect(groupRulesSchema.safeParse({ ...base, categoryId: null }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, categoryId: null, keyword: 'fone' }).success).toBe(true);
    expect(groupRulesSchema.safeParse({ ...base, enabled: false, categoryId: null }).success).toBe(true);
  });
  it('limita o intervalo entre 5 e 60 minutos', () => {
    expect(groupRulesSchema.safeParse({ ...base, intervalMinutes: 4 }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, intervalMinutes: 61 }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, intervalMinutes: 5 }).success).toBe(true);
    expect(groupRulesSchema.safeParse({ ...base, intervalMinutes: 60 }).success).toBe(true);
  });
  it('confere horário e dias', () => {
    expect(groupRulesSchema.safeParse({ ...base, windowStart: '22:00', windowEnd: '06:00' }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, windowStart: '6:00' }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, days: [] }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, days: [1, 1] }).success).toBe(false);
    expect(groupRulesSchema.safeParse({ ...base, days: [8] }).success).toBe(false);
  });
  it('resume as regras', () => {
    expect(describeRules({ enabled: false, days: [1], windowStart: '06:00', windowEnd: '22:00', intervalMinutes: 5 })).toBe('Pausado');
    expect(describeRules({ enabled: true, days: [1, 2, 3, 4, 5, 6, 7], windowStart: '06:00', windowEnd: '22:00', intervalMinutes: 15 })).toBe('A cada 15 min, 06:00 às 22:00, todos os dias');
    expect(describeRules({ enabled: true, days: [1, 5], windowStart: '08:00', windowEnd: '20:00', intervalMinutes: 30 })).toBe('A cada 30 min, 08:00 às 20:00, Seg, Sex');
  });
});

describe('atualização automática dos grupos', () => {
  const now = new Date('2026-11-28T12:00:00Z');
  it('busca quando nunca buscou ou a data é inválida', () => {
    expect(needsGroupSync(null, now)).toBe(true);
    expect(needsGroupSync('lixo', now)).toBe(true);
  });
  it('não busca de novo dentro de 10 minutos', () => {
    expect(needsGroupSync('2026-11-28T11:55:00Z', now)).toBe(false);
  });
  it('busca depois de 10 minutos', () => {
    expect(needsGroupSync('2026-11-28T11:50:00Z', now)).toBe(true);
    expect(needsGroupSync('2026-11-28T10:00:00Z', now)).toBe(true);
  });
  it('busca se a data guardada está no futuro por mais de 1 minuto', () => {
    expect(needsGroupSync('2026-11-28T12:30:00Z', now)).toBe(true);
    expect(needsGroupSync('2026-11-28T12:00:30Z', now)).toBe(false);
  });
});
