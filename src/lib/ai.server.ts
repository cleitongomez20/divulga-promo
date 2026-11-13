// Server-only: the one door through which the app asks an AI. It sends each question to the provider the user chose (Claude or OpenAI).
// Without a choice saved, the answer comes from Claude, exactly as before. Nothing here spends money by itself: both providers keep their own
// connection checks and spending caps.
import type { SupabaseClient } from '@supabase/supabase-js';
import { claudeErrorMessage } from './claude';
import { ClaudeError, askClaude, type ClaudeReply } from './claude.server';
import { AI_PROVIDER_LABELS, openAiErrorMessage, type AiProvider } from './openai';
import { OpenAiError, askOpenAi } from './openai.server';

type Db = SupabaseClient;
type Row = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

export type AskAiParams = Parameters<typeof askClaude>[1];

/** Which AI creates the content. No saved choice means Claude. */
export async function activeProviderOf(db: Db, userId: string): Promise<AiProvider> {
  const { data } = await db.from('ai_settings').select('active_provider').eq('user_id', userId).maybeSingle();
  return str((data as Row | null)?.['active_provider']) === 'openai' ? 'openai' : 'anthropic';
}

/** The call every part of the app uses to ask the AI something. Same parameters and same kind of answer for both providers. */
export async function askAi(db: Db, p: AskAiParams): Promise<ClaudeReply> {
  return (await activeProviderOf(db, p.userId)) === 'openai' ? askOpenAi(db, p) : askClaude(db, p);
}

/** A message for the user when the error came from one of the AIs, or null when it came from somewhere else. */
export function aiErrorMessage(error: unknown): string | null {
  if (error instanceof ClaudeError) return claudeErrorMessage(error.kind, error.detail);
  if (error instanceof OpenAiError) return openAiErrorMessage(error.kind, error.detail);
  return null;
}

const TABLE: Record<AiProvider, string> = { anthropic: 'ai_connections', openai: 'openai_connections' };
/** Is this provider connected with a key the provider still accepts? */
export async function providerConnected(db: Db, userId: string, provider: AiProvider): Promise<boolean> {
  const { data } = await db.from(TABLE[provider]).select('status,credential_id').eq('user_id', userId).maybeSingle();
  const row = (data ?? null) as Row | null;
  return Boolean(row && str(row['credential_id']) && str(row['status']) === 'connected');
}

export type SwitchResult = { ok: true; provider: AiProvider } | { ok: false; message: string };
/** Chooses which AI creates the content. It only switches to a provider that is connected, so the app is never left with an AI that cannot answer. */
export async function switchProvider(db: Db, userId: string, provider: AiProvider): Promise<SwitchResult> {
  if (!(await providerConnected(db, userId, provider))) {
    return { ok: false, message: `Conecte a ${AI_PROVIDER_LABELS[provider]} e confirme que a conexão está funcionando antes de usá-la.` };
  }
  const saved = await db.from('ai_settings').upsert({ user_id: userId, active_provider: provider }, { onConflict: 'user_id' });
  if (saved.error) return { ok: false, message: 'Não foi possível salvar agora. Tente de novo.' };
  return { ok: true, provider };
}

/** The active provider and whether it is ready to answer: what the screens and the automation check before offering to create content. */
export async function activeProviderReady(db: Db, userId: string): Promise<{ provider: AiProvider; ready: boolean }> {
  const provider = await activeProviderOf(db, userId);
  return { provider, ready: await providerConnected(db, userId, provider) };
}