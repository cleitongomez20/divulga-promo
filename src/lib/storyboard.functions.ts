import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { formatUsd } from './claude';
import type { StoryboardProduct, StoryboardSummary, StoryboardView } from './storyboard.server';

export type { StoryboardProduct, StoryboardSummary, StoryboardView };
export type StoryboardActionResult = { status: 'ok'; message: string; storyboardId?: string; skipped?: 'done' | 'busy' | null } | { status: 'error'; message: string };

const idSchema = z.object({ id: z.string().uuid() });
const planSchema = z.object({ productId: z.string().uuid(), withSpeech: z.boolean() });
const sceneSchema = z.object({ sceneId: z.string().uuid() });

/** The database, the secret key and the spacing between requests of the same kind, so a double click cannot spend twice. */
async function prepare(userId: string, scope: string, intervalMs: number) {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const db = supabaseAdmin as unknown as SupabaseClient;
  const key = process.env['CONNECTOR_ENCRYPTION_KEY'];
  if (!key) return { error: 'O armazenamento seguro ainda não está disponível.' } as const;
  const { data: delay, error } = await db.rpc('reserve_connector_slot', { p_scope: `${scope}:${userId}`, p_interval_ms: intervalMs });
  if (!error && typeof delay === 'number' && delay > 0) return { error: 'Aguarde alguns segundos e tente de novo.' } as const;
  return { db, key } as const;
}
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }

/** Turns the errors the storyboard code raises into a message the user can read. */
async function explain(error: unknown): Promise<StoryboardActionResult> {
  const { BrainError } = await import('./content-brain.server');
  const { aiErrorMessage } = await import('./ai.server');
  if (error instanceof BrainError) return { status: 'error', message: error.message };
  const aiMessage = aiErrorMessage(error);
  if (aiMessage) return { status: 'error', message: aiMessage };
  return { status: 'error', message: 'Não foi possível concluir agora. Tente de novo.' };
}

export const getStoryboardProducts = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<StoryboardProduct[]> => {
  const { listStoryboardProducts } = await import('./storyboard.server');
  return listStoryboardProducts(await admin(), context.userId);
});

export const getStoryboards = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<StoryboardSummary[]> => {
  const { listStoryboards } = await import('./storyboard.server');
  return listStoryboards(await admin(), context.userId);
});

export const getStoryboard = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth])
  .inputValidator(input => idSchema.parse(input)).handler(async ({ context, data }): Promise<StoryboardView | null> => {
    const { loadStoryboard } = await import('./storyboard.server');
    return loadStoryboard(await admin(), context.userId, data.id);
  });

/** Plans the six scenes with the active AI. It spends only a few text tokens: no image is drawn yet. */
export const planStoryboardNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => planSchema.parse(input)).handler(async ({ context, data }): Promise<StoryboardActionResult> => {
    try {
      const ready = await prepare(context.userId, 'storyboard-plan', 8000);
      if ('error' in ready) return { status: 'error', message: ready.error };
      try {
        const { planStoryboard } = await import('./storyboard.server');
        const planned = await planStoryboard(ready.db, { userId: context.userId, masterKey: ready.key, productId: data.productId, withSpeech: data.withSpeech });
        return { status: 'ok', storyboardId: planned.storyboardId, message: `Storyboard planejado. Custo estimado do texto: ${formatUsd(planned.costMicros)}. Agora gere as imagens.` };
      } catch (error) { return await explain(error); }
    } catch { return { status: 'error', message: 'Não foi possível concluir agora. Tente de novo.' }; }
  });

/** Draws one scene. The screen calls it once per scene, one after the other, so each request stays short. */
export const generateStoryboardScene = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => sceneSchema.parse(input)).handler(async ({ context, data }): Promise<StoryboardActionResult> => {
    try {
      const ready = await prepare(context.userId, 'storyboard-scene', 1500);
      if ('error' in ready) return { status: 'error', message: ready.error };
      try {
        const { generateScene } = await import('./storyboard.server');
        const result = await generateScene(ready.db, { userId: context.userId, masterKey: ready.key, sceneId: data.sceneId });
        if (result.skipped) return { status: 'ok', skipped: result.skipped, message: result.skipped === 'done' ? 'Esta cena já está pronta.' : 'Esta cena já está sendo criada.' };
        return { status: 'ok', skipped: null, message: `Imagem criada. Custo estimado: ${formatUsd(result.costMicros)}.` };
      } catch (error) { return await explain(error); }
    } catch { return { status: 'error', message: 'Não foi possível concluir agora. Tente de novo.' }; }
  });

export const discardStoryboardNow = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => idSchema.parse(input)).handler(async ({ context, data }): Promise<StoryboardActionResult> => {
    try {
      const { discardStoryboard } = await import('./storyboard.server');
      const done = await discardStoryboard(await admin(), context.userId, data.id);
      return done ? { status: 'ok', message: 'Storyboard descartado.' } : { status: 'error', message: 'Não encontrei esse storyboard.' };
    } catch { return { status: 'error', message: 'Não foi possível concluir agora. Tente de novo.' }; }
  });