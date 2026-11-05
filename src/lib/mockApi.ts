import type { FruitEvent } from '@/data/mockData';

export function filterFruitEvents(events: FruitEvent[], query = '') {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return events;
  return events.filter((event) => `${event.fruit_id} ${event.fruit_type} ${event.defect_type || ''}`.toLowerCase().includes(normalized));
}

export function summarizeEvents(events: FruitEvent[]) {
  const good = events.filter((event) => event.external_result === 'ดี' && event.nir_result !== 'เสียภายใน' && !event.type_mismatch).length;
  const external = events.filter((event) => event.external_result === 'เสีย').length;
  const internal = events.filter((event) => event.nir_result === 'เสียภายใน').length;
  const wrong = events.filter((event) => event.type_mismatch).length;
  return { total: events.length, good, external, internal, wrong, defectRate: events.length ? ((external + internal + wrong) / events.length) * 100 : 0 };
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], keys: (keyof T)[]) {
  const header = keys.join(',');
  const body = rows.map((row) => keys.map((key) => JSON.stringify(row[key] ?? '')).join(','));
  return [header, ...body].join('\n');
}
