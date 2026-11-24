# CIRA CORE PythonScript node: build fruit events, counting a fruit when it CROSSES a line.
#
# Not used yet. Today the flow counts a track_id the first time DeepDetect sees it, and a DeepDetect
# ROI (y=270 .. bottom) acts as the count line: a fruit is counted when it first appears inside the ROI.
# Switch to this script when we have proper footage, and then set the DeepDetect ROI back to the whole
# image (x=0, y=0, w=50000, h=50000): this script needs to see the fruit above the line too.
#
# Paste into the PythonScript node between DeepDetect and MqttPub (replaces the current code).
# DeepDetect objects carry x, y (box centre), w, h, track_id, name, confidence; image size im_w x im_h.
import datetime, os, json, tempfile

LINE_Y = 270          # pixel row of the count line (input video is 960x540; the line is drawn into it)
DIRECTION = "down"    # "down": count when the centre goes from above to below the line; "up": the reverse
MODEL_VERSION = "quick-v0.1"
MODEL_SOURCE = "quick"

STATE = os.path.join(tempfile.gettempdir(), "cira_line.json")
try:
	with open(STATE) as f:
		st = json.load(f)
except Exception:
	st = {}

now = datetime.datetime.now(datetime.timezone.utc)
dd = payload.get("DeepDetect", {})
vf = payload.get("VideoFile", {})
objs = dd.get("objects", [])
remain = vf.get("remain_sec")
max_tid = max([o.get("track_id", 0) for o in objs] or [0])

# --- new run: first call, track ids restarted, or the video looped ---
new_run = not st.get("run")
if not new_run:
	if objs and max_tid < st.get("max_tid", 0) - 50:
		new_run = True
	if remain is not None and st.get("remain") is not None and remain > st["remain"] + 2:
		new_run = True
if new_run:
	st = {"run": now.strftime("%Y%m%dT%H%M%S"), "last_y": {}, "counted": [], "max_tid": 0, "remain": remain}

last_y = st.get("last_y", {})      # track_id (str) -> centre y seen last frame
counted = set(st.get("counted", []))
events = []
for o in objs:
	tid = o.get("track_id")
	if tid is None or o.get("y") is None:
		continue
	key = str(tid)
	y = float(o["y"])
	prev = last_y.get(key)
	last_y[key] = y
	if prev is None or tid in counted:
		continue
	crossed = (prev < LINE_Y <= y) if DIRECTION == "down" else (prev > LINE_Y >= y)
	if not crossed:
		continue
	counted.add(tid)
	name = str(o.get("name", "")).strip().lower()
	events.append({
		"event_id": "cira-%s-%s" % (st["run"], tid),
		"timestamp": now.isoformat(),
		"fruit_type": "orange",
		"external_result": "defect" if name.startswith("rotten") else "good",
		"defect_type": None,
		"nir_result": "not_supported",
		"confidence": round(float(o.get("confidence", 0)), 2),
		"camera_view": "top",
		"model_version": MODEL_VERSION,
		"model_source": MODEL_SOURCE,
		"track_id": tid,
		"run": st["run"],
	})

# keep the state small: only tracks seen this frame, and the last 5000 counted ids
seen_now = {str(o.get("track_id")) for o in objs}
st["last_y"] = {k: v for k, v in last_y.items() if k in seen_now}
st["counted"] = sorted(counted)[-5000:]
st["max_tid"] = max(st.get("max_tid", 0), max_tid)
st["remain"] = remain
with open(STATE, "w") as f:
	json.dump(st, f)

payload.clear()
payload["n_events"] = len(events)
payload["events"] = events
