// Server-side helpers shared by /api/logs and /api/logs/export.
// All filtering happens in SQL so the page works on the full fruit_events table, not a sample.

export type LogFilters = {
  from: Date;
  to: Date;
  fruit?: string;
  result?: string;
  defect?: string; // defect code, or 'none' for rows without defect_type
  model?: string;
  camera?: string;
  q?: string; // event_id substring or exact track_id
};

const DAY_MS = 86_400_000;

export function parseFilters(params: URLSearchParams): LogFilters {
  const now = Date.now();
  const toRaw = Date.parse(params.get('to') ?? '');
  const fromRaw = Date.parse(params.get('from') ?? '');
  const to = new Date(Number.isNaN(toRaw) ? now : toRaw);
  let from = new Date(Number.isNaN(fromRaw) ? to.getTime() - DAY_MS : fromRaw);
  if (from >= to) from = new Date(to.getTime() - DAY_MS);
  // Guard against accidental huge scans: at most 366 days.
  if (to.getTime() - from.getTime() > 366 * DAY_MS) from = new Date(to.getTime() - 366 * DAY_MS);
  const pick = (key: string) => {
    const value = params.get(key)?.trim();
    return value && value !== 'all' ? value.slice(0, 80) : undefined;
  };
  return { from, to, fruit: pick('fruit'), result: pick('result'), defect: pick('defect'), model: pick('model'), camera: pick('camera'), q: pick('q') };
}

export function buildWhere(filters: LogFilters): { sql: string; params: unknown[] } {
  const params: unknown[] = [filters.from.toISOString(), filters.to.toISOString()];
  const clauses = ['ts >= $1', 'ts < $2'];
  const add = (clause: (index: string) => string, value: unknown) => {
    params.push(value);
    clauses.push(clause(`$${params.length}`));
  };
  if (filters.fruit) add((p) => `fruit_type = ${p}`, filters.fruit);
  if (filters.result) add((p) => `external_result = ${p}`, filters.result);
  if (filters.defect === 'none') clauses.push('defect_type IS NULL');
  else if (filters.defect) add((p) => `defect_type = ${p}`, filters.defect);
  if (filters.model) add((p) => `model_version = ${p}`, filters.model);
  if (filters.camera) add((p) => `camera_view = ${p}`, filters.camera);
  if (filters.q) {
    params.push(`%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const like = `event_id ILIKE $${params.length}`;
    if (/^\d{1,9}$/.test(filters.q)) {
      params.push(Number(filters.q));
      clauses.push(`(${like} OR track_id = $${params.length})`);
    } else clauses.push(like);
  }
  return { sql: clauses.join(' AND '), params };
}

/** Trend bucket size chosen from the range so the chart stays between ~12 and ~150 bars. */
export function bucketFor(filters: LogFilters): { interval: string; label: string } {
  const hours = (filters.to.getTime() - filters.from.getTime()) / 3_600_000;
  if (hours <= 3) return { interval: '5 minutes', label: '5 นาที' };
  if (hours <= 12) return { interval: '15 minutes', label: '15 นาที' };
  if (hours <= 72) return { interval: '1 hour', label: '1 ชั่วโมง' };
  return { interval: '1 day', label: '1 วัน' };
}
