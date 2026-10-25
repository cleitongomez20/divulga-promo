import { z } from 'zod';

export const publicationDefaults = {
  timezone: 'America/Sao_Paulo', products_per_day: 3, daily_post_limit: 6,
  window_start: '08:00', window_end: '22:00', min_interval_minutes: 45,
  story_delay_min_hours: 1, story_delay_max_hours: 8, warmup_initial_days: 3,
  warmup_initial_limit: 1, warmup_second_end_day: 7, warmup_second_limit: 2,
  repeat_days: 14, max_attempts: 3, min_images: 3,
};
export const settingsSchema = z.object({
  name: z.string().trim().max(100),
  timezone: z.string().refine(value => { try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }); return true; } catch { return false; } }, 'Escolha um fuso válido.'),
  products_per_day: z.number().int().min(1).max(100), daily_post_limit: z.number().int().min(1).max(200),
  window_start: z.string().regex(/^\d{2}:\d{2}$/), window_end: z.string().regex(/^\d{2}:\d{2}$/),
  min_interval_minutes: z.number().int().min(1).max(1440), story_delay_min_hours: z.number().int().min(1).max(23),
  story_delay_max_hours: z.number().int().min(1).max(23), repeat_days: z.number().int().min(1).max(365),
  max_attempts: z.number().int().min(1).max(10), min_images: z.number().int().min(3).max(20),
}).refine(v => v.window_start < v.window_end && v.story_delay_min_hours <= v.story_delay_max_hours, 'Revise os horários e o atraso do Story.');