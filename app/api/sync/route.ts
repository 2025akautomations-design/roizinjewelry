import { neon } from "@neondatabase/serverless"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function getSql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is not set")
  return neon(url)
}

// Mirror the IndexedDB keyPath logic used by the app (db.js / app.js keyOf).
function keyOf(store: string, rec: any): string | null {
  if (!rec) return null
  if (store === "lots") return rec.date != null ? String(rec.date) : null
  if (store === "fixLocks") return rec.key != null ? String(rec.key) : null
  return rec.id != null ? String(rec.id) : null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

// Fire-and-forget mirror of a write to a Google Sheet (Apps Script web app).
// Set GOOGLE_SHEET_WEBHOOK_URL to the Apps Script /exec URL to enable it.
function mirrorToSheet(payload: {
  store: string
  id: string
  deleted: boolean
  updatedAt: number
  record: any
}) {
  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL
  if (!url) return
  // text/plain avoids an Apps Script CORS preflight; never block the response on it.
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "upsert", payload, ts: Date.now() }),
  }).catch(() => {})
}

// GET /api/sync?action=pull&since=<ms>  -> records changed since the watermark.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get("action")

  if (action === "pull") {
    // `since` is now a server-authoritative monotonic cursor (seq), NOT a
    // wall-clock timestamp. Using the client clock as the cursor let clock
    // skew on any device permanently poison its watermark and silently skip
    // records. `seq` is assigned server-side and strictly increasing.
    const since = Number(searchParams.get("since")) || 0
    const sql = getSql()
    const rows = (await sql`
      SELECT store, rec_id, deleted, record, seq
      FROM sync_records
      WHERE seq > ${since}
      ORDER BY seq ASC
      LIMIT 5000
    `) as Array<{ store: string; rec_id: string; deleted: boolean; record: any; seq: string | number }>

    const records = rows.map((r) => ({
      store: r.store,
      id: r.rec_id,
      deleted: r.deleted,
      record: r.record,
      seq: Number(r.seq),
    }))
    const cursor = records.reduce((m, r) => Math.max(m, r.seq), since)
    return json({ ok: true, records, cursor, now: Date.now() })
  }

  return json({ ok: false, error: "unknown action" }, 400)
}

// POST /api/sync   body: { action:"upsert", payload:{ store, record }, ts }
// Sent as text/plain by the client to avoid a CORS preflight.
export async function POST(req: Request) {
  let body: any
  try {
    const text = await req.text()
    body = JSON.parse(text)
  } catch {
    return json({ ok: false, error: "bad json" }, 400)
  }

  const action = body && body.action
  if (action !== "upsert") {
    return json({ ok: false, error: "unknown action" }, 400)
  }

  const store = body?.payload?.store
  const record = body?.payload?.record
  const id = keyOf(store, record)
  if (!store || !id) {
    return json({ ok: false, error: "missing store or record key" }, 400)
  }

  const updatedAt = Number(record.updatedAt) || Date.now()
  const deleted = !!record.deleted

  // Last-write-wins by updatedAt: only overwrite when the incoming write is
  // at least as new as what we already have for this key.
  // A fresh `seq` is stamped on every applied write (INSERT via the column
  // default, UPDATE explicitly) so pull cursors advance in server order and
  // never depend on client clocks. The LWW guard means a stale (older) write
  // leaves the row — and its seq — untouched.
  const sql = getSql()
  await sql`
    INSERT INTO sync_records (store, rec_id, updated_at, deleted, record)
    VALUES (${store}, ${id}, ${updatedAt}, ${deleted}, ${JSON.stringify(record)}::jsonb)
    ON CONFLICT (store, rec_id) DO UPDATE
    SET updated_at = EXCLUDED.updated_at,
        deleted = EXCLUDED.deleted,
        record = EXCLUDED.record,
        seq = nextval('sync_records_seq')
    WHERE EXCLUDED.updated_at >= sync_records.updated_at
  `

  mirrorToSheet({ store, id, deleted, updatedAt, record })

  return json({ ok: true, now: Date.now() })
}
