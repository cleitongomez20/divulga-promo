import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { automationSettingsSchema } from './automation';
import { AI_PROVIDER_LABELS } from './openai';
import type { AutomationView } from './automation.server';

export type AutomationStatus = AutomationView;
export type AutomationResult = { status: 'ok'; message: string } | { status: 'error'; message: string };

// The generated database types do not know the automation table yet, so this file talks to the database without them.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const getAutomation = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<AutomationStatus> => {
  const { loadAutomationView } = await import('./automation.server');
  return loadAutomationView(await admin(), context.userId, Date.now());
});

/** Turns the automation on or off and saves its options. It only turns on when everything it needs is connected. */
export const saveAutomation = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => automationSettingsSchema.parse(input)).handler(async ({ context, data }): Promise<AutomationResult> => {
    try {
      const db = await admin(); const userId = context.userId;
      if (data.enabled) {
        const { activeProviderReady } = await import('./ai.server');
        const [account, ai, higgs] = await Promise.all([
          db.from('instagram_accounts').select('status').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle(),
          activeProviderReady(db, userId),
          db.from('media_connections').select('status,credential_id').eq('user_id', userId).maybeSingle(),
        ]);
        const ok = (row: unknown, needsCredential: boolean) => { const r = (row ?? null) as Record<string, unknown> | null; return Boolean(r && text(r['status']) === 'connected' && (!needsCredential || text(r['credential_id']))); };
        if (!ok(account.data, false)) return { status: 'error', message: 'Para ligar a automação, conecte o Instagram na tela Conexões.' };
        if (!ai.ready) return { status: 'error', message: `Para ligar a automação, conecte a ${AI_PROVIDER_LABELS[ai.provider]} na tela Conexões.` };
        if (!ok(higgs.data, true)) return { status: 'error', message: 'Para ligar a automação, conecte o Higgsfield na tela Conexões.' };
      }
      const saved = await db.from('automation_settings').upsert({
        user_id: userId, enabled: data.enabled, mode: data.mode, story_after_reel: data.storyAfterReel, retry_after: null,
        last_message: data.enabled ? 'Automação ligada. O primeiro Reels é pedido no próximo horário do dia.' : 'Automação desligada.',
      }, { onConflict: 'user_id' });
      if (saved.error) return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' };
      await db.from('activity_log').insert({ user_id: userId, action: data.enabled ? 'Automação ligada' : 'Automação desligada', result: data.enabled ? (data.mode === 'auto' ? 'Modo totalmente automático' : 'Modo com aprovação') : 'Desligada pelo usuário', details: { mode: data.mode, story_after_reel: data.storyAfterReel } });
      return { status: 'ok', message: data.enabled ? 'Automação ligada.' : 'Automação desligada.' };
    } catch { return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' }; }
  });

/** The "create the next Reels now" button: it ignores the clock, but not the daily target, the failure limit, the approval limit or the spending caps. */
export const planAutomationNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<AutomationResult> => {
  try {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const db = supabaseAdmin as unknown as SupabaseClient; const userId = context.userId;
    const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
    if (!key) return { status: 'error', message: 'O armazenamento seguro ainda não está disponível.' };
    const { data: delay, error: slotError } = await db.rpc('reserve_connector_slot', { p_scope: `auto-now:${userId}`, p_interval_ms: 8000 });
    if (!slotError && typeof delay === 'number' && delay > 0) return { status: 'error', message: 'Aguarde alguns segundos e tente de novo.' };
    const { planNextForUser, loadAutomationView } = await import('./automation.server');
    const { makeLinkFor } = await import('./shopee-link.server');
    const outcome = await planNextForUser(db, { userId, masterKey: key, force: true, makeLink: makeLinkFor(supabaseAdmin, db, userId) });
    if (outcome.created) return { status: 'ok', message: 'Reels pedido. Ele leva alguns minutos e aparece na lista.' };
    const view = await loadAutomationView(db, userId, Date.now());
    const reasons: Record<string, string> = {
      disabled: 'Ligue a automação primeiro.', done: 'A meta de hoje já foi atingida.', pending: 'Há vídeos esperando a sua aprovação.', failures: 'A automação descansa até amanhã por causa das falhas de hoje.',
      busy: 'Outro pedido está em andamento. Aguarde um minuto.', 'no-account': 'Conecte o Instagram primeiro.', backoff: 'A automação está esperando antes de tentar de novo.', error: view.message ?? 'Não foi possível pedir o Reels agora.',
    };
    return { status: 'error', message: reasons[outcome.reason] ?? view.message ?? 'Não foi possível pedir o Reels agora.' };
  } catch { return { status: 'error', message: 'Não foi possível pedir o Reels agora. Tente de novo.' }; }
});