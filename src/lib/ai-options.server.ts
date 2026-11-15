// Server-only: options the owner sets on the Configurações screen that the AI flows read.
import type { SupabaseClient } from '@supabase/supabase-js';

/** Does the AI make the videos with a speaking character? Read on its own, so a missing column (before the SQL is run) never breaks anything else. Defaults to yes. */
export async function storyboardSpeechOf(db: SupabaseClient, userId: string): Promise<boolean> {
  const result = await db.from('automation_settings').select('storyboard_speech').eq('user_id', userId).maybeSingle();
  if (result.error) return true;
  return ((result.data ?? null) as Record<string, unknown> | null)?.['storyboard_speech'] !== false;
}
