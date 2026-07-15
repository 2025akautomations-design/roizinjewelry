import { neon } from "@neondatabase/serverless"

// One-time backfill: push every existing sync_records row into the Google Sheet
// mirror, using the exact same payload shape as mirrorToSheet() in the API route.
const dbUrl = process.env.DATABASE_URL
const webhook = process.env.GOOGLE_SHEET_WEBHOOK_URL
if (!dbUrl) throw new Error("DATABASE_URL is not set")
if (!webhook) throw new Error("GOOGLE_SHEET_WEBHOOK_URL is not set")

const sql = neon(dbUrl)

const rows = await sql`
  SELECT store, rec_id, deleted, updated_at, record
  FROM sync_records
  ORDER BY store ASC, updated_at ASC
`

console.log(`[backfill] ${rows.length} records to mirror`)

let ok = 0
let fail = 0
for (const r of rows) {
  const payload = {
    store: r.store,
    id: r.rec_id,
    deleted: !!r.deleted,
    updatedAt: Number(r.updated_at) || Date.now(),
    record: r.record,
  }
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "upsert", payload, ts: Date.now() }),
    })
    if (res.ok) ok++
    else {
      fail++
      console.log(`[backfill] HTTP ${res.status} for ${r.store}/${r.rec_id}`)
    }
  } catch (e) {
    fail++
    console.log(`[backfill] error for ${r.store}/${r.rec_id}: ${e.message}`)
  }
  // Gentle pace so Apps Script doesn't throttle/queue writes.
  await new Promise((res) => setTimeout(res, 120))
}

console.log(`[backfill] done. ok=${ok} fail=${fail}`)
