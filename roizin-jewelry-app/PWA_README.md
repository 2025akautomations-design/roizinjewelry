# Roizin Jewelry Co. — Expense / Sale / Profit-&-Loss Tracker

Internal counter tool for staff (iPad/iPhone). Its **main job is to track
expenses, sales, profits, and losses** for the gold business: record daily
transactions, print a simple receipt, accumulate purchase expenses across lots,
and — when a refinery sale is registered — compute profit/loss and reset the
accumulator. Everything mirrors to a Google Sheet; the day's lot can be sent to
the refinery and refinery payments logged.

**Not a public website.** Behind a staff passcode; not indexed.

## Money model (spec v3 §7, §13) — the important part

- Gold is **not melted every day**, so purchase **expenses _and_ total weight
  (dwt) accumulate across lots**. The Dashboard shows accumulated expenses and
  accumulated weight climbing with each lot and **shows no profit/loss yet.**
- **Registering a refinery sale** is the settlement event: it computes
  **Profit / Loss = sale amount − accumulated expenses** for every open lot,
  then **resets the accumulator** and starts a new cycle.
- **1 day = 1 lot.** A settlement closes one or more accumulated lots.

---

## Architecture (decided with the owner)

- **Cross-device sync (v5):** the **Google Apps Script + Sheet is the shared
  source of truth**. The app loads from it on open, writes every change through,
  and **polls ~8s** so a sale on the iPad shows on the iPhone automatically.
  IndexedDB is only an offline cache + write queue (flushed on reconnect);
  conflicts resolve by `updatedAt` (last-write-wins). Full-fidelity records live
  in a hidden **`_Sync`** tab; the readable report tabs are written alongside.
- **Payout %:** each transaction takes a **typed payout %** (e.g. 99) that drives
  the `rate` (= payout ÷ 100) for every line item.
- **Metal prices (all manual):** **gold** uses the **manually-entered London
  fix** (Settings). **Silver & platinum** take a **$/ozt typed per line item**.
  No external price feed. Shared per-unit formula:
  - `price/unit = ((karat−0.5)/24 or fineness) × rate × (price$/ozt ÷ unitsPerOzt)`
  - `amount = price/unit × weight` · `unitsPerOzt = {ozt:1, dwt:20, g:31.1034768}`
  - e.g. 14k DWT walk-in at $4,725/ozt → `(13.5/24)×0.99×4725÷20 = 131.58/dwt`
- **Profit/Loss (spec v3 §7):** computed only when a **refinery sale** is
  registered (sale − accumulated expenses), then the accumulator resets. The
  **Refinery → Payments** ledger separately tracks money the refinery sends back.
- **Deletes (spec v3 §6):** Transaction History, Lots, and the Client List each
  support delete with a confirmation step. Deletes are **soft** (audit trail):
  the local record is flagged and the Sheet row is struck through + tagged
  `[DELETED]`. Accumulated expenses recompute automatically.

```
app/                 The PWA (static files — host on any HTTPS host)
  index.html         Shell, header, nav, print target
  styles.css         Brand styles + print stylesheet
  pricing.js         Deterministic conversions + price math (no I/O)
  db.js              IndexedDB store + owner-editable config
  sync.js            Push/pull client for the shared Apps Script backend
  app.js             All views + routing + passcode gate + receipts
  sw.js              Service worker (offline app shell)
  manifest.webmanifest
  icons/             App + receipt logo
apps_script/
  Code.gs            Sync store + sheet writers, settlements, deletes, manual-fix store
  appsscript.json    Scopes + web-app deployment config
```

---

## Setup

### 1. The Google Sheet + Apps Script backend
1. Create a Google Sheet **owned by `davidroizin@gmail.com`** (e.g. "Roizin Gold — Ledger").
2. In that Sheet: **Extensions ▸ Apps Script**. Delete the stub, paste
   `apps_script/Code.gs`. Then open the project's **appsscript.json** (Project
   Settings ▸ "Show appsscript.json") and paste `apps_script/appsscript.json`.
3. (Optional) the `CONFIG` block at the top of `Code.gs` only holds the owner
   email + timezone. No metals API key or refinery email is needed.
4. Run **`grantPermissions`** once from the editor (creates the tabs and grants
   Gmail/Sheet permissions).
5. **Deploy ▸ New deployment ▸ Web app**: *Execute as* **Me (David)**,
   *Who has access* **Anyone**. Copy the **/exec** URL. (This backend is the
   shared store every device syncs through — deploy once, use the same URL on all
   devices.)

The tabs `Purchases`, `Clients`, `Daily-Lots`, `Settlements`, `Ledger`,
`Refinery-Payments`, `Fix-Locks`, `Config`, `_Sync` are created
automatically on first run. `_Sync` is the machine datastore (full record JSON);
the rest are human-readable reports. **`Purchases`** holds one row per line item
(every piece). **`Ledger`** mirrors the owner's `Copy_of_ROIZIN_JEWELRY_2026`
layout — one row per lot (D, DATE, LONDON FIX, SPENT, RESOLD, TOTAL $, WEIGHT,
melt, SELL PRICE, P/L, …); buy/melt columns fill on lot save and the sell-side
columns fill (allocated across the settled lots by spend) when a refinery sale is
registered. Assay/XRF/fire columns are left blank for manual entry.

### 2. The PWA
1. Host the `app/` folder on any HTTPS host (Apple requires HTTPS for
   Add-to-Home-Screen + service worker). Options: GitHub Pages, Netlify drop,
   Cloudflare Pages, Firebase Hosting, or an internal server.
   - Local testing: `cd app && python3 -m http.server 8080` then open
     `http://localhost:8080` (localhost counts as a secure context).
2. Open the URL in **Safari** on the iPad → **Share ▸ Add to Home Screen**.
3. In the app (on **each** device), go to **Settings** and set the **Apps Script
   web-app URL** (same `/exec` URL everywhere — that's what links the devices).
   Also set **default payout %** (e.g. 99), **timezone**, and the **staff
   passcode** (default `1947` — change it).
4. Set the gold price: **Settings ▸ Gold London Fix** → enter the fix →
   **Save Gold Fix for Today** (update whenever it changes). Silver/platinum
   prices are typed per line item on the transaction screen.

---

## Daily flow

1. **New Transaction** — type the **customer** (optional) + **date** + **payout
   %**, then fill the line-item table: **metal · karat /
   purity · unit · weight · price**. Gold's price/unit is computed from your
   London fix; for silver/platinum type the **$/ozt** and the price/unit derives
   automatically. **AMOUNT** and **TOTAL PAYOUT** update live. Use **+ Add Item**
   for extra pieces, **×** to remove a row. Finish with **Save & Print** (persists
   then prints the multi-item receipt), **Save Only**, or **Clear**.
2. Every line item joins **today's lot**, and its expense + weight **add to the
   running accumulators** shown on the Dashboard.
3. **Melt & Refinery** (~5 p.m.) — enter dwt before/after (melt loss
   auto-computes) → **Save Lot**.
4. **Register the refinery sale** (Melt & Refinery → Register Refinery Sale, or
   the Dashboard button) when the refinery settles: enter the **sale amount** →
   the app computes **Profit/Loss = sale − accumulated expenses** for every open
   lot, writes a row to `Settlements`, and **resets the accumulators** (expenses
  and weight).
5. Money the refinery sends back is logged under **Melt & Refinery ▸ Payments**
   (a report of received vs. total sales).

**Multiple pieces in one transaction:** in New Transaction, fill an item then tap
**+ Add Another Item** (the running items list + totals show below); repeat for
each piece. **Save Transaction** stores every item under one shared receipt #,
and the printed receipt lists all items with one **TOTAL**. **Clear** wipes the
whole form in one tap if a sale is cancelled.

---

## The price math (spec v5)

```
rate        = payout% ÷ 100                             // typed per transaction
unitsPerOzt = { ozt: 1, dwt: 20, g: 31.1034768 }
purity      = gold ? (karat − 0.5) / 24 : fineness     // .925 etc
price/unit  = purity × rate × (price$perOzt ÷ unitsPerOzt[unit])
amount      = price/unit × weight
```
- `karat` = numeric karat 8–24 (the `−0.5` refining deduction is gold-only);
  `fineness` = millesimal/1000 (sterling `.925`).
- **Gold** `price$perOzt` = the manually-entered London fix. **Silver/platinum**
  `price$perOzt` = the **$/ozt typed per line item** at sale time.
- Worked example: 14k, DWT, walk-in, fix $4,725/ozt →
  `((14−0.5)/24) × 0.99 × 4725 ÷ 20 = 131.58` per DWT.

Units: 1 dwt = 1.55517384 g, 1 troy oz = 20 dwt. All in `pricing.js`
(`calcLineItem`), the one deterministic place the math lives.

---

## The receipt

Plain typewriter-style receipt matching
`Screenshot 2026-06-16 at 2.43.45 PM.png`: **ROIZIN JEWELRY** + address/phone,
`<METAL> PURCHASE RECEIPT`, receipt # (`YYYYMMDD-NNN`), Customer / Date / metal
price, a `KT · UNIT · WEIGHT · PRICE · AMOUNT` table (**one row per item** in the
transaction; PRICE = per selected unit, AMOUNT = weight × price), then a bold
**TOTAL** summing all items. **Save & Print** persists then prints in two taps.

---

## OPEN ITEMS — confirm with David

1. **Sync cadence.** Cross-device sync runs through the Apps Script + Sheet
   backend, polling every ~8s (near-real-time, not instant). If you want instant
   updates we can move to Firebase Firestore later.
2. **Fix/price unit basis.** The math assumes prices are **per troy ounce**
   (standard), so `÷20` gives per pennyweight. If a price is quoted per dwt or per
   gram instead, adjust `pricing.js`.
3. **Ledger mapping.** The `Ledger` tab fills the columns the app collects
   (D, DATE, LONDON FIX, SPENT, RESOLD, TOTAL $, WEIGHT, Total Wt, Pre/Aft melt,
   EST. PAY, P/L). Because one refinery sale can settle several lots, the
   sell-side is **allocated across those lots by each lot's spend**. Assay/XRF/
   fire/`Sold Wt`/`Proj Kt` columns aren't captured by the app and are left blank
   for manual entry. Confirm this mapping matches how you keep the book.
4. **PWA icon.** Uses the wide white-bg wordmark; drop a square logo into
   `app/icons/icon-192.png` / `icon-512.png` for a tighter home-screen icon.

---

## Notes / limits

- Apps Script web apps don't send CORS preflight headers, so the app POSTs as
  `text/plain` (a "simple request") and the script parses the body as JSON.
- The sync queue retries automatically when back online; **Settings ▸ Flush Sync
  Queue Now** forces a push and reports anything still pending.
- Receipts print via `window.print()` against a print-only stylesheet
  (AirPrint-friendly); app chrome is hidden when printing.
- Default passcode is `1947` — **change it in Settings** before going live.
