// Server-only: talks to the Instagram content publishing API (create a container, wait for it, publish it). Never import from components.
import { GRAPH_VERSION } from './instagram';
import type { MediaKind, PostFormat } from './posts';
import type { FailureKind } from './publishing';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
type Fetcher = typeof fetch;

export type PublishItem = { url: string; kind: MediaKind };
/** Where a publication is, between the visits of the scheduler. Saved in posts.publish_state. */
export type PublishState =
  | { phase: 'children'; children: string[]; startedAt: number }
  | { phase: 'container'; containerId: string; startedAt: number };

export class PublishError extends Error {
  constructor(readonly kind: FailureKind, readonly detail = '', readonly code: number | null = null) { super(kind); }
}

async function call(fetcher: Fetcher, method: 'GET' | 'POST', path: string, token: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}${path}`);
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'manual' };
  if (method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  else init.body = new URLSearchParams(params);
  let res: Response; let raw: string;
  try { res = await fetcher(url, init); raw = await res.text(); } catch { throw new PublishError('network'); }
  let json: Record<string, unknown> | null = null;
  try {
    // Ids can have 17 digits, more than JavaScript numbers hold exactly, so they are turned into text before reading.
    const parsed: unknown = JSON.parse(raw.replace(/("(?:id|creation_id)"\s*:\s*)(\d{15,})/g, '$1"$2"'));
    json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch { json = null; }
  const error = json?.['error'] && typeof json['error'] === 'object' ? (json['error'] as Record<string, unknown>) : null;
  if (error || !res.ok || !json) {
    const code = typeof error?.['code'] === 'number' ? error['code'] : null;
    const message = typeof error?.['message'] === 'string' ? error['message'].slice(0, 200) : '';
    if (code === 190 || res.status === 401) throw new PublishError('auth', message, code);
    throw new PublishError('meta', message || `status ${res.status}`, code);
  }
  return json;
}
const idOf = (json: Record<string, unknown>) => {
  const id = json['id'];
  if (typeof id === 'string' && id) return id;
  throw new PublishError('meta', 'resposta sem identificador');
};
const withCaption = (params: Record<string, string>, caption: string) => (caption.trim() ? { ...params, caption: caption.trim() } : params);

/** Parameters of a container that is published by itself (photo, Reels, Story). */
export function singleParams(format: PostFormat, item: PublishItem, caption: string): Record<string, string> {
  if (format === 'photo') return withCaption({ image_url: item.url }, caption);
  if (format === 'reel') return withCaption({ media_type: 'REELS', video_url: item.url, share_to_feed: 'true' }, caption);
  if (format === 'story') return item.kind === 'video' ? { media_type: 'STORIES', video_url: item.url } : { media_type: 'STORIES', image_url: item.url };
  throw new PublishError('invalid', 'formato sem container único');
}
/** Parameters of one carousel item (videos keep the VIDEO type inside carousels). */
export function childParams(item: PublishItem): Record<string, string> {
  return item.kind === 'video' ? { media_type: 'VIDEO', video_url: item.url, is_carousel_item: 'true' } : { image_url: item.url, is_carousel_item: 'true' };
}

/** Step 1: asks Instagram to receive the files. A carousel creates one container per item first. */
export async function startPublishing(fetcher: Fetcher, p: { token: string; igUserId: string; format: PostFormat; caption: string; items: PublishItem[]; now: number }): Promise<PublishState> {
  const path = `/${encodeURIComponent(p.igUserId)}/media`;
  if (p.format === 'carousel') {
    const children = await Promise.all(p.items.map(async item => idOf(await call(fetcher, 'POST', path, p.token, childParams(item)))));
    return { phase: 'children', children, startedAt: p.now };
  }
  const item = p.items[0];
  if (!item) throw new PublishError('invalid', 'sem arquivos');
  return { phase: 'container', containerId: idOf(await call(fetcher, 'POST', path, p.token, singleParams(p.format, item, p.caption))), startedAt: p.now };
}
/** Carousel step 2, once every item is ready: the container that holds them all. */
export async function createCarouselContainer(fetcher: Fetcher, p: { token: string; igUserId: string; children: string[]; caption: string; startedAt: number }): Promise<PublishState> {
  const json = await call(fetcher, 'POST', `/${encodeURIComponent(p.igUserId)}/media`, p.token, withCaption({ media_type: 'CAROUSEL', children: p.children.join(',') }, p.caption));
  return { phase: 'container', containerId: idOf(json), startedAt: p.startedAt };
}

export type ContainerStatus = { code: 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED'; detail: string };
export async function containerStatus(fetcher: Fetcher, token: string, containerId: string): Promise<ContainerStatus> {
  const json = await call(fetcher, 'GET', `/${encodeURIComponent(containerId)}`, token, { fields: 'status_code,status' });
  const code = typeof json['status_code'] === 'string' ? json['status_code'] : 'IN_PROGRESS';
  const known = ['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'] as const;
  return { code: (known as readonly string[]).includes(code) ? (code as ContainerStatus['code']) : 'IN_PROGRESS', detail: typeof json['status'] === 'string' ? json['status'].slice(0, 160) : '' };
}
/** Last step: makes the ready container public. Returns the id of the Instagram post. */
export async function publishContainer(fetcher: Fetcher, p: { token: string; igUserId: string; containerId: string }): Promise<string> {
  return idOf(await call(fetcher, 'POST', `/${encodeURIComponent(p.igUserId)}/media_publish`, p.token, { creation_id: p.containerId }));
}