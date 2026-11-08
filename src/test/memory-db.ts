// Small in-memory stand-in for the database client, used by tests that need real reads and writes (filters, order, limit, update, upsert, delete).
export type Rows = Record<string, unknown>[];
export function memoryDb(seed: Record<string, Rows>) {
  const tables: Record<string, Rows> = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
  const from = (name: string) => {
    const all = () => (tables[name] ??= []);
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: unknown; let order: { col: string; asc: boolean } | null = null; let max: number | null = null; let head = false; let counting = false; let key = '';
    const hits = () => all().filter(row => filters.every(test => test(row)));
    const run = () => {
      if (op === 'insert') { all().push(...(Array.isArray(payload) ? payload : [payload]).map(row => ({ ...(row as object) }))); return { data: null, error: null }; }
      if (op === 'upsert') { const row = { ...(payload as Record<string, unknown>) }; const found = all().find(r => r[key] === row[key]); if (found) Object.assign(found, row); else all().push(row); return { data: null, error: null }; }
      if (op === 'update') { const touched = hits(); touched.forEach(row => Object.assign(row, payload)); return { data: touched.map(row => ({ ...row })), error: null }; }
      if (op === 'delete') { const gone = new Set(hits()); tables[name] = all().filter(row => !gone.has(row)); return { data: null, error: null }; }
      let found = hits();
      if (order) { const { col, asc } = order; found = [...found].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
      if (max !== null) found = found.slice(0, max);
      return { data: head ? null : found.map(row => ({ ...row })), count: counting ? hits().length : null, error: null };
    };
    const chain: Record<string, unknown> = {
      select: (_cols?: string, options?: { count?: string; head?: boolean }) => { if (options?.count) counting = true; if (options?.head) head = true; return chain; },
      eq: (col: string, value: unknown) => { filters.push(row => row[col] === value); return chain; },
      neq: (col: string, value: unknown) => { filters.push(row => row[col] !== value); return chain; },
      in: (col: string, values: unknown[]) => { filters.push(row => values.includes(row[col])); return chain; },
      lte: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) <= value); return chain; },
      gte: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) >= value); return chain; },
      lt: (col: string, value: string) => { filters.push(row => typeof row[col] === 'string' && (row[col] as string) < value); return chain; },
      order: (col: string, options?: { ascending?: boolean }) => { order = { col, asc: options?.ascending !== false }; return chain; },
      limit: (count: number) => { max = count; return chain; },
      maybeSingle: async () => { const { data } = run(); return { data: (data as Rows | null)?.[0] ?? null, error: null }; },
      insert: (rows: unknown) => { op = 'insert'; payload = rows; return chain; },
      upsert: (row: unknown, options?: { onConflict?: string }) => { op = 'upsert'; payload = row; key = options?.onConflict ?? 'id'; return chain; },
      update: (values: unknown) => { op = 'update'; payload = values; return chain; },
      delete: () => { op = 'delete'; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return chain;
  };
  const storage = { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }) }) };
  return { tables, db: { from, storage } };
}