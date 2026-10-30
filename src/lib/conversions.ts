// Client-safe rules for Shopee conversion data. No network or secrets here.
export const MAX_PAGE_SIZE = 500;
export const FRESH_QUERY_GAP_MS = 31_000; // queries without scrollId: more than 30s apart
export const SCROLL_TTL_MS = 30_000;
export const WINDOW_DAYS = 7;
export const RECENT_DAYS = 14;
export const DAY_S = 86_400;

export type OrderStatus = 'pending' | 'completed' | 'cancelled';
export type SyncWindow = { field: 'purchase' | 'complete'; start: number; end: number };

// Only fields not marked "To Be Removed" in the official docs.
const NODE_FIELDS = 'purchaseTime clickTime conversionId totalCommission netCommission shopeeCommissionCapped sellerCommission buyerType utmContent device referrer campaignType orders { orderId orderStatus shopType items { itemId itemName itemPrice actualAmount qty imageUrl shopId shopName itemTotalCommission itemSellerCommission itemSellerCommissionRate itemShopeeCommissionCapped itemShopeeCommissionRate itemNotes channelType attributionType fraudStatus displayItemStatus completeTime modelId } }';

export function buildConversionQuery(window: SyncWindow, scrollId?: string) {
  const start = Math.floor(window.start), end = Math.floor(window.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('Invalid window');
  const prefix = window.field === 'purchase' ? 'purchaseTime' : 'completeTime';
  const args = [`${prefix}Start: ${start}`, `${prefix}End: ${end}`, `limit: ${MAX_PAGE_SIZE}`];
  if (scrollId !== undefined) {
    if (!/^[\w\-=+/.:]{1,512}$/.test(scrollId)) throw new Error('Invalid scrollId');
    args.push(`scrollId: ${JSON.stringify(scrollId)}`);
  }
  return `{\n  conversionReport(${args.join(', ')}) {\n    nodes { ${NODE_FIELDS} }\n    pageInfo { limit hasNextPage scrollId }\n  }\n}`;
}

/** Money arrives as text. Convert to integer cents without floats. */
export function parseMoneyToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  const match = /^(-)?(\d{1,13})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const decimals = (match[3] ?? '').padEnd(3, '0');
  let cents = Number(match[2]) * 100 + Number(decimals.slice(0, 2));
  if (Number(decimals[2]) >= 5) cents += 1;
  return match[1] ? -cents : cents;
}

export function mapOrderStatus(raw: unknown): OrderStatus {
  const s = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
  return 'pending'; // UNPAID, PENDING and anything unknown stay pending
}

export function parseSubIds(utmContent: unknown, separator: string): string[] {
  if (typeof utmContent !== 'string' || !utmContent || !separator) return [];
  return utmContent.split(separator).map(p => p.trim()).filter(Boolean).slice(0, 5).map(p => p.slice(0, 100));
}

const text = (v: unknown, max = 300) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) || null;
const unix = (v: unknown) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null; };
const httpsUrl = (v: unknown) => { const s = text(v, 1000); return s && /^https:\/\//i.test(s) ? s : null; };
const list = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

export type OrderRow = {
  conversion_id: string; external_order_id: string; item_id: string; status: OrderStatus; raw_order_status: string | null;
  fraud_status: string | null; item_notes: string | null; attribution_type: string | null; utm_content: string | null;
  sub_ids: string[]; sub_id: string | null; commission_cents: number; commission: number; conversion_commission_cents: number;
  item_name: string | null; item_image_url: string | null; shop_name: string | null; quantity: number | null;
  ordered_at: string | null; clicked_at: string | null; completed_at: string | null;
};

export function flattenConversions(nodes: unknown, separator: string): OrderRow[] {
  const rows: OrderRow[] = [];
  for (const node of list(nodes)) {
    const conversionId = text(node['conversionId'], 100); if (!conversionId) continue;
    const utm = text(node['utmContent'], 500);
    const subIds = parseSubIds(utm, separator);
    const conversionCents = parseMoneyToCents(node['netCommission']) ?? parseMoneyToCents(node['totalCommission']) ?? 0;
    for (const order of list(node['orders'])) {
      const orderId = text(order['orderId'], 100); if (!orderId) continue;
      for (const item of list(order['items'])) {
        const itemId = [text(item['itemId'], 60) ?? '', text(item['modelId'], 60) ?? ''].join(':');
        const cents = parseMoneyToCents(item['itemTotalCommission']) ?? 0;
        const qty = Number(item['qty']);
        rows.push({
          conversion_id: conversionId, external_order_id: orderId, item_id: itemId, status: mapOrderStatus(order['orderStatus']),
          raw_order_status: text(order['orderStatus'], 30), fraud_status: text(item['fraudStatus'], 30), item_notes: text(item['itemNotes'], 500),
          attribution_type: text(item['attributionType'], 60), utm_content: utm, sub_ids: subIds, sub_id: subIds[0] ?? null,
          commission_cents: cents, commission: cents / 100, conversion_commission_cents: conversionCents,
          item_name: text(item['itemName'], 300), item_image_url: httpsUrl(item['imageUrl']), shop_name: text(item['shopName'], 200),
          quantity: Number.isSafeInteger(qty) ? qty : null, ordered_at: unix(node['purchaseTime']), clicked_at: unix(node['clickTime']), completed_at: unix(item['completeTime']),
        });
      }
    }
  }
  return rows;
}

export function windows(field: SyncWindow['field'], start: number, end: number): SyncWindow[] {
  const out: SyncWindow[] = [];
  for (let s = start; s < end; s += WINDOW_DAYS * DAY_S) out.push({ field, start: s, end: Math.min(end, s + WINDOW_DAYS * DAY_S) });
  return out;
}

export type PlanState = { queue: SyncWindow[]; backfill_queued: boolean; history_days: number; interval_minutes: number; last_periodic_at: string | null; last_reconcile_at: string | null };
/** Decide what to enqueue on a tick. Pure; nowMs in milliseconds. */
export function planQueue(state: PlanState, nowMs: number, oldestPendingMs: number | null) {
  const now = Math.floor(nowMs / 1000);
  const queue = [...state.queue];
  const patch: Partial<PlanState> = {};
  if (!state.backfill_queued) { queue.push(...windows('purchase', now - state.history_days * DAY_S, now)); patch.backfill_queued = true; patch.last_periodic_at = new Date(nowMs).toISOString(); }
  else if (!queue.length && (!state.last_periodic_at || nowMs - Date.parse(state.last_periodic_at) >= state.interval_minutes * 60_000)) {
    queue.push(...windows('purchase', now - RECENT_DAYS * DAY_S, now)); patch.last_periodic_at = new Date(nowMs).toISOString();
  }
  if (!state.last_reconcile_at || nowMs - Date.parse(state.last_reconcile_at) >= DAY_S * 1000) {
    const recentStart = now - RECENT_DAYS * DAY_S;
    if (oldestPendingMs !== null && Math.floor(oldestPendingMs / 1000) < recentStart) queue.push(...windows('purchase', Math.floor(oldestPendingMs / 1000), recentStart));
    queue.push({ field: 'complete', start: now - WINDOW_DAYS * DAY_S, end: now });
    patch.last_reconcile_at = new Date(nowMs).toISOString();
  }
  return { queue, patch };
}

function monthKey(iso: string | null, timeZone: string) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso));
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}
export type SummaryRow = Pick<OrderRow, 'conversion_id' | 'external_order_id' | 'status' | 'fraud_status' | 'commission_cents' | 'conversion_commission_cents' | 'ordered_at' | 'completed_at'>;
export const isFraud = (r: { fraud_status: string | null }) => (r.fraud_status ?? '').toUpperCase() === 'FRAUD';

/** Earnings: completed this month (net, else total); pending apart; cancelled and fraud excluded. */
export function summarizeSales(rows: SummaryRow[], timeZone: string, nowMs: number) {
  const month = monthKey(new Date(nowMs).toISOString(), timeZone);
  let earnedCents = 0, pendingCents = 0;
  const orders = new Set<string>();
  const groups = new Map<string, SummaryRow[]>();
  for (const r of rows) { const g = groups.get(r.conversion_id) ?? []; g.push(r); groups.set(r.conversion_id, g); }
  for (const items of groups.values()) {
    const valid = items.filter(i => !isFraud(i));
    for (const i of valid) if (monthKey(i.ordered_at, timeZone) === month) orders.add(i.external_order_id);
    const buckets = new Set(valid.map(i => i.status));
    const uniform = valid.length === items.length && buckets.size === 1;
    for (const bucket of ['completed', 'pending'] as const) {
      const inBucket = valid.filter(i => i.status === bucket); if (!inBucket.length) continue;
      const itemSum = inBucket.reduce((s, i) => s + i.commission_cents, 0);
      const amount = uniform && buckets.has(bucket) && inBucket[0]!.conversion_commission_cents ? inBucket[0]!.conversion_commission_cents : itemSum;
      const when = bucket === 'completed' ? (inBucket.map(i => i.completed_at).filter(Boolean).sort().pop() ?? inBucket[0]!.ordered_at) : inBucket[0]!.ordered_at;
      if (monthKey(when ?? null, timeZone) !== month) continue;
      if (bucket === 'completed') earnedCents += amount; else pendingCents += amount;
    }
  }
  return { earnedCents, pendingCents, ordersCount: orders.size };
}

export function simulatedRows(nowMs: number): (OrderRow & { id: string })[] {
  const day = 86_400_000;
  const base = { utm_content: null, sub_ids: [], sub_id: null, item_notes: null, item_image_url: null, quantity: 1, clicked_at: null, raw_order_status: null, fraud_status: null };
  return [
    { ...base, id: 's1', conversion_id: 'demo1', external_order_id: 'demo-1', item_id: '1', status: 'completed', commission_cents: 1290, commission: 12.9, conversion_commission_cents: 1290, item_name: 'Organizador de gaveta (exemplo)', shop_name: 'Loja exemplo', attribution_type: 'Pedido na mesma loja', ordered_at: new Date(nowMs - 3 * day).toISOString(), completed_at: new Date(nowMs - day).toISOString() },
    { ...base, id: 's2', conversion_id: 'demo2', external_order_id: 'demo-2', item_id: '2', status: 'pending', commission_cents: 645, commission: 6.45, conversion_commission_cents: 645, item_name: 'Kit potes herméticos (exemplo)', shop_name: 'Loja exemplo', attribution_type: 'Pedido em outra loja', ordered_at: new Date(nowMs - day).toISOString(), completed_at: null },
    { ...base, id: 's3', conversion_id: 'demo3', external_order_id: 'demo-3', item_id: '3', status: 'cancelled', commission_cents: 380, commission: 3.8, conversion_commission_cents: 380, item_name: 'Escova de limpeza (exemplo)', shop_name: 'Loja exemplo', attribution_type: 'Pedido na mesma loja', ordered_at: new Date(nowMs - 2 * day).toISOString(), completed_at: null },
  ];
}

export function attributionLabel(value: string | null) {
  const v = (value ?? '').toLowerCase();
  if (!v) return 'Loja não informada';
  if (v.includes('same') || v.includes('mesma')) return 'Na mesma loja do link';
  if (v.includes('different') || v.includes('other') || v.includes('outra')) return 'Em outra loja';
  return value!;
}
