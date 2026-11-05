import { NextResponse } from "next/server";
import { pool } from "@/db/pool";

export async function POST(req: Request) {
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!b.event_id || !b.timestamp || !["good", "defect"].includes(b.external_result)) {
    return NextResponse.json({ error: "missing/invalid fields" }, { status: 400 });
  }

  const known = async (table: string, col: string, v: unknown) => {
    if (!v) return null;
    const r = await pool.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [v]);
    return r.rowCount ? v : null;
  };
  const fruit = await known("fruit_types", "code", b.fruit_type);
  const defect = await known("defect_types", "code", b.defect_type);
  const model = await known("models", "model_version", b.model_version);

  const r = await pool.query(
    `INSERT INTO fruit_events
      (event_id, ts, fruit_type, external_result, defect_type, nir_result,
       confidence, camera_view, model_version, model_source, session_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (event_id) DO NOTHING`,
    [b.event_id, b.timestamp, fruit, b.external_result, defect, b.nir_result ?? null,
     b.confidence ?? null, b.camera_view ?? null, model, b.model_source ?? null,
     null, JSON.stringify(b)]
  );

  return NextResponse.json({ ok: true, inserted: r.rowCount === 1 });
}
