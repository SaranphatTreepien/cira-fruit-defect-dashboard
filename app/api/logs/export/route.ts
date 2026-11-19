import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';
import { buildWhere, parseFilters } from '@/lib/logQuery';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 100_000;
const COLUMNS = [
  'event_id', 'ts_utc', 'ts_bangkok', 'fruit_type', 'external_result', 'defect_type', 'nir_result',
  'confidence', 'track_id', 'camera_view', 'model_version', 'model_source', 'session_id', 'synced', 'created_at_utc',
] as const;

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const filters = parseFilters(request.nextUrl.searchParams);
  const { sql: where, params } = buildWhere(filters);
  try {
    const result = await pool.query(
      `SELECT event_id, ts AS ts_utc,
              to_char(ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS.MS') AS ts_bangkok,
              fruit_type, external_result, defect_type, nir_result, confidence, track_id,
              camera_view, model_version, model_source, session_id, synced, created_at AS created_at_utc
       FROM fruit_events WHERE ${where}
       ORDER BY ts ASC, event_id ASC LIMIT ${MAX_ROWS}`,
      params,
    );
    const lines = [COLUMNS.join(','), ...result.rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(','))];
    // BOM so Excel opens UTF-8 (Thai) correctly.
    const body = `﻿${lines.join('\r\n')}\r\n`;
    const stamp = (date: Date) => date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return new NextResponse(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="fruit_events_${stamp(filters.from)}-${stamp(filters.to)}.csv"`,
        'x-row-count': String(result.rowCount ?? 0),
        'x-truncated': String((result.rowCount ?? 0) >= MAX_ROWS),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
