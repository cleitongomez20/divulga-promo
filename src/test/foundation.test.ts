import { describe, expect, it } from 'vitest';
import { publicationDefaults as d, settingsSchema } from '@/lib/foundation';
describe('Publication defaults specified in A6', () => {
  it('uses São Paulo time', () => expect(d.timezone).toBe('America/Sao_Paulo'));
  it('prepares 3 products each day', () => expect(d.products_per_day).toBe(3));
  it('uses the 08h–22h window', () => expect([d.window_start,d.window_end]).toEqual(['08:00','22:00']));
  it('waits at least 45 minutes', () => expect(d.min_interval_minutes).toBe(45));
  it('delays Stories 1–8 hours', () => expect([d.story_delay_min_hours,d.story_delay_max_hours]).toEqual([1,8]));
  it('warms up days 1–3 at 1 post', () => expect([d.warmup_initial_days,d.warmup_initial_limit]).toEqual([3,1]));
  it('warms up days 4–7 at 2 posts', () => expect([d.warmup_second_end_day,d.warmup_second_limit]).toEqual([7,2]));
  it('avoids repeating a product for 14 days', () => expect(d.repeat_days).toBe(14));
  it('allows at most 3 default attempts', () => expect(d.max_attempts).toBe(3));
  it('rejects products with fewer than 3 images', () => expect(settingsSchema.safeParse({ ...d,name:'Owner',min_images:2 }).success).toBe(false));
});