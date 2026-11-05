import os, json, datetime, psycopg2
dsn = os.environ["DATABASE_URL"].replace("localhost", "127.0.0.1")
now = datetime.datetime.now(datetime.timezone.utc)
ev = {"event_id": now.strftime("%Y%m%dT%H%M%S%f") + "-py", "timestamp": now.isoformat(), "fruit_type": "apple", "external_result": "defect", "confidence": 0.91, "camera_view": "top", "model_version": "mock", "model_source": "mock"}
conn = psycopg2.connect(dsn)
with conn, conn.cursor() as cur:
    cur.execute("INSERT INTO fruit_events (event_id, ts, fruit_type, external_result, confidence, camera_view, model_version, model_source, raw) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (event_id) DO NOTHING", (ev["event_id"], ev["timestamp"], ev["fruit_type"], ev["external_result"], ev["confidence"], ev["camera_view"], ev["model_version"], ev["model_source"], json.dumps(ev)))
conn.close()
print("inserted", ev["event_id"])
