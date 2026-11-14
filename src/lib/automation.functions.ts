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
      // The character option is saved on its own: it needs the new column, and a missing column must never stop the automation from being saved.
      const speech = await db.from('automation_settings').update({ storyboard_speech: data.storyboardSpeech }).eq('user_id', userId);
      await db.from('activity_log').insert({ user_id: userId, action: data.enabled ? 'Automação ligada' : 'Automação desligada', result: data.enabled ? (data.mode === 'auto' ? 'Modo totalmente automático' : 'Modo com aprovação') : 'Desligada pelo usuário', details: { mode: data.mode, story_after_reel: data.storyAfterReel } });
      if (speech.error) return { status: 'ok', message: `${data.enabled ? 'Automação ligada.' : 'Automação desligada.'} A opção do personagem só vale depois de rodar o SQL novo no Supabase.` };
      return { status: 'ok', message: data.enabled ? 'Automação ligada.' : 'Automação desligada.' };
    } catch { return { status: 'error', message: 'Não foi possível salvar agora. Tente de novo.' }; }
  });