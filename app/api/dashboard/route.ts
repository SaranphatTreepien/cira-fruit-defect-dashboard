import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import type { AlertItem, FruitEvent } from '@/data/mockData';
import { emptyDashboardSummary, type DashboardData } from '@/lib/dashboardData';

const unknown = 'unknown';

function displayFruit(value: string | null): FruitEvent['fruit_type'] {
  if (value === 'apple') return 'แอปเปิล';
  if (value === 'orange') return 'ส้ม';
  return unknown as FruitEvent['fruit_type'];
}

function displayResult(value: string | null): FruitEvent['external_result'] {
  if (value === 'good') return 'ดี';
  if (value === 'defect') return 'เสีย';
  return unknown as FruitEvent['external_result'];
}

function displayDefect(value: string | null): FruitEvent['defect_type'] {
  if (!value) return unknown as FruitEvent['defect_type'];
  if (value === 'bruise') return 'รอยตำหนิ';
  if (value === 'rot') return 'เสียหาย-เน่า';
  if (value === 'crack') return 'รูปร่างบิดเบี้ยว';
  return unknown as FruitEvent['defect_type'];
}

function displayNir(value: string | null): FruitEvent['nir_result'] {
  if (!value) return unknown as FruitEvent['nir_result'];
  if (value === 'good' || value === 'normal') return 'ปกติ';
  if (value === 'defect' || value === 'internal_defect') return 'เสียภายใน';
  return unknown as FruitEvent['nir_result'];
}

function displayCamera(value: string | null): FruitEvent['camera_view'] {
  if (value === 'top') return 'มุมบน';
  if (value === 'side') return 'มุมข้าง';
  return unknown as FruitEvent['camera_view'];
}

function toEvent(row: {
  event_id: string;
  ts: Date;
  fruit_type: string | null;
  external_result: string | null;
  defect_type: string | null;
  nir_result: string | null;
  confidence: number | null;
  camera_view: string | null;
}): FruitEvent {
  return {
    fruit_id: row.event_id || unknown,
    timestamp: row.ts ? new Date(row.ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : unknown,
    fruit_type: displayFruit(row.fruit_type),
    external_result: displayResult(row.external_result),
    defect_type: displayDefect(row.defect_type),
    nir_result: displayNir(row.nir_result),
    type_mismatch: false,
    confidence: row.confidence == null ? Number.NaN : row.confidence <= 1 ? row.confidence * 100 : row.confidence,
    camera_view: displayCamera(row.camera_view),
  };
}

function toAlert(row: { id: string; ts: Date; level: string; source: string | null; message: string | null }): AlertItem {
  const level = row.level === 'error' || row.level === 'critical' ? 'วิกฤต' : row.level === 'warn' || row.level === 'warning' ? 'เตือน' : 'ข้อมูล';
  return {
    id: `DB-${row.id}`,
    level,
    title: row.source || 'System log',
    detail: row.message || unknown,
    time: row.ts ? new Date(row.ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : unknown,
    status: 'ใหม่',
    channel: 'ระบบ',
  };
}

export async function GET() {
  try {
    const [eventsResult, summaryResult, logsResult] = await Promise.all([
      pool.query(`SELECT event_id, ts, fruit_type, external_result, defect_type, nir_result, confidence, camera_view
        FROM fruit_events WHERE fruit_type = 'orange' ORDER BY ts DESC LIMIT 500`),
      pool.query(`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE external_result = 'good' AND COALESCE(nir_result, '') NOT IN ('defect', 'internal_defect'))::int AS good,
        COUNT(*) FILTER (WHERE external_result = 'defect')::int AS external,
        COUNT(*) FILTER (WHERE nir_result IN ('defect', 'internal_defect'))::int AS internal,
        0::int AS wrong,
        AVG(confidence) AS average_confidence,
        CASE WHEN COUNT(*) = 0 THEN NULL ELSE COUNT(*) FILTER (WHERE nir_result IS NOT NULL)::float / COUNT(*) * 100 END AS nir_coverage,
        MAX(ts) AS last_event_at
      FROM fruit_events WHERE fruit_type = 'orange'`),
      pool.query(`SELECT id, ts, level, source, message FROM system_logs ORDER BY ts DESC LIMIT 50`),
    ]);

    const summaryRow = summaryResult.rows[0];
    const summary = {
      total: Number(summaryRow?.total ?? 0),
      good: Number(summaryRow?.good ?? 0),
      external: Number(summaryRow?.external ?? 0),
      internal: Number(summaryRow?.internal ?? 0),
      wrong: Number(summaryRow?.wrong ?? 0),
      averageConfidence: summaryRow?.average_confidence == null ? null : Number(summaryRow.average_confidence) <= 1 ? Number(summaryRow.average_confidence) * 100 : Number(summaryRow.average_confidence),
      nirCoverage: summaryRow?.nir_coverage == null ? null : Number(summaryRow.nir_coverage),
      lastEventAt: summaryRow?.last_event_at ? new Date(summaryRow.last_event_at).toISOString() : null,
    };

    const response: DashboardData = {
      source: 'postgres',
      events: eventsResult.rows.map(toEvent),
      alerts: logsResult.rows.map(toAlert),
      summary,
      database: { connected: true, eventCount: summary.total, lastEventAt: summary.lastEventAt },
    };
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database query failed';
    const response: DashboardData = {
      source: 'unavailable',
      events: [],
      alerts: [],
      summary: emptyDashboardSummary,
      database: { connected: false, eventCount: 0, lastEventAt: null },
      error: message,
    };
    return NextResponse.json(response, { status: 503 });
  }
}
