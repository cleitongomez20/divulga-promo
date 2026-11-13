import { describe, expect, it } from 'vitest';
import { memoryDb, type Rows } from './memory-db';
import { capCentsOrNull, capText, capUsdFromText, claudeSettingsSchema, connectClaudeSchema } from '@/lib/claude';
import { higgsfieldSettingsSchema } from '@/lib/higgsfield';
import { askClaude, connectClaudeKey, loadClaudeStatus } from '@/lib/claude.server';
import { credentialsForJob, loadHiggsfieldStatus } from '@/lib/higgsfield.server';
import { sealJson } from '@/lib/secret-box.server';

const NOW = Date.parse('2026-11-13T15:00:00.000Z');
const U = 'user-1';
const MASTER = 'master-key-for-tests';
const CLAUDE_KEY = 'sk-ant-api03-TESTKEY_abcdefghijklmnopqrstuvwxyz0123456789';
const HEAVY = 900_000_000; // micro-dollars: US$ 900 already spent this month

describe('the cap fields are optional', () => {
  it('an empty field means no limit and a typed amount is read with a comma or a dot', () => {
    expect(capUsdFromText('')).toBeNull(); expect(capUsdFromText('   ')).toBeNull();
    expect(capUsdFromText('25')).toBe(25); expect(capUsdFromText('12,5')).toBe(12.5);
    expect(capCentsOrNull(null)).toBeNull(); expect(capCentsOrNull(12.5)).toBe(1250);
    expect(capText(null)).toBe('sem teto de gasto'); expect(capText(10)).toBe('teto mensal de US$ 10');
  });
  it('the schemas accept null and still refuse wrong amounts', () => {
    expect(claudeSettingsSchema.safeParse({ model: 'claude-sonnet-5-5', monthlyCapUsd: null }).success).toBe(true);
    expect(connectClaudeSchema.safeParse({ apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5', monthlyCapUsd: null }).success).toBe(true);
    expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: null }).success).toBe(true);
    for (const bad of [0, 0.5, 20_000, Number.NaN]) {
      expect(claudeSettingsSchema.safeParse({ model: 'claude-sonnet-5-5', monthlyCapUsd: bad }).success).toBe(false);
      expect(higgsfieldSettingsSchema.safeParse({ monthlyCapUsd: bad }).success).toBe(false);
    }
  });
});

const claudeOk = () => ({ json: { type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'end_turn' } });
const fetcher = (async () => new Response(JSON.stringify(claudeOk().json), { status: 200 })) as unknown as typeof fetch;
const claudeDb = async (capCents: number | null) => {
  const built = memoryDb({ settings: [], connector_secrets: [], ai_connections: [], ai_usage: [], activity_log: [] } as Record<string, Rows>);
  await connectClaudeKey(built.db as never, { userId: U, masterKey: MASTER, apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5', capCents, fetcher, now: () => NOW });
  built.tables['ai_usage']!.push({ id: 'big', user_id: U, purpose: 'x', model: 'm', input_tokens: 0, output_tokens: 0, cost_micros: HEAVY, created_at: '2026-11-02T12:00:00.000Z' });
  return built;
};
const ask = (db: unknown) => askClaude(db as never, { userId: U, masterKey: MASTER, purpose: 'legenda', messages: [{ role: 'user', content: 'Oi' }], maxTokens: 100, fetcher, now: () => NOW });

describe('Claude without a cap', () => {
  it('is saved with no cap and reported as no limit', async () => {
    const { tables, db } = await claudeDb(null);
    expect(tables['ai_connections']?.[0]).toMatchObject({ monthly_cap_cents: null });
    expect(await loadClaudeStatus(db as never, U, NOW)).toMatchObject({ connected: true, monthlyCapCents: null });
  });
  it('keeps answering however much was spent', async () => {
    const { db } = await claudeDb(null);
    await expect(ask(db)).resolves.toMatchObject({ text: 'ok' });
  });
  it('still stops at a cap when the user set one', async () => {
    const { db } = await claudeDb(1000);
    await expect(ask(db)).rejects.toMatchObject({ kind: 'cap' });
  });
});

describe('Higgsfield without a cap', () => {
  const hfDb = async (capCents: number | null) => {
    const ciphertext = await sealJson({ keyId: 'a1b2c3d4-e5f6-4789-abcd-0123456789ab', keySecret: 'S3cr3t_VALUE-abcdefghijklmnopqrstuvwxyz012345' }, MASTER, U, 'higgsfield');
    return memoryDb({
      settings: [], connector_secrets: [{ id: 'sec-1', user_id: U, ciphertext, key_version: 1 }],
      media_connections: [{ id: 'c1', user_id: U, provider: 'higgsfield', credential_id: 'sec-1', status: 'connected', monthly_cap_cents: capCents, last_tested_at: null, last_error: null }],
      media_usage: [{ id: 'big', user_id: U, purpose: 'video', model: 'm', cost_micros: HEAVY, created_at: '2026-11-02T12:00:00.000Z' }],
    } as Record<string, Rows>);
  };
  it('is reported as no limit', async () => {
    const { db } = await hfDb(null);
    expect(await loadHiggsfieldStatus(db as never, U, NOW)).toMatchObject({ connected: true, monthlyCapCents: null, spentMicros: HEAVY });
  });
  it('keeps ordering videos however much was spent', async () => {
    const { db } = await hfDb(null);
    await expect(credentialsForJob(db as never, { userId: U, masterKey: MASTER, estimateMicros: 5_000_000, now: () => NOW })).resolves.toBeDefined();
  });
  it('still stops at a cap when the user set one', async () => {
    const { db } = await hfDb(1000);
    await expect(credentialsForJob(db as never, { userId: U, masterKey: MASTER, estimateMicros: 5_000_000, now: () => NOW })).rejects.toMatchObject({ kind: 'cap' });
  });
});