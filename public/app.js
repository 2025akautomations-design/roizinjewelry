/* =====================================================================
   Roizin Jewelry Co. — Expense / Sale / Profit-&-Loss tracker (main SPA)
   Local-first. Reads/writes DB (IndexedDB), mirrors to the Sheet via Sync.
   Big type, big touch targets, white background. Built for iPad/iPhone.

   Core money model:
     - A LOT is a full buying cycle: we buy gold over many days, then melt it
       all and sell it to the refinery. That sale is what closes the lot.
       (A lot is NOT a single day — it spans however many days of buying.)
     - Purchase expenses + weight ACCUMULATE into the current open lot. The
       dashboard shows them climbing (in dwt); NO profit/loss yet.
     - Registering a refinery SALE closes the open lot: enter the whole-lot
       melt (dwt before/after) and the sale amount, then
         Profit / Loss = sale amount − accumulated expenses
       and a new (empty) lot begins.
   ===================================================================== */
(function () {
  "use strict";

  var P = window.Pricing, DB = window.DB, Sync = window.Sync;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------------------------------------------------------------------
  // Time helpers — all day boundaries are America/New_York.
  // ---------------------------------------------------------------------
  function nyParts(d) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: window.DB.getConfig().fixTimezone || "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    var o = {};
    fmt.formatToParts(d).forEach(function (p) { if (p.type !== "literal") o[p.type] = p.value; });
    if (o.hour === "24") o.hour = "00";
    return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour, minute: +o.minute };
  }
  function nyDateStr(d) {
    var p = nyParts(d || new Date());
    return p.year + "-" + pad(p.month) + "-" + pad(p.day);
  }
  // Fix is entered manually; "today" is simply the NY calendar day.
  function fixEffectiveDate(d) { return nyDateStr(d || new Date()); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function nowTs() { return Date.now(); }
  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString("en-US", {
      timeZone: DB.getConfig().fixTimezone || "America/New_York",
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
  }
  function fmtDate(s) {
    var parts = String(s).split("-");
    if (parts.length !== 3) return s;
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  // A lot spans a range of days. "Jun 3 – Jun 15, 2026" (or a single day).
  function lotRange(start, end) {
    if (!start) return "";
    if (!end || end === start) return fmtDate(start);
    return fmtDate(start) + " – " + fmtDate(end);
  }

  // ---------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------
  var state = {
    config: DB.getConfig(),
    locked: false   // passcode gate
  };

  // ---------------------------------------------------------------------
  // Toast + modal + confirm
  // ---------------------------------------------------------------------
  function toast(msg, kind) {
    var t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }

  function modal(html, onMount) {
    var wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = '<div class="modal">' + html + "</div>";
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    function close() { wrap.remove(); }
    if (onMount) onMount(wrap, close);
    return { el: wrap, close: close };
  }

  // Confirmation step required before any delete (spec v3 §6).
  function confirmDelete(message, onYes) {
    modal(
      '<h2>Confirm delete</h2><p class="confirm-msg">' + message + "</p>" +
      '<div class="modal-actions"><button class="btn btn-ghost" id="cdNo">Cancel</button>' +
      '<button class="btn btn-danger" id="cdYes">Delete</button></div>',
      function (wrap, close) {
        $("#cdNo", wrap).addEventListener("click", close);
        $("#cdYes", wrap).addEventListener("click", function () { close(); onYes(); });
      });
  }
  // Generic confirm for non-destructive actions (custom title + confirm label).
  function confirmAction(title, message, confirmLabel, onYes) {
    modal(
      "<h2>" + esc(title) + '</h2><p class="confirm-msg">' + message + "</p>" +
      '<div class="modal-actions"><button class="btn btn-ghost" id="caNo">Cancel</button>' +
      '<button class="btn btn-primary" id="caYes">' + esc(confirmLabel || "Confirm") + "</button></div>",
      function (wrap, close) {
        $("#caNo", wrap).addEventListener("click", close);
        $("#caYes", wrap).addEventListener("click", function () { close(); onYes(); });
      });
  }

  // ---------------------------------------------------------------------
  // Fix resolution — manual override wins, else live API, else last known.
  // ---------------------------------------------------------------------
  function lockKey(date, metal) { return date + "|" + metal; }

  // Most recent manually-entered fix for a metal (any date), or null.
  function latestFix(metal) {
    return DB.all("fixLocks").then(function (all) {
      var m = all.filter(function (f) { return f.metal === metal; });
      if (!m.length) return null;
      m.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      return m[0];
    });
  }

  // The gold fix to use: today's manual entry if present, else the most recent
  // one entered. fixLocks stays current across devices via the sync poller.
  function getEffectiveFix(metal) {
    var date = fixEffectiveDate();
    return DB.get("fixLocks", lockKey(date, metal)).then(function (today) {
      return today || latestFix(metal);
    });
  }

  // Save a manually-entered fix; saveRecord mirrors it to the shared backend.
  function lockFix(metal, date, fix) {
    var rec = {
      key: lockKey(date, metal), date: date, metal: metal, fix: Number(fix),
      source: "manual", manual: true, lockedAt: nowTs()
    };
    return saveRecord("fixLocks", rec).then(function () { refreshFixChip(); return rec; });
  }

  // =====================================================================
  // Cross-device sync (v5) — shared source of truth = Apps Script + Sheet.
  //   saveRecord/deleteRecord write locally (instant/offline) AND push a
  //   full-fidelity record up; a poller pulls remote changes and merges by
  //   updatedAt (last-write-wins). IndexedDB is only a cache, never the SoT.
  // =====================================================================
  function keyOf(store, rec) {
    return store === "lots" ? rec.date : (store === "fixLocks" ? rec.key : rec.id);
  }
  function saveRecord(store, rec) {
    rec.updatedAt = Date.now();
    return DB.put(store, rec).then(function () { Sync.push(store, rec); return rec; });
  }
  function deleteRecord(store, rec) {
    rec.deleted = true; rec.deletedTs = nowTs(); rec.updatedAt = Date.now();
    return DB.put(store, rec).then(function () { Sync.push(store, rec); return rec; });
  }
  // Keys with an unsynced local write still sitting in the outbound queue —
  // those must NOT be clobbered by a stale pull until they've been pushed.
  function pendingKeys() {
    return DB.all("queue").then(function (items) {
      var set = {};
      items.forEach(function (it) {
        if (it.action === "upsert" && it.payload && it.payload.store && it.payload.record) {
          set[it.payload.store + "|" + keyOf(it.payload.store, it.payload.record)] = true;
        }
      });
      return set;
    });
  }
  function mergeRecord(store, remote, pending) {
    if (!remote) return Promise.resolve();
    var k = store + "|" + keyOf(store, remote);
    // The server (Sheet) is the source of truth: accept the pulled record
    // unless this device has an un-pushed local edit for it. Ordering is by the
    // server clock (stamped in _Sync), so device clock skew can't drop records.
    if (pending && pending[k]) return Promise.resolve();
    return DB.put(store, remote);
  }
  // The pull cursor is a SERVER-authoritative monotonic sequence (seq), never
  // a wall-clock time. Older builds used max(record.updatedAt) as the cursor,
  // so a device whose clock ever ran fast would inflate its watermark and then
  // silently skip every later record from correctly-clocked devices — the
  // devices would diverge forever. Tracking the server's seq removes clock
  // skew from the equation entirely. The meta key is intentionally new
  // ("syncCursor") so existing devices reset to 0 once and do a single full
  // re-pull, converging everyone back onto the shared source of truth.
  var _cursor = 0;
  function pullAndMerge() {
    if (!Sync.endpoint()) return Promise.resolve(false);
    return Promise.all([Sync.pull(_cursor), pendingKeys()]).then(function (r) {
      var res = r[0], pending = r[1];
      if (!res || !res.records) return false;
      var changed = res.records.length > 0;
      // Prefer the server-provided cursor; fall back to the max seq we saw.
      var maxSeq = res.records.reduce(function (m, it) {
        return Math.max(m, Number(it.seq) || 0);
      }, 0);
      var nextCursor = Math.max(_cursor, Number(res.cursor) || 0, maxSeq);
      return res.records.reduce(function (ch, item) {
        return ch.then(function () { return mergeRecord(item.store, item.record, pending); });
      }, Promise.resolve()).then(function () {
        _cursor = nextCursor;
        return DB.put("meta", { k: "syncCursor", v: _cursor }).then(function () { return changed; });
      });
    }).catch(function () { return false; });
  }
  function initialLoad() {
    return DB.get("meta", "syncCursor").then(function (m) { _cursor = (m && m.v) || 0; })
      .then(pullAndMerge);
  }
  function softRefresh() {
    var r = currentRoute();
    if (r.name === "new" || r.name === "settings") return;   // don't wipe live input
    if (document.querySelector(".modal-wrap")) return;
    render();
    refreshFixChip();
  }
  function startPolling() {
    setInterval(function () {
      if (state.locked) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      Sync.flush();   // drain any queued writes (offline edits, retries)
      pullAndMerge().then(function (changed) { if (changed) softRefresh(); });
    }, 8000);  // ~8s near-real-time cross-device sync
  }

  // ---------------------------------------------------------------------
  // Data helpers — live (non-deleted) records + the expense accumulator
  // ---------------------------------------------------------------------
  function lotDate() { return nyDateStr(); }

  function livePurchases() {
    return DB.all("purchases").then(function (all) {
      return all.filter(function (p) { return !p.deleted; });
    });
  }
  function liveLots() {
    return DB.all("lots").then(function (all) {
      return all.filter(function (l) { return !l.deleted; });
    });
  }
  function liveSettlements() {
    return DB.all("settlements").then(function (all) {
      return all.filter(function (s) { return !s.deleted; });
    });
  }

  function purchasesForDate(date) {
    return livePurchases().then(function (all) {
      return all.filter(function (p) { return p.date === date; });
    });
  }

  // Group line items into transactions (shared txnId / receipt #). Legacy
  // single-item purchases without a txnId become a one-item transaction.
  function groupTxns(purchases) {
    var byKey = {}, order = [];
    purchases.forEach(function (p) {
      var key = p.txnId || ("solo_" + p.id);
      if (!byKey[key]) {
        byKey[key] = {
          key: key, txnId: p.txnId || null, firstId: p.id, order: p.order, date: p.date, ts: p.ts,
          clientId: p.clientId, clientName: p.clientName, items: [], total: 0, grossDwt: 0, settled: !!p.settlementId
        };
        order.push(key);
      }
      var t = byKey[key];
      // The grand TOTAL always includes every record. A manual receipt-total
      // override is stored as a hidden `adjustment` line (see
      // editableReceiptFlow) so it flows through every line-level rollup
      // (expenses, current lot, day summary, settlements, balance) untouched.
      // Adjustment lines are never shown as their own item and carry no weight.
      t.total += (p.price || 0);
      if (isAdjustment(p)) { t.hasAdjustment = true; return; }
      t.items.push(p);
      t.grossDwt += (p.grossDwt || 0);
      if (p.ts < t.ts) { t.ts = p.ts; t.firstId = p.id; }
    });
    return order.map(function (k) { return byKey[k]; });
  }

  // A hidden line item that carries a manual receipt-total override delta. It
  // has a metal + price so it counts in the books, but no weight and is never
  // rendered as a visible receipt row.
  function isAdjustment(rec) { return !!(rec && rec.adjustment); }

  // Open = not yet sold to a refinery.
  function isOpen(rec) { return !rec.settlementId; }
  // In the CURRENT LOT = open AND not held back into live stock.
  function inCurrentLot(p) { return !p.settlementId && !p.stockId; }

  // --- Live stock (held metal) + current-lot adjustments live in one store,
  //     distinguished by `kind`. ------------------------------------------
  function liveStockEntries() {
    return DB.all("livestock").then(function (all) {
      return all.filter(function (r) { return !r.deleted && r.kind === "stock"; });
    });
  }
  function lotAdjById() {
    return DB.all("livestock").then(function (all) {
      var by = {};
      all.forEach(function (r) { if (!r.deleted && r.kind === "lotadj") by[r.metal] = r; });
      return by;
    });
  }
  // Reduce a list of live-stock entries into {dwt, cost, count, entries}.
  function summarizeStock(list) {
    return {
      entries: list,
      dwt: list.reduce(function (s, e) { return s + (e.dwt || 0); }, 0),
      cost: list.reduce(function (s, e) { return s + (e.cost || 0); }, 0),
      count: list.length
    };
  }

  // Summarize a lot made of purchases AND/OR live-stock entries (for Custom Lots
  // that fold held stock into a shipment). Same shape a settlement expects.
  function summarizeMembers(purchases, stock) {
    purchases = purchases || []; stock = stock || [];
    var expenses = purchases.reduce(function (s, p) { return s + (p.price || 0); }, 0) +
                   stock.reduce(function (s, e) { return s + (e.cost || 0); }, 0);
    var dwt = purchases.reduce(function (s, p) { return s + (p.grossDwt || 0); }, 0) +
              stock.reduce(function (s, e) { return s + (e.dwt || 0); }, 0);
    var dates = {};
    purchases.forEach(function (p) { dates[p.date] = true; });
    stock.forEach(function (e) { dates[e.date] = true; });
    var dl = Object.keys(dates).sort();
    return {
      purchases: purchases, stock: stock, expenses: expenses, dwt: dwt,
      count: purchases.length + stock.length, dayCount: dl.length,
      dateStart: dl[0] || null, dateEnd: dl[dl.length - 1] || null
    };
  }

  // Reduce a list of purchases into an accumulator summary (expenses, gross
  // dwt, counts, date span). Shared by the whole-lot snapshot and each
  // per-metal bucket.
  function summarizePurchases(list) {
    var expenses = list.reduce(function (s, p) { return s + (p.price || 0); }, 0);
    var dwt = list.reduce(function (s, p) { return s + (p.grossDwt || 0); }, 0);
    var dates = {};
    list.forEach(function (p) { dates[p.date] = true; });
    var dateList = Object.keys(dates).sort();
    return {
      purchases: list,
      expenses: expenses,
      dwt: dwt,                  // accumulated GROSS weight in dwt
      count: list.length,        // number of line items
      dayCount: dateList.length, // how many distinct days we bought on
      dateStart: dateList[0] || null,
      dateEnd: dateList[dateList.length - 1] || null
    };
  }

  // Snapshot of the CURRENT OPEN LOT: every purchase bought since the last
  // refinery sale, with weight always totalled in dwt (any purchase unit is
  // converted to dwt at save time via grossDwt). Because gold, silver and
  // platinum ship to different refineries, the snapshot also carries a
  // per-metal breakdown so each metal accumulates its own open lot.
  function accumulatorSnapshot() {
    return Promise.all([livePurchases(), DB.all("livestock")]).then(function (r) {
      var all = r[0], stockAll = r[1].filter(function (x) { return !x.deleted; });
      var open = all.filter(inCurrentLot);            // current lot = open, not held in stock
      var snap = summarizePurchases(open);
      var adj = {}; stockAll.forEach(function (x) { if (x.kind === "lotadj") adj[x.metal] = x; });
      var stockOpen = stockAll.filter(function (x) { return x.kind === "stock" && !x.settlementId; });

      var perMetal = {}, perMetalStock = {};
      P.METALS.forEach(function (m) {
        var s = summarizePurchases(open.filter(function (p) { return p.metal === m.key; }));
        // Fold in the manual current-lot adjustment for this metal.
        var a = adj[m.key];
        s.adjDwt = a ? (a.dwt || 0) : 0;
        s.adjCost = a ? (a.cost || 0) : 0;
        s.dwt += s.adjDwt;
        s.expenses += s.adjCost;
        perMetal[m.key] = s;
        perMetalStock[m.key] = summarizeStock(stockOpen.filter(function (e) { return e.metal === m.key; }));
      });
      snap.perMetal = perMetal;
      snap.perMetalStock = perMetalStock;
      return snap;
    });
  }

  // Receipt number in the screenshot's format: YYYYMMDD-NNN (per-day counter).
  // Uses the TRANSACTION date (not today) so backdated purchases get an order
  // number stamped with the day they actually happened.
  function nextOrderNo(dateStr) {
    var ymd = String(dateStr || nyDateStr()).replace(/-/g, "");
    var key = "seq_" + ymd;
    return DB.get("meta", key).then(function (m) {
      var n = (m && m.v ? m.v : 0) + 1;
      return DB.put("meta", { k: key, v: n }).then(function () {
        return ymd + "-" + String(n).padStart(3, "0");
      });
    });
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  var routes = {};
  // The current route is held in memory as a plain path like "clients" or
  // "purchase/123" — never in location.hash and never with a leading "#/".
  // The preview harness scans the DOM/URL for hash-like strings and runs
  // document.querySelector(value); a value such as "#/clients" is not a valid
  // CSS selector and throws. Keeping routes as bare paths avoids that entirely.
  var currentPath = "dashboard";
  function route(name, fn) { routes[name] = fn; }
  function go(path) {
    currentPath = String(path == null ? "dashboard" : path).replace(/^#?\/?/, "") || "dashboard";
    render();
  }
  function currentRoute() {
    var parts = (currentPath || "dashboard").split("/");
    var args = parts.slice(1).map(function (p) { return decodeURIComponent(p); });
    return { name: parts[0] || "dashboard", arg: args[0] != null ? args[0] : null, args: args };
  }
  function render() {
    if (state.locked) return;
    var r = currentRoute();
    var fn = routes[r.name] || routes.dashboard;
    $$(".nav-link").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === r.name);
    });
    var view = $("#view");
    view.innerHTML = "";
    fn(view, r.arg, r.args);
    view.scrollTop = 0;
    window.scrollTo(0, 0);
  }
  // In-app links use data-go="route" (a bare path, no "#" and no href). The
  // preview harness scans for hash-like strings and calls querySelector on them,
  // which throws on "#/route"; bare paths like "clients" are never treated as a
  // hash. We route via the in-memory router and never touch the URL.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-go]") : null;
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute("data-go"));
  }, true);
  // Delegated actions available from any view: adjust a current lot, add stock.
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var adj = e.target.closest("[data-adj]");
    if (adj) { e.preventDefault(); lotAdjustFlow(adj.getAttribute("data-adj"), function () { render(); }); return; }
    var add = e.target.closest("[data-addstock]");
    if (add) { e.preventDefault(); stockEntryFlow(null, add.getAttribute("data-addstock"), function () { render(); }); return; }
    var mv = e.target.closest("[data-moveitems]");
    if (mv) { e.preventDefault(); moveItemsToStockFlow(mv.getAttribute("data-moveitems"), function () { render(); }); return; }
    var sr = e.target.closest("[data-sendstock]");
    if (sr) { e.preventDefault(); sendStockToRefineryFlow(sr.getAttribute("data-sendstock"), function () { render(); }); return; }
  }, true);

  // ---------------------------------------------------------------------
  // Small DOM builders
  // ---------------------------------------------------------------------
  function field(label, inner) {
    return '<label class="field"><span class="field-label">' + label + "</span>" + inner + "</label>";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function kpi(v, l) { return '<div class="kpi-cell"><b>' + v + "</b><span>" + l + "</span></div>"; }
  function row(k, v) { return '<div class="bd-row"><span>' + k + "</span><b>" + v + "</b></div>"; }

  // Display label for a metal key ("gold" -> "Gold").
  function metalLabel(key) { return P.metalByKey(key).label; }
  // Small coloured pill naming a metal (or "Mixed" for legacy lots with none).
  function metalTag(key) {
    return key
      ? '<span class="metal-tag metal-' + esc(key) + '">' + esc(metalLabel(key)) + "</span>"
      : '<span class="metal-tag metal-mixed">Mixed</span>';
  }
  // Compact "adjustment" note when a manual current-lot correction is active.
  function adjNote(s) {
    if (!s.adjDwt && !s.adjCost) return "";
    var parts = [];
    if (s.adjDwt) parts.push((s.adjDwt > 0 ? "+" : "−") + P.num(Math.abs(s.adjDwt), 2) + " dwt");
    if (s.adjCost) parts.push((s.adjCost > 0 ? "+" : "−") + P.money(Math.abs(s.adjCost)));
    return '<div class="muted small adj-note">manual adjustment: ' + parts.join(" · ") + "</div>";
  }
  // Per-metal OPEN-lot card: accumulated expenses + weight for one metal, with a
  // per-metal "Sell … Lot" CTA and an Edit (manual adjustment) button. Shared by
  // the Dashboard and the Lots view.
  function openLotCardHtml(metalKey, s) {
    var label = metalLabel(metalKey);
    return '<div class="card accum-card metal-' + metalKey + '">' +
      '<div class="row-between"><div class="pl-label">' + esc(label) + " lot</div>" +
        '<div class="card-actions">' +
          (s.count ? '<span class="ok-text">buying</span>' : "") +
          '<button class="edit-chip" data-adj="' + metalKey + '" aria-label="Adjust ' + esc(label) + ' lot">✎</button>' +
        "</div></div>" +
      '<div class="accum-twin">' +
        '<div><div class="pl-label">Accumulated expenses</div><div class="price-big">' + P.money(s.expenses) + "</div></div>" +
        '<div><div class="pl-label">Accumulated weight</div><div class="price-big">' + P.num(s.dwt, 2) + ' <span class="accum-unit">dwt</span></div></div>' +
      "</div>" +
      '<div class="muted small">' +
        (s.count
          ? s.count + " txn" + (s.count === 1 ? "" : "s") + " · " + s.dayCount + " day" + (s.dayCount === 1 ? "" : "s") +
            (s.dateStart ? " · " + lotRange(s.dateStart, s.dateEnd) : "")
          : "No " + label.toLowerCase() + " purchases yet.") +
      "</div>" +
      adjNote(s) +
      (s.count
        ? '<a class="btn btn-primary accum-cta" data-go="melt/sale/' + metalKey + '">Sell ' + esc(label) + " Lot</a>" +
          '<button class="btn btn-ghost btn-sm lot-move" data-moveitems="' + metalKey + '">Move items to Stock</button>'
        : "") +
    "</div>";
  }

  // Per-metal LIVE-STOCK card: held weight + value for one metal, with an Add
  // button and a Manage link into the Live Stock view.
  function stockCardHtml(metalKey, s) {
    var label = metalLabel(metalKey);
    return '<div class="card stock-card metal-' + metalKey + '">' +
      '<div class="row-between"><div class="pl-label">' + esc(label) + " stock</div>" +
        (s.count ? '<span class="muted small">' + s.count + " held</span>" : "") + "</div>" +
      '<div class="accum-twin">' +
        '<div><div class="pl-label">Stock value</div><div class="price-big">' + P.money(s.cost) + "</div></div>" +
        '<div><div class="pl-label">Stock weight</div><div class="price-big">' + P.num(s.dwt, 2) + ' <span class="accum-unit">dwt</span></div></div>' +
      "</div>" +
      '<div class="card-actions stock-actions">' +
        '<button class="btn btn-ghost btn-sm" data-addstock="' + metalKey + '">＋ Add</button>' +
        (s.count ? '<button class="btn btn-ghost btn-sm" data-sendstock="' + metalKey + '">Send to Refinery</button>' : "") +
        '<a class="btn btn-ghost btn-sm" data-go="stock">Manage</a>' +
      "</div>" +
    "</div>";
  }

  // =====================================================================
  // VIEW: DASHBOARD — Expenses · Sales · Profits · Losses (spec v3 §13)
  // =====================================================================
  route("dashboard", function (view) {
    Promise.all([accumulatorSnapshot(), liveSettlements(), DB.all("payments"), computeBalance()]).then(function (r) {
      var acc = r[0], settlements = r[1], payments = r[2].filter(function (p) { return !p.deleted; }), bal = r[3];
      settlements.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });

      var totalSales = settlements.reduce(function (s, x) { return s + (x.saleAmount || 0); }, 0);
      var settledExpenses = settlements.reduce(function (s, x) { return s + (x.accumulatedExpenses || 0); }, 0);
      var netPL = settlements.reduce(function (s, x) { return s + (x.profitLoss || 0); }, 0);
      var totalReceived = payments.reduce(function (s, x) { return s + (x.amount || 0); }, 0);
      var last = settlements[0] || null;

      // Gold, silver and platinum ship to different refineries, so each metal
      // accumulates its OWN open lot: expenses + weight tracked separately.
      var openExpenses = P.METALS.reduce(function (s, m) { return s + acc.perMetal[m.key].expenses; }, 0);

      view.innerHTML =
        '<h1 class="view-title">Dashboard</h1>' +

        // One headline card per metal: accumulated expenses AND total weight in
        // dwt for that metal, each climbing until its refinery sale closes it.
        '<div class="pl-label section-label">Current lots</div>' +
        '<div class="metal-lots">' +
          P.METALS.map(function (m) { return openLotCardHtml(m.key, acc.perMetal[m.key]); }).join("") +
        "</div>" +
        '<div class="muted small accum-note">No profit / loss yet — it is calculated when you sell each metal\'s lot to its refinery.</div>' +

        // Live stock: metal held back for later, separate from the current lot.
        '<div class="row-between section-label"><div class="pl-label">Live stock</div>' +
          '<a class="btn-link" data-go="stock">Manage all →</a></div>' +
        '<div class="metal-lots">' +
          P.METALS.map(function (m) { return stockCardHtml(m.key, acc.perMetalStock[m.key]); }).join("") +
        "</div>" +
        '<div class="muted small accum-note">Metal saved for later. Add to it here, move current-lot transactions in, or fold it into a Custom Lot when you refine.</div>' +

        // Balance (bank account) summary.
        '<a class="card bal-card" data-go="balance"><div class="row-between"><div class="pl-label">Balance</div><span class="btn-link">Manage →</span></div>' +
          '<div class="price-big ' + (bal.balance >= 0 ? "pos" : "neg") + '">' + P.money(bal.balance) + "</div>" +
          '<div class="muted small">' + (bal.opening ? "since baseline " + P.money(bal.base) : "set your total in Balance") + "</div></a>" +

        // Lifetime money tracking.
        '<h2 class="sub">Lifetime</h2>' +
        '<div class="card kpi-grid kpi-3">' +
          kpi(P.money(settledExpenses + openExpenses), "total expenses") +
          kpi(P.money(totalSales), "total refinery sales") +
          kpi('<span class="' + (netPL >= 0 ? "pos" : "neg") + '">' + (netPL >= 0 ? "+" : "−") +
              P.money(Math.abs(netPL)) + "</span>", netPL >= 0 ? "net profit" : "net loss") +
        "</div>" +
        '<div class="card kpi-grid kpi-2">' +
          kpi(P.money(totalReceived), "refinery paid back") +
          kpi(P.money(totalSales - totalReceived), "outstanding from refinery") +
        "</div>" +

        // Last lot sold.
        (last ?
          '<h2 class="sub">Last lot sold · ' + fmtDate(last.date) + "</h2>" +
          '<div class="card pl">' +
            '<div class="pl-label">Profit / Loss</div>' +
            '<div class="pl-big ' + (last.profitLoss >= 0 ? "pos" : "neg") + '">' +
              (last.profitLoss >= 0 ? "+" : "−") + P.money(Math.abs(last.profitLoss)) + "</div>" +
            '<div class="muted small">Sale ' + P.money(last.saleAmount) + " − expenses " +
              P.money(last.accumulatedExpenses) +
              (last.accumulatedDwt ? " · " + P.num(last.accumulatedDwt, 2) + " dwt" : "") + "</div>" +
          "</div>" : "") +

        // Closed lots list.
        '<h2 class="sub">Closed lots</h2>' +
        '<div class="list">' + (settlements.length ? settlements.map(function (s) {
          return '<div class="list-row"><div><b>' + fmtDate(s.date) + "</b> " + metalTag(s.metal) +
            "<br><span class='muted small'>sale " + P.money(s.saleAmount) + " · expenses " +
            P.money(s.accumulatedExpenses) +
            (s.accumulatedDwt ? " · " + P.num(s.accumulatedDwt, 2) + " dwt" : "") + "</span></div>" +
            '<div class="amt"><span class="' + (s.profitLoss >= 0 ? "pos" : "neg") + '">' +
            (s.profitLoss >= 0 ? "+" : "−") + P.money(Math.abs(s.profitLoss)) + "</span></div></div>";
        }).join("") : '<div class="muted card">No lots sold yet.</div>') + "</div>";
    });
    refreshFixChip();
  });

  // =====================================================================
  // VIEW: NEW TRANSACTION — multi-line-item table (spec v5 §2; formula §1)
  // =====================================================================
  route("new", function (view, editTxnId) {
    var cfg = DB.getConfig();
    var tx = { customer: "", date: nyDateStr(), payout: cfg.defaultPayout };
    var items = [];
    // Fixed $/ozt price per metal, entered in Settings (gold London fix, silver
    // & platinum fixes). Loaded at boot; each metal prices off its own fix.
    var fixes = { gold: null, silver: null, platinum: null };
    var fixDates = { gold: null, silver: null, platinum: null };
    // Edit mode: when a txnId is supplied, we load that transaction's line items
    // and, on save, preserve its order/txnId/date and each item's id/settlement.
    var editState = null;   // { txnId, order, date, original:[purchases] }

    function rate() { var v = parseFloat(tx.payout); return (isFinite(v) && v > 0) ? v / 100 : 0; }
    function blankItem() { return { metal: "gold", purity: "14k", unit: "dwt", weight: 0, perUnit: "", priceMode: "auto", pricePerUnit: 0, amount: 0, grossDwt: 0 }; }
    function marketPriceFor(it) { return fixes[it.metal] || 0; }
    // Gold uses karat; silver/platinum purity is typed by hand as a millesimal
    // (e.g. 925), converted to a fineness fraction for the payout math.
    function isGold(it) { return it.metal === "gold"; }
    function karatOf(it) { return isGold(it) ? P.karatFor(it.metal, it.purity) : null; }
    function finenessOf(it) { return isGold(it) ? null : P.finenessFromMille(it.purity); }
    // Auto-suggested price for the chosen unit, from the live formula (London
    // fix for gold, typed spot $/oz for silver/platinum). 0 if no market price.
    function autoPerUnit(it) {
      var market = marketPriceFor(it);
      if (!(market > 0)) return 0;
      return P.calcLineItem({ metal: it.metal, karat: karatOf(it), fineness: finenessOf(it), unit: it.unit, weight: 1, rate: rate(), marketPrice: market }).pricePerUnit;
    }
    // Back-imply a spot $/oz from a custom per-unit price so saved records and
    // receipts still carry a metal price for reference. 0 if not derivable.
    function impliedSpot(it) {
      var karat = karatOf(it);
      var purityFrac = (karat != null) ? P.goldEffFineness(karat) : finenessOf(it);
      var r = rate();
      if (!(purityFrac > 0) || !(r > 0)) return 0;
      return (it.pricePerUnit || 0) * (P.UNITS_PER_OZT[it.unit] || P.DWT_PER_OZT) / (purityFrac * r);
    }
    // Source of truth: a custom override when set, else the auto suggestion.
    function recalc(it) {
      var auto = autoPerUnit(it);
      it._auto = auto;
      var perUnit = (it.priceMode === "custom") ? (parseFloat(it.perUnit) || 0) : auto;
      it.pricePerUnit = perUnit;
      it.grossDwt = P.toDwt(it.weight, it.unit);
      it.amount = perUnit * (Number(it.weight) || 0);
      return it;
    }

    view.innerHTML =
      '<h1 class="view-title">New Transaction</h1>' +
      '<div id="goldBanner"></div>' +
      '<div class="card nt-head-card">' +
        '<div class="nt-head">' +
          field("CUSTOMER",
            '<input id="ntCustomer" class="big-input" type="text" autocomplete="off" placeholder="Search name, phone, email… (optional)">' +
            '<div id="ntClientResults" class="results"></div>' +
            '<div id="ntClientChosen" class="chosen hidden"></div>') +
          field("DATE", '<input id="ntDate" class="big-input" type="date" value="' + tx.date + '">') +
          field("PAYOUT %", '<input id="ntPayout" class="big-input" inputmode="decimal" type="text" value="' + esc(tx.payout) + '">') +
        "</div>" +
      "</div>" +

      '<div class="card nt-table-card">' +
        '<div class="lit-head"><span>METAL</span><span>KARAT</span><span>UNIT</span><span>WEIGHT</span><span>$ / UNIT</span><span>AMOUNT</span><span></span></div>' +
        '<div id="litRows"></div>' +
        '<button id="addItemBtn" class="btn btn-ghost nt-add">+ Add Item</button>' +
      "</div>" +

      '<div class="card nt-total">' +
        '<div><div class="nt-total-label">TOTAL PAYOUT</div><div class="muted small" id="ntCount">0 items</div></div>' +
        '<div class="nt-total-amt" id="ntTotal">$0</div>' +
      "</div>" +

      '<div class="row-gap save-row">' +
        '<button id="saveBtn" class="btn btn-primary btn-xl">Save &amp; Print</button>' +
        '<button id="saveOnlyBtn" class="btn btn-ghost btn-xl">Save Only</button>' +
        '<button id="clearBtn" class="btn btn-ghost btn-xl">Clear</button>' +
      "</div>";

    function purOptions(it) {
      return P.puritiesFor(it.metal).map(function (p) {
        return '<option value="' + p.key + '"' + (p.key === it.purity ? " selected" : "") + ">" + esc(p.label) + "</option>";
      }).join("");
    }
    // Gold gets a karat dropdown; silver/platinum a typed millesimal (e.g. 925).
    function purityCellHtml(it) {
      if (isGold(it)) {
        return '<span class="lit-lbl">KARAT</span><select class="big-input" data-role="purity">' + purOptions(it) + "</select>";
      }
      return '<span class="lit-lbl">PURITY</span>' +
        '<input class="big-input" data-role="purity" inputmode="decimal" type="text" placeholder="925" value="' + esc(it.purity || "") + '">';
    }
    function metalOptions(it) {
      return P.METALS.map(function (m) {
        return '<option value="' + m.key + '"' + (m.key === it.metal ? " selected" : "") + ">" + m.label + "</option>";
      }).join("");
    }
    function unitOptions(it) {
      return ["dwt", "g", "ozt"].map(function (u) {
        var lbl = u === "dwt" ? "DWT" : (u === "g" ? "g" : "ozt");
        return '<option value="' + u + '"' + (u === it.unit ? " selected" : "") + ">" + lbl + "</option>";
      }).join("");
    }
    function priceSubText(it) {
      if (it._auto > 0) return "auto " + P.num(it._auto, 2) + " /" + it.unit;
      if (it.priceMode === "custom") return "custom price";
      return (fixes[it.metal] == null) ? "set " + it.metal + " price in Settings" : "enter price";
    }
    // One editable "$ / unit" field for every metal. It defaults to the auto
    // value (from the metal's fix + formula) but the owner can type any price
    // per dwt/g/ozt.
    function priceCellHtml(it) {
      recalc(it);
      var puVal = (it.priceMode === "custom") ? (it.perUnit || "") : (it._auto ? it._auto.toFixed(2) : "");
      var resetHidden = (it.priceMode === "custom" && it._auto > 0) ? "" : ' style="display:none"';
      return '<input class="big-input lit-perunit" data-role="perunit" inputmode="decimal" type="text" placeholder="$/' + it.unit + '" value="' + esc(puVal) + '">' +
        '<div class="lit-sub">' +
          '<span class="lit-submeta" data-role="priceSub">' + priceSubText(it) + "</span>" +
          '<button type="button" class="btn-link lit-resetbtn" data-role="resetPrice"' + resetHidden + ">use auto</button>" +
        "</div>";
    }
    function rowHtml(it, idx) {
      return '<div class="lit-row" data-idx="' + idx + '">' +
        '<label class="lit-cell"><span class="lit-lbl">METAL</span><select class="big-input" data-role="metal">' + metalOptions(it) + "</select></label>" +
        '<label class="lit-cell">' + purityCellHtml(it) + "</label>" +
        '<label class="lit-cell"><span class="lit-lbl">UNIT</span><select class="big-input" data-role="unit">' + unitOptions(it) + "</select></label>" +
        '<label class="lit-cell"><span class="lit-lbl">WEIGHT</span><input class="big-input" data-role="weight" inputmode="decimal" type="text" value="' + (it.weight || "") + '" placeholder="0.00"></label>' +
        '<label class="lit-cell"><span class="lit-lbl">PRICE</span>' + priceCellHtml(it) + "</label>" +
        '<div class="lit-cell"><span class="lit-lbl">AMOUNT</span><div class="lit-amt" data-role="amount">' + P.money0(it.amount || 0) + "</div></div>" +
        '<button class="lit-x" data-role="remove" aria-label="Remove">×</button>' +
        "</div>";
    }
    function renderRows() {
      $("#litRows", view).innerHTML = items.map(rowHtml).join("");
      recalcTotals();
    }
    function rowEl(idx) { return $('.lit-row[data-idx="' + idx + '"]', view); }
    function updateRowDisplay(idx, opts) {
      opts = opts || {};
      var it = items[idx], el = rowEl(idx); if (!el) return;
      recalc(it);
      var amt = el.querySelector('[data-role="amount"]'); if (amt) amt.textContent = P.money0(it.amount || 0);
      var pu = el.querySelector('[data-role="perunit"]');
      if (pu) {
        pu.placeholder = "$/" + it.unit;
        // Don't overwrite the field the user is actively typing in.
        if (opts.from !== "perunit") {
          pu.value = (it.priceMode === "custom") ? (it.perUnit || "") : (it._auto ? it._auto.toFixed(2) : "");
        }
      }
      var sub = el.querySelector('[data-role="priceSub"]'); if (sub) sub.textContent = priceSubText(it);
      var rb = el.querySelector('[data-role="resetPrice"]'); if (rb) rb.style.display = (it.priceMode === "custom" && it._auto > 0) ? "" : "none";
      recalcTotals();
    }
    function recalcTotals() {
      var tot = items.reduce(function (s, it) { return s + (it.amount || 0); }, 0);
      var n = items.filter(function (it) { return (it.amount || 0) > 0; }).length;
      $("#ntTotal", view).textContent = P.money0(tot);
      $("#ntCount", view).textContent = n + " item" + (n === 1 ? "" : "s");
    }

    // Show each metal's fixed $/ozt price, and warn for any metal currently used
    // in a row that has no fix set yet.
    function drawFixBanner() {
      var el = $("#goldBanner", view);
      var used = {}; items.forEach(function (it) { used[it.metal] = true; });
      var missing = P.METALS.filter(function (m) { return used[m.key] && fixes[m.key] == null; });
      var chips = P.METALS.map(function (m) {
        if (fixes[m.key] == null) return "";
        return '<span class="nt-fixchip">' + esc(m.label) + " <b>" + P.money(fixes[m.key]) + "</b>/oz</span>";
      }).join("");
      var warn = missing.length
        ? '<div class="warn">No fix for ' + missing.map(function (m) { return esc(m.label); }).join(", ") +
          ' — those rows can\'t auto-price. Set it in <a data-go="settings" class="lnk">Settings</a>.</div>'
        : "";
      el.innerHTML = warn + (chips ? '<div class="muted small nt-fix">Fixed prices: ' + chips + "</div>" : "");
    }
    var drawGoldBanner = drawFixBanner;   // keep the old name working for callers

    // --- events (delegated on the rows container) ---
    $("#litRows", view).addEventListener("input", function (e) {
      var el = e.target.closest(".lit-row"); if (!el) return;
      var idx = +el.getAttribute("data-idx"), role = e.target.getAttribute("data-role");
      if (role === "weight") { items[idx].weight = parseFloat(e.target.value) || 0; updateRowDisplay(idx); }
      else if (role === "purity") { items[idx].purity = e.target.value; updateRowDisplay(idx); }  // silver/platinum typed millesimal
      else if (role === "perunit") {
        // Typing a price overrides the formula; clearing it restores auto.
        if (e.target.value.trim() === "") { items[idx].priceMode = "auto"; items[idx].perUnit = ""; }
        else { items[idx].priceMode = "custom"; items[idx].perUnit = e.target.value; }
        updateRowDisplay(idx, { from: "perunit" });
      }
    });
    $("#litRows", view).addEventListener("change", function (e) {
      var el = e.target.closest(".lit-row"); if (!el) return;
      var idx = +el.getAttribute("data-idx"), role = e.target.getAttribute("data-role");
      if (role === "metal") {
        items[idx].metal = e.target.value;
        // Gold defaults to 14k; silver/platinum purity is typed by hand (blank).
        items[idx].purity = (items[idx].metal === "gold") ? "14k" : "";
        items[idx].perUnit = ""; items[idx].priceMode = "auto";
        renderRows();                          // metal change swaps karat/purity cell + price cell type
      } else if (role === "purity") { items[idx].purity = e.target.value; updateRowDisplay(idx); }
      else if (role === "unit") {
        var it = items[idx], oldUnit = it.unit, newUnit = e.target.value;
        // Convert a custom price to the new unit so the dollar intent is kept.
        if (it.priceMode === "custom") {
          var cur = parseFloat(it.perUnit) || 0;
          if (cur > 0) {
            var conv = cur * (P.UNITS_PER_OZT[oldUnit] || P.DWT_PER_OZT) / (P.UNITS_PER_OZT[newUnit] || P.DWT_PER_OZT);
            it.perUnit = String(Math.round(conv * 100) / 100);
          }
        }
        it.unit = newUnit;
        updateRowDisplay(idx);
      }
    });
    $("#litRows", view).addEventListener("click", function (e) {
      var reset = e.target.closest('[data-role="resetPrice"]');
      if (reset) {
        var rEl = reset.closest(".lit-row"); var rIdx = +rEl.getAttribute("data-idx");
        items[rIdx].priceMode = "auto"; items[rIdx].perUnit = "";
        updateRowDisplay(rIdx);
        return;
      }
      var rm = e.target.closest('[data-role="remove"]'); if (!rm) return;
      var el = rm.closest(".lit-row"); var idx = +el.getAttribute("data-idx");
      items.splice(idx, 1);
      if (!items.length) items.push(blankItem());
      renderRows();
    });

    // --- customer search (optional; phone/email optional) — restored ---
    var chosen = null;            // selected existing client, if any
    var custT;
    $("#ntCustomer", view).addEventListener("input", function (e) {
      chosen = null;                                   // typing clears any prior pick
      tx.customer = e.target.value;
      clearTimeout(custT);
      var q = e.target.value.trim().toLowerCase();
      var box = $("#ntClientResults", view);
      if (!q) { box.innerHTML = ""; return; }
      custT = setTimeout(function () {
        DB.all("clients").then(function (cs) {
          var hits = cs.filter(function (c) { return !c.deleted; }).filter(function (c) {
            return (c.name || "").toLowerCase().indexOf(q) >= 0 ||
              (c.phone || "").toLowerCase().indexOf(q) >= 0 ||
              (c.email || "").toLowerCase().indexOf(q) >= 0;
          }).slice(0, 8);
          box.innerHTML = hits.map(function (c) {
            return '<button type="button" class="result-row" data-id="' + c.id + '">' +
              "<b>" + esc(c.name) + "</b><span>" + esc(c.phone || "") +
              (c.email ? " · " + esc(c.email) : "") + "</span></button>";
          }).join("") +
          '<button type="button" class="result-row add-new" data-add="1">+ Add new client “' + esc(e.target.value.trim()) + '”</button>';
        });
      }, 140);
    });
    $("#ntClientResults", view).addEventListener("click", function (e) {
      var add = e.target.closest("[data-add]");
      var rowEl = e.target.closest("[data-id]");
      if (add) { return addClientFlow($("#ntCustomer", view).value.trim(), pickClient); }
      if (rowEl) { DB.get("clients", rowEl.getAttribute("data-id")).then(pickClient); }
    });
    function pickClient(c) {
      if (!c) return;
      chosen = c; tx.customer = c.name;
      $("#ntClientResults", view).innerHTML = "";
      $("#ntCustomer", view).value = "";
      var ch = $("#ntClientChosen", view);
      ch.classList.remove("hidden");
      ch.innerHTML = '<div class="chosen-card"><div><b>' + esc(c.name) + "</b><br><span class='muted'>" +
        esc(c.phone || "") + (c.email ? " · " + esc(c.email) : (c.phone ? "" : "no contact info")) + "</span></div>" +
        '<button type="button" class="btn-link" id="ntClearClient">Change</button></div>';
      $("#ntClearClient", ch).addEventListener("click", function () {
        chosen = null; tx.customer = ""; ch.classList.add("hidden"); ch.innerHTML = "";
      });
    }

    $("#ntDate", view).addEventListener("change", function (e) { tx.date = e.target.value || nyDateStr(); });
    $("#ntPayout", view).addEventListener("input", function (e) {
      tx.payout = e.target.value;
      items.forEach(function (_, i) { updateRowDisplay(i); });   // re-price every row
    });
    $("#addItemBtn", view).addEventListener("click", function () { items.push(blankItem()); renderRows(); });
    $("#clearBtn", view).addEventListener("click", function () { render(); toast("Cleared.", "ok"); });
    $("#saveBtn", view).addEventListener("click", function () { saveTxn(true); });
    $("#saveOnlyBtn", view).addEventListener("click", function () { saveTxn(false); });

    // Use the picked client if one was selected/added; otherwise find-or-create
    // by the typed name. Customer stays optional (blank → no client).
    function resolveClient() {
      if (chosen) return Promise.resolve(chosen);
      var name = (tx.customer || "").trim();
      if (!name) return Promise.resolve(null);
      return DB.all("clients").then(function (cs) {
        var hit = cs.filter(function (c) { return !c.deleted; })
          .find(function (c) { return (c.name || "").toLowerCase() === name.toLowerCase(); });
        if (hit) return hit;
        var c = { id: DB.uid("cli"), name: name, phone: "", email: "", created: nowTs(), deleted: false };
        return saveRecord("clients", c).then(function () { return c; });
      });
    }

    function saveTxn(printAfter) {
      items.forEach(recalc);
      var valid = items.filter(function (it) { return (it.weight || 0) > 0 && (it.pricePerUnit || 0) > 0 && (it.amount || 0) > 0; });
      if (!valid.length) { toast("Add at least one item with a weight and price.", "warn"); return; }
      resolveClient().then(function (client) {
        var date = tx.date || nyDateStr();
        var orderP = editState ? Promise.resolve(editState.order) : nextOrderNo(date);
        return orderP.then(function (order) {
          var ts = nowTs(), txnId = editState ? editState.txnId : DB.uid("txn");
          var recs = valid.map(function (it) {
            var karat = karatOf(it);
            var fineness = (karat != null) ? P.goldEffFineness(karat) : finenessOf(it);
            // Gold: "14k". Silver/platinum: label the typed millesimal, e.g. "Silver - 925".
            var purityLabel = (it.metal === "gold")
              ? P.purityLabel(it.metal, it.purity)
              : (P.metalByKey(it.metal).label + " - " + it.purity);
            var base = {
              id: (it._id || DB.uid("pur")), order: order, txnId: txnId, date: date, ts: (it._ts || ts),
              clientId: client ? client.id : null, clientName: client ? client.name : (tx.customer || ""),
              clientPhone: client ? client.phone : "", clientEmail: client ? client.email : "",
              metal: it.metal, purity: it.purity, purityLabel: purityLabel,
              karat: karat, fineness: fineness, mille: (karat != null ? null : P.mille(fineness)),
              payoutPercent: parseFloat(tx.payout) || 0, rate: rate(),
              metalPrice: (marketPriceFor(it) || impliedSpot(it)),
              priceSource: (it.priceMode === "custom" ? "custom" : "fix"),
              unit: it.unit, weight: it.weight, grossDwt: it.grossDwt,
              pricePerUnit: it.pricePerUnit, pricePerDwt: (it.grossDwt ? it.amount / it.grossDwt : 0),
              price: it.amount,                 // amount — feeds the expense + weight accumulators
              notes: it._notes || "", settlementId: (it._settlementId != null ? it._settlementId : null), deleted: false
            };
            return base;
          });
          // In edit mode, soft-delete the line items that were removed from the txn.
          var keptIds = {}; recs.forEach(function (r) { keptIds[r.id] = true; });
          var removed = editState ? editState.original.filter(function (p) { return !keptIds[p.id]; }) : [];
          var staleAdj = (editState && editState.adjLines) ? editState.adjLines : [];
          return Promise.all(
            recs.map(function (r) { return saveRecord("purchases", r); })
              .concat(removed.map(function (p) { return deleteRecord("purchases", p); }))
              .concat(staleAdj.map(function (p) { return deleteRecord("purchases", p); }))
          ).then(function () {
            return recomputeAffectedSettlements(recs.concat(removed).concat(staleAdj));
          }).then(function () {
            var tot = recs.reduce(function (s, r) { return s + r.price; }, 0);
            toast("Saved " + order + " · " + recs.length + " item" + (recs.length === 1 ? "" : "s") + " · " + P.money(tot), "ok");
            if (printAfter) {
              editableReceiptFlow(recs, cfg.business, function () { go("/purchase/" + recs[0].id); });
            } else {
              go("/purchase/" + recs[0].id);
            }
          });
        });
      });
    }

    // Convert a saved purchase back into an editable form item.
    function itemFromPurchase(p) {
      var nonGold = p.metal !== "gold";
      return {
        metal: p.metal,
        purity: nonGold ? String(p.mille != null ? p.mille : P.mille(p.fineness || 0)) : p.purity,
        unit: p.unit || "dwt",
        weight: p.weight || 0,
        perUnit: (p.priceSource === "custom") ? String(p.pricePerUnit || "") : "",
        priceMode: (p.priceSource === "custom") ? "custom" : "auto",
        pricePerUnit: p.pricePerUnit || 0, amount: p.price || 0, grossDwt: p.grossDwt || 0,
        _id: p.id, _ts: p.ts, _settlementId: p.settlementId || null, _notes: p.notes || ""
      };
    }

    // --- boot the form ---
    if (editTxnId) {
      livePurchases().then(function (all) {
        var mineAll = all.filter(function (p) { return p.txnId === editTxnId || p.id === editTxnId; });
        // A hidden total-override adjustment line is not user-editable here;
        // redefining the transaction's line items clears any stale override.
        var adjLines = mineAll.filter(isAdjustment);
        var mine = mineAll.filter(function (p) { return !isAdjustment(p); });
        if (!mine.length) { toast("Transaction not found.", "warn"); go("/transactions"); return; }
        mine.sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });
        var p0 = mine[0];
        editState = { txnId: p0.txnId || DB.uid("txn"), order: p0.order, date: p0.date, original: mine.slice(), adjLines: adjLines };
        tx.date = p0.date;
        tx.payout = (p0.payoutPercent != null ? p0.payoutPercent : cfg.defaultPayout);
        tx.customer = p0.clientName || "";
        items = mine.map(itemFromPurchase);
        var titleEl = $(".view-title", view); if (titleEl) titleEl.textContent = "Edit Transaction · " + p0.order;
        $("#ntDate", view).value = tx.date;
        $("#ntPayout", view).value = tx.payout;
        if (p0.clientId) { DB.get("clients", p0.clientId).then(function (c) { if (c) pickClient(c); }); }
        else if (tx.customer) { $("#ntCustomer", view).value = tx.customer; }
        renderRows();
      });
    } else {
      items.push(blankItem());
      renderRows();
    }
    drawFixBanner();
    Promise.all(P.METALS.map(function (m) {
      return getEffectiveFix(m.key).then(function (lock) {
        if (lock && lock.fix) { fixes[m.key] = lock.fix; fixDates[m.key] = lock.date; }
      });
    })).then(function () {
      drawFixBanner();
      renderRows();   // rows now price off their metal's fix
    });
    refreshFixChip();
  });
  // The edit view reuses the New Transaction form, pre-loaded with a txn's items.
  route("edit", routes.new);

  // --- Add-client mini flow — email & phone OPTIONAL (spec v3 §3) ---
  function addClientFlow(prefillName, cb) {
    modal(
      '<h2>New Client</h2>' +
      field("Name", '<input id="ncName" class="big-input" type="text" value="' + esc(prefillName || "") + '">') +
      field("Phone (optional)", '<input id="ncPhone" class="big-input" inputmode="tel" type="text">') +
      field("Email (optional)", '<input id="ncEmail" class="big-input" inputmode="email" type="text">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="ncCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="ncSave">Save Client</button></div>',
      function (wrap, close) {
        $("#ncName", wrap).focus();
        $("#ncCancel", wrap).addEventListener("click", close);
        $("#ncSave", wrap).addEventListener("click", function () {
          var name = $("#ncName", wrap).value.trim();
          var phone = $("#ncPhone", wrap).value.trim();
          var email = $("#ncEmail", wrap).value.trim();
          if (!name) { toast("Name is required.", "warn"); return; } // only the name is required now
          DB.all("clients").then(function (cs) {
            cs = cs.filter(function (c) { return !c.deleted; });
            var dupe = cs.find(function (c) {
              return (phone && c.phone && c.phone === phone) ||
                     (email && c.email && c.email.toLowerCase() === email.toLowerCase());
            });
            if (dupe) {
              toast("Matched existing client " + dupe.name + " (same phone/email).", "ok");
              close(); if (cb) cb(dupe); return;
            }
            var client = { id: DB.uid("cli"), name: name, phone: phone, email: email, created: nowTs(), deleted: false };
            saveRecord("clients", client).then(function () {
              close(); if (cb) cb(client);
            });
          });
        });
      });
  }

  // Edit an existing client's name / phone / email. Saving also re-stamps the
  // denormalized clientName/Phone/Email carried on that client's live purchases
  // so history and receipts reflect the correction.
  function editClientFlow(client, cb) {
    modal(
      '<h2>Edit Client</h2>' +
      field("Name", '<input id="ecName" class="big-input" type="text" value="' + esc(client.name || "") + '">') +
      field("Phone (optional)", '<input id="ecPhone" class="big-input" inputmode="tel" type="text" value="' + esc(client.phone || "") + '">') +
      field("Email (optional)", '<input id="ecEmail" class="big-input" inputmode="email" type="text" value="' + esc(client.email || "") + '">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="ecCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="ecSave">Save Changes</button></div>',
      function (wrap, close) {
        $("#ecName", wrap).focus();
        $("#ecCancel", wrap).addEventListener("click", close);
        $("#ecSave", wrap).addEventListener("click", function () {
          var name = $("#ecName", wrap).value.trim();
          if (!name) { toast("Name is required.", "warn"); return; }
          client.name = name;
          client.phone = $("#ecPhone", wrap).value.trim();
          client.email = $("#ecEmail", wrap).value.trim();
          saveRecord("clients", client).then(function () {
            return livePurchases().then(function (all) {
              var mine = all.filter(function (p) { return p.clientId === client.id; });
              return Promise.all(mine.map(function (p) {
                p.clientName = client.name; p.clientPhone = client.phone; p.clientEmail = client.email;
                return saveRecord("purchases", p);
              }));
            });
          }).then(function () {
            close(); toast("Client updated.", "ok"); if (cb) cb(client);
          });
        });
      });
  }

  // =====================================================================
  // VIEW: TRANSACTION DETAIL + RECEIPT — simpler receipt (spec v3 §4)
  // =====================================================================
  route("purchase", function (view, id) {
    DB.get("purchases", id).then(function (p) {
      if (!p) { view.innerHTML = '<div class="card">Transaction not found.</div>'; return; }
      // Gather every line item in this transaction (shared txnId / receipt #).
      return livePurchases().then(function (all) {
        var items = p.txnId ? all.filter(function (x) { return x.txnId === p.txnId; }) : [p];
        if (!items.length) items = [p];
        items.sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });
        var cfg = DB.getConfig(), b = cfg.business;
        view.innerHTML =
          '<div class="row-between"><h1 class="view-title">' + esc(p.order) + "</h1>" +
          '<a class="btn-link" data-go="transactions">← All transactions</a></div>' +
          (p.deleted ? '<div class="warn">This transaction was deleted ' + fmtDateTime(p.deletedTs) + ".</div>" : "") +
          (items.some(function (x) { return x.settlementId; }) ? '<div class="muted small">This transaction is part of a closed lot — edits recompute that lot.</div>' : "") +
          '<div class="row-gap save-row">' +
            (p.deleted ? "" : '<a id="editBtn" class="btn btn-ghost btn-xl" data-go="edit/' + esc(p.txnId || p.id) + '">✎ Edit</a>') +
            (p.deleted ? "" : '<button id="editPrintBtn" class="btn btn-ghost btn-xl">＄ Edit Total &amp; Print</button>') +
            '<button id="printBtn" class="btn btn-primary btn-xl">🖨  Print Receipt</button>' +
          "</div>" +
          '<div class="card receipt-simple" id="receipt">' + receiptHtml(items, b) + "</div>";
        if (!p.deleted) $("#editPrintBtn", view).addEventListener("click", function () {
          editableReceiptFlow(items, b, function () { go("/purchase/" + items[0].id); });
        });
        // 2-tap print: tap Print → print dialog opens immediately (spec v3 §4).
        $("#printBtn", view).addEventListener("click", function () {
          var node = $("#receipt", view).cloneNode(true);
          var holder = $("#print-area");
          holder.innerHTML = ""; holder.appendChild(node);
          window.print();
        });
      });
    });
  });

  // Plain typewriter receipt matching Screenshot 2026-06-16 at 2.43.45 PM.
  // Renders every line item in the transaction; TOTAL sums them.
  function receiptHtml(items, b) {
    // TOTAL sums every record (so a hidden adjustment-line override is included),
    // but only real line items are rendered as rows.
    var total = items.reduce(function (s, i) { return s + i.price; }, 0);
    var visible = items.filter(function (i) { return !isAdjustment(i); });
    var p0 = visible[0] || items[0];
    var metals = visible.map(function (i) { return i.metal; }).filter(function (m, idx, a) { return a.indexOf(m) === idx; });
    var titleMetal = (metals.length === 1) ? P.metalByKey(metals[0]).label.toUpperCase() + " " : "";
    // KT column: gold shows "14K"; silver/platinum show "Silver - 925" etc., so
    // the header stays "KT" even when every row is non-gold.
    var ktHead = "KT";

    // One price line per distinct metal that has a price.
    var priceLines = metals.map(function (m) {
      var it = visible.filter(function (i) { return i.metal === m && i.metalPrice != null; })[0];
      return it ? "<div>" + P.metalByKey(m).label + " Price: " + P.money(it.metalPrice) + " / oz</div>" : "";
    }).join("");

    var rows = visible.map(function (p) {
      var isGold = (p.metal === "gold");
      var ktVal = isGold
        ? ((p.karat != null ? p.karat : "") + "K")
        : (P.metalByKey(p.metal).label + " - " + (p.mille != null ? p.mille : P.mille(p.fineness || 0)));
      var unit = (p.unit || "dwt").toUpperCase();
      var weight = (p.weight != null) ? p.weight : p.grossDwt;
      var perUnit = (p.pricePerUnit != null) ? p.pricePerUnit : (p.pricePerDwt != null ? p.pricePerDwt : (p.grossDwt ? p.price / p.grossDwt : 0));
      return "<tr><td>" + esc(ktVal) + "</td><td>" + unit + "</td><td>" + P.num(weight, 2) + "</td><td>" +
        P.money(perUnit) + "</td><td>" + P.money0(p.price) + "</td></tr>";
    }).join("");

    return '' +
      '<div class="rs-title">ROIZIN JEWELRY</div>' +
      '<div class="rs-sub">' + esc(b.address) + "</div>" +
      '<div class="rs-sub">' + esc(b.phone) + "</div>" +
      '<hr class="rs-hr">' +
      '<div class="rs-h2">' + titleMetal + "PURCHASE RECEIPT</div>" +
      '<div class="rs-rcpt">Receipt #' + esc(p0.order) + "</div>" +
      '<div class="rs-meta">' +
        "<div>Customer: " + esc(p0.clientName) + "</div>" +
        "<div>Date: " + esc(p0.date) + "</div>" +
        priceLines +
      "</div>" +
      '<table class="rs-table">' +
        "<thead><tr><th>" + ktHead + "</th><th>UNIT</th><th>WEIGHT</th><th>PRICE</th><th>AMOUNT</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table>" +
      '<div class="rs-total">TOTAL: ' + P.money0(total) + "</div>" +
      '<div class="rs-thanks">Thank you for your business!</div>';
  }

  // After saving a purchase, pop the receipt with EDITABLE amounts so the owner
  // can nudge figures before printing. Every field is INDEPENDENT and fully
  // manual: editing a line AMOUNT changes only that line, and the TOTAL is its
  // own editable field that does NOT auto-recalculate from the lines. Whatever
  // you type into TOTAL becomes the transaction's official total in the books
  // — it is persisted as a hidden `adjustment` line carrying the difference
  // between your total and the sum of the line amounts, so expenses, the
  // current lot, day summaries, settlements and Balance all reflect it.
  function editableReceiptFlow(recs, business, onDone) {
    recs = recs.slice().sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });
    // Split real line items from any existing total-override adjustment line.
    var lines = recs.filter(function (p) { return !isAdjustment(p); });
    var existingAdj = recs.filter(isAdjustment)[0] || null;
    var initTotal = recs.reduce(function (s, p) { return s + (p.price || 0); }, 0);
    function rowsHtml() {
      return lines.map(function (p) {
        var isGold = (p.metal === "gold");
        var ktVal = isGold ? ((p.karat != null ? p.karat : "") + "K")
          : (P.metalByKey(p.metal).label + " - " + (p.mille != null ? p.mille : P.mille(p.fineness || 0)));
        var unit = (p.unit || "dwt").toUpperCase();
        var weight = (p.weight != null) ? p.weight : p.grossDwt;
        var perUnit = (p.pricePerUnit != null) ? p.pricePerUnit : (p.grossDwt ? p.price / p.grossDwt : 0);
        return "<tr><td>" + esc(ktVal) + "</td><td>" + unit + "</td><td>" + P.num(weight, 2) + "</td><td>" + P.money(perUnit) + "</td>" +
          '<td><input class="er-amt" data-id="' + esc(p.id) + '" inputmode="decimal" type="text" value="' + (Math.round((p.price || 0) * 100) / 100) + '"></td></tr>';
      }).join("");
    }
    modal(
      "<h2>Receipt — edit invoice total &amp; amounts</h2>" +
      '<div class="muted small">You can edit each item AMOUNT and/or the INVOICE TOTAL below. Nothing recalculates automatically — only the number you change changes. Whatever you type as the INVOICE TOTAL is what the books use.</div>' +
      '<div class="card receipt-simple er-receipt"><table class="rs-table"><thead><tr>' +
        "<th>KT</th><th>UNIT</th><th>WEIGHT</th><th>PRICE</th><th>AMOUNT</th></tr></thead><tbody>" + rowsHtml() + "</tbody></table>" +
        '<div class="rs-total"><label for="erTotal">INVOICE TOTAL:</label> <input id="erTotal" class="er-total-input" inputmode="decimal" type="text" value="' + (Math.round(initTotal * 100) / 100) + '"></div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="erSkip">Done (no print)</button>' +
      '<button class="btn btn-primary" id="erPrint">Save &amp; Print</button></div>',
      function (wrap, close) {
        // NOTE: intentionally no auto-recalc listener — line AMOUNT edits do not
        // touch the TOTAL field, and vice versa. Each is manual.
        function readTotal() {
          var el = $("#erTotal", wrap);
          var v = el ? parseFloat(el.value) : initTotal;
          return isFinite(v) ? v : initTotal;
        }
        function apply() {
          // 1) Persist each line's edited amount independently.
          var saves = lines.map(function (p) {
            var el = wrap.querySelector('.er-amt[data-id="' + p.id + '"]');
            var v = el ? parseFloat(el.value) : p.price;
            if (!isFinite(v) || v < 0) v = p.price || 0;
            p.price = v;
            var weight = Number(p.weight) || 0;
            if (weight) p.pricePerUnit = v / weight;
            if (p.grossDwt) p.pricePerDwt = v / p.grossDwt;
            return saveRecord("purchases", p);
          });
          // 2) Reconcile the manual TOTAL via a hidden adjustment line.
          var sumLines = lines.reduce(function (s, p) { return s + (p.price || 0); }, 0);
          var delta = Math.round((readTotal() - sumLines) * 100) / 100;
          var primary = lines[0] || existingAdj;
          var affected = recs.slice();
          if (primary && !primary.txnId) {
            // A solo purchase needs a shared txnId so the adjustment groups with it.
            var newTxn = DB.uid("txn");
            lines.forEach(function (p) { p.txnId = newTxn; });
          }
          var txnId = primary ? primary.txnId : null;
          if (Math.abs(delta) >= 0.005 && primary) {
            var adj = existingAdj || {
              id: DB.uid("adj"), adjustment: true,
              order: primary.order, date: primary.date, ts: (primary.ts || nowTs()) + 1,
              clientId: primary.clientId, clientName: primary.clientName,
              clientPhone: primary.clientPhone, clientEmail: primary.clientEmail,
              purityLabel: "Adjustment"
            };
            adj.txnId = txnId;
            adj.adjustment = true;
            adj.metal = primary.metal;                 // delta belongs to the primary line's metal
            adj.price = delta;
            adj.grossDwt = 0; adj.weight = 0;
            adj.karat = null; adj.fineness = null; adj.mille = null;
            adj.settlementId = primary.settlementId || null; // stay in the same lot/bucket
            adj.stockId = primary.stockId || null;
            adj.deleted = false;
            saves.push(saveRecord("purchases", adj));
            if (affected.indexOf(adj) < 0) affected.push(adj);
          } else if (existingAdj) {
            // Total now equals the line sum — drop the override entirely.
            saves.push(deleteRecord("purchases", existingAdj));
          }
          return Promise.all(saves).then(function () { return recomputeAffectedSettlements(affected); });
        }
        function printItems() {
          // Include the adjustment so the printed TOTAL matches what was entered.
          var sumLines = lines.reduce(function (s, p) { return s + (p.price || 0); }, 0);
          var delta = Math.round((readTotal() - sumLines) * 100) / 100;
          var out = lines.slice();
          if (Math.abs(delta) >= 0.005 && lines[0]) {
            out.push({ adjustment: true, metal: lines[0].metal, price: delta, grossDwt: 0 });
          }
          return out;
        }
        $("#erSkip", wrap).addEventListener("click", function () {
          apply().then(function () { close(); if (onDone) onDone(); });
        });
        $("#erPrint", wrap).addEventListener("click", function () {
          var items = printItems();
          apply().then(function () {
            $("#print-area").innerHTML = '<div class="receipt-simple">' + receiptHtml(items, business) + "</div>";
            close();
            window.print();
            if (onDone) onDone();
          });
        });
      });
  }

  // =====================================================================
  // VIEW: TRANSACTION HISTORY (was "Purchases") — with delete (spec v3 §6, §9)
  // =====================================================================
  route("transactions", function (view) {
    view.innerHTML =
      '<h1 class="view-title">Transaction History</h1>' +
      '<input id="phSearch" class="big-input" type="text" placeholder="Search date, client, phone, email, metal…">' +
      '<div id="phList" class="list"></div>';
    function draw(q) {
      livePurchases().then(function (all) {
        // Sort by the transaction DATE (newest day first), then by entry time
        // within a day. This keeps backdated purchases in their correct day
        // regardless of when they were entered.
        all.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });
        q = (q || "").toLowerCase();
        if (q) all = all.filter(function (p) {
          return [p.order, p.date, p.clientName, p.clientPhone, p.clientEmail, p.metal, p.purityLabel]
            .join(" ").toLowerCase().indexOf(q) >= 0;
        });
        var txns = groupTxns(all);
        // Group transactions by day, newest day first, with a divider that
        // summarises the day PER METAL: money spent and pennyweights (dwt)
        // bought for gold, silver and platinum separately (each ships to its own
        // refinery). Metals are totalled at the line-item level since a single
        // transaction can mix metals. Every unit is already normalised to dwt.
        function blankMetals() {
          var m = {}; P.METALS.forEach(function (x) { m[x.key] = { spent: 0, dwt: 0 }; }); return m;
        }
        var days = [], byDay = {};
        txns.forEach(function (t) {
          if (!byDay[t.date]) { byDay[t.date] = { date: t.date, txns: [], metals: blankMetals() }; days.push(byDay[t.date]); }
          var d = byDay[t.date];
          d.txns.push(t);
          t.items.forEach(function (p) {
            var b = d.metals[p.metal]; if (!b) b = d.metals[p.metal] = { spent: 0, dwt: 0 };
            b.spent += (p.price || 0); b.dwt += (p.grossDwt || 0);
          });
        });
        // Guarantee chronological order (newest day first), and order the
        // transactions within each day by entry time — independent of the
        // order groupTxns happens to return.
        days.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
        days.forEach(function (d) { d.txns.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }); });
        $("#phList", view).innerHTML = txns.length ? days.map(function (d) {
          // One chip per metal that had activity that day.
          var chips = P.METALS.filter(function (m) {
            var b = d.metals[m.key]; return b && (b.spent > 0 || b.dwt > 0);
          }).map(function (m) {
            var b = d.metals[m.key];
            return '<span class="day-metal metal-' + m.key + '"><b>' + esc(m.label) + "</b> " +
              P.money(b.spent) + " · " + P.num(b.dwt, 2) + " dwt</span>";
          }).join("");
          var head =
            '<div class="day-divider">' +
              '<span class="day-date">' + fmtDate(d.date) + "</span>" +
              '<span class="day-stats">' + (chips || '<span class="muted small">—</span>') + "</span>" +
            "</div>";
          var rows = d.txns.map(function (t) {
            var summary = t.items.length === 1
              ? P.metalByKey(t.items[0].metal).label + " " + (t.items[0].karat != null ? t.items[0].karat + "k" : esc(t.items[0].purityLabel))
              : t.items.length + " items";
            var hasStock = t.items.some(function (p) { return p.stockId; });
            var canHold = t.items.some(inCurrentLot);
            var tag = hasStock ? ' <span class="metal-tag metal-mixed">in stock</span>' : (t.settled ? " · settled" : "");
            return '<div class="list-row del-row">' +
              '<a class="del-main" data-go="purchase/' + t.firstId + '">' +
              '<div><b>' + esc(t.clientName) + "</b><span class='muted'> · " + esc(t.order) + "</span>" +
              "<br><span class='muted small'>" + summary +
              " · " + P.num(t.grossDwt, 2) + " dwt</span>" + tag + "</div>" +
              '<div class="amt">' + P.money(t.total) + "</div></a>" +
              (canHold ? '<button class="stock-btn" data-hold="' + esc(t.txnId || t.firstId) + '" title="Move to live stock" aria-label="Move to stock">📥</button>' : "") +
              '<button class="del-btn" data-key="' + esc(t.firstId) + '" aria-label="Delete">🗑</button></div>';
          }).join("");
          return head + rows;
        }).join("") : '<div class="muted card">No transactions yet.</div>';
        $$(".del-btn", view).forEach(function (btn) {
          btn.addEventListener("click", function () {
            DB.get("purchases", btn.getAttribute("data-key")).then(function (p) {
              if (!p) return;
              confirmDelete("Delete transaction " + esc(p.order) +
                "? All its items are removed and accumulated expenses recalculated.", function () {
                deleteTransaction(p).then(function () { toast("Transaction deleted.", "ok"); draw($("#phSearch", view).value); });
              });
            });
          });
        });
        $$(".stock-btn", view).forEach(function (btn) {
          btn.addEventListener("click", function () {
            var key = btn.getAttribute("data-hold");
            confirmAction("Move to Live Stock", "Move this transaction's current-lot metal into Live Stock (held for later)? It stays in your history.", "Move to Stock", function () {
              moveTxnToStock(key, null, "heldback").then(function () { toast("Moved to live stock.", "ok"); draw($("#phSearch", view).value); });
            });
          });
        });
      });
    }
    $("#phSearch", view).addEventListener("input", function (e) { draw(e.target.value); });
    draw("");
  });

  // Soft-delete every line item in a transaction; accumulated expenses + weight
  // recompute automatically (the accumulators only sum live, open purchases).
  function deleteTransaction(p) {
    return livePurchases().then(function (all) {
      var items = p.txnId ? all.filter(function (x) { return x.txnId === p.txnId; }) : [p];
      return Promise.all(items.map(function (it) { return deleteRecord("purchases", it); }));
    });
  }

  // =====================================================================
  // VIEW: CLIENT LIST (was "Clients") — with delete (spec v3 §6, §8)
  // =====================================================================
  route("clients", function (view, arg) {
    if (arg) return clientDetail(view, arg);
    view.innerHTML =
      '<div class="row-between"><h1 class="view-title">Client List</h1>' +
      '<button id="addClient" class="btn btn-primary">+ New Client</button></div>' +
      '<input id="clSearch" class="big-input" type="text" placeholder="Search name, phone, email…">' +
      '<div id="clList" class="list"></div>';
    function draw(q) {
      DB.all("clients").then(function (cs) {
        cs = cs.filter(function (c) { return !c.deleted; });
        cs.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
        q = (q || "").toLowerCase();
        if (q) cs = cs.filter(function (c) {
          return [c.name, c.phone, c.email].join(" ").toLowerCase().indexOf(q) >= 0;
        });
        $("#clList", view).innerHTML = cs.length ? cs.map(function (c) {
          return '<div class="list-row del-row">' +
            '<a class="del-main" data-go="clients/' + c.id + '"><div><b>' + esc(c.name) + "</b>" +
            "<br><span class='muted small'>" + esc(c.phone || "") + (c.email ? " · " + esc(c.email) : "") + "</span></div>" +
            '<div class="chev">›</div></a>' +
            '<button class="del-btn" data-id="' + c.id + '" aria-label="Delete">🗑</button></div>';
        }).join("") : '<div class="muted card">No clients yet.</div>';
        $$(".del-btn", view).forEach(function (btn) {
          btn.addEventListener("click", function () {
            DB.get("clients", btn.getAttribute("data-id")).then(function (c) {
              if (!c) return;
              confirmDelete("Delete client " + esc(c.name) + "? Their past transactions are kept.", function () {
                deleteClient(c).then(function () { toast("Client deleted.", "ok"); draw($("#clSearch", view).value); });
              });
            });
          });
        });
      });
    }
    $("#clSearch", view).addEventListener("input", function (e) { draw(e.target.value); });
    $("#addClient", view).addEventListener("click", function () { addClientFlow("", function () { draw($("#clSearch", view).value); }); });
    draw("");
  });

  function deleteClient(c) {
    return deleteRecord("clients", c);
  }

  function clientDetail(view, id) {
    Promise.all([DB.get("clients", id), livePurchases()]).then(function (r) {
      var c = r[0]; if (!c) { view.innerHTML = '<div class="card">Client not found.</div>'; return; }
      var hist = r[1].filter(function (p) { return p.clientId === id; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });
      var txns = groupTxns(hist);
      var total = hist.reduce(function (s, p) { return s + p.price; }, 0);
      view.innerHTML =
        '<div class="row-between"><h1 class="view-title">' + esc(c.name) + "</h1>" +
        '<a class="btn-link" data-go="clients">← Client List</a></div>' +
        '<div class="card"><div class="row-between"><div class="muted">' + esc(c.phone || "") + (c.email ? " · " + esc(c.email) : (c.phone ? "" : "no contact info")) +
        "</div><button id=\"editClientBtn\" class=\"btn-link\">✎ Edit</button></div>" +
        "<div class='muted small'>Client since " + fmtDateTime(c.created) + "</div>" +
        '<div class="kpi"><span>' + txns.length + " transactions</span><b>" + P.money(total) + " lifetime</b></div></div>" +
        '<h2 class="sub">History</h2><div class="list">' +
        (txns.length ? txns.map(function (t) {
          var summary = t.items.length === 1
            ? P.metalByKey(t.items[0].metal).label + " " + (t.items[0].karat != null ? t.items[0].karat + "k" : esc(t.items[0].purityLabel))
            : t.items.length + " items";
          return '<a class="list-row" data-go="purchase/' + t.firstId + '"><div><b>' + esc(t.order) + "</b>" +
            "<br><span class='muted small'>" + fmtDate(t.date) + " · " + summary + " · " + P.num(t.grossDwt) + " dwt</span></div>" +
            '<div class="amt">' + P.money(t.total) + "</div></a>";
        }).join("") : '<div class="muted card">No transactions yet.</div>') + "</div>";
      $("#editClientBtn", view).addEventListener("click", function () {
        editClientFlow(c, function () { clientDetail(view, id); });
      });
    });
  }

  // =====================================================================
  // VIEW: MELT & REFINERY — combined section
  //   Tabs: Sell Lot | Custom Lot | Payments
  //   Selling a lot is per metal (gold/silver/platinum ship to different
  //   refineries): review that metal's open lot, melt it (dwt before/after ->
  //   melt loss), enter the refinery sale amount, then close the lot ->
  //   settlement -> P/L. Custom Lot hand-picks which transactions shipped.
  // =====================================================================
  function isMetalKey(k) { return P.METALS.some(function (m) { return m.key === k; }); }

  route("melt", function (view, arg, args) {
    args = args || [];
    // Entry paths: melt · melt/sale · melt/sale/<metal> · melt/custom · melt/payments
    var startTab = "melt", startMetal = "gold";
    if (arg === "payments") startTab = "payments";
    else if (arg === "custom") startTab = "custom";
    else if (arg === "sale") { startTab = "melt"; if (isMetalKey(args[1])) startMetal = args[1]; }
    else if (isMetalKey(arg)) { startTab = "melt"; startMetal = arg; }

    view.innerHTML =
      '<h1 class="view-title">Melt &amp; Refinery</h1>' +
      '<div class="tabs" id="mrTabs">' +
        '<button class="tab" data-t="melt">Sell Lot</button>' +
        '<button class="tab" data-t="custom">Custom Lot</button>' +
        '<button class="tab" data-t="payments">Payments</button>' +
      '</div><div id="mrBody"></div>';
    $("#mrTabs", view).addEventListener("click", function (e) {
      var b = e.target.closest(".tab"); if (!b) return;
      drawTab(b.getAttribute("data-t"));
    });
    function setActive(t) { $$(".tab", view).forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-t") === t); }); }
    function drawTab(t) {
      setActive(t);
      var body = $("#mrBody", view);
      if (t === "payments") return drawPayments(body);
      if (t === "custom") return drawCustomLot(body);
      return drawMeltAndSale(body, startMetal, arg === "sale" || isMetalKey(arg));
    }
    drawTab(startTab);
  });

  function drawMeltAndSale(body, metal, focusSale) {
    metal = isMetalKey(metal) ? metal : "gold";
    livePurchases().then(function (all) {
      // Only THIS metal's open purchases are in scope — each metal is its own lot.
      var openAll = all.filter(function (p) { return inCurrentLot(p) && p.metal === metal; });
      var beforeDirty = false; // true once the user hand-edits dwt BEFORE

      // The lot being sold is scoped to purchases dated ON/BEFORE the sale
      // date. Anything bought AFTER the sale date stays in the open lot, so a
      // backdated sale never absorbs future expenses — keeping stats accurate.
      function scopeFor(dateStr) {
        var subset = openAll.filter(function (p) { return String(p.date) <= String(dateStr); });
        var expenses = subset.reduce(function (s, p) { return s + (p.price || 0); }, 0);
        var dwt = subset.reduce(function (s, p) { return s + (p.grossDwt || 0); }, 0);
        var fineDwt = subset.reduce(function (s, p) { return s + (p.grossDwt || 0) * (p.fineness || 0); }, 0);
        var dates = {}; subset.forEach(function (p) { dates[p.date] = true; });
        var dl = Object.keys(dates).sort();
        return {
          purchases: subset, expenses: expenses, dwt: dwt, fineDwt: fineDwt,
          count: subset.length, dayCount: dl.length,
          dateStart: dl[0] || null, dateEnd: dl[dl.length - 1] || null
        };
      }

      var today = nyDateStr();
      var scope = scopeFor(today);

      body.innerHTML =
        // ----- Which metal's lot are we selling? ----------------------------
        '<div class="seg metal-seg" id="metalSeg">' +
          P.METALS.map(function (m) {
            return '<button type="button" class="seg-btn' + (m.key === metal ? " active" : "") +
              '" data-metal="' + m.key + '">' + esc(m.label) + "</button>";
          }).join("") +
        "</div>" +

        // ----- The lot being sold (scoped to the sale date) -----------------
        '<div id="lotSummaryWrap"></div>' +

        // ----- Melt the lot (dwt before/after) ------------------------------
        '<h2 class="sub" id="saleHead">Melt &amp; sell the ' + esc(metalLabel(metal)) + " lot</h2>" +
        '<div class="card">' +
          field("SALE DATE", '<input id="saleDate" class="big-input" type="date" value="' + today + '">') +
          '<div class="grid2">' +
            field("dwt BEFORE melting", '<input id="dwtBefore" class="big-input huge" inputmode="decimal" type="text" placeholder="total dwt">') +
            field("dwt AFTER melting", '<input id="dwtAfter" class="big-input huge" inputmode="decimal" type="text" placeholder="melted dwt">') +
          "</div>" +
          '<div class="meltloss" id="meltLoss"></div>' +

          field("Refinery sale amount received ($)",
            '<input id="saleAmt" class="big-input huge" inputmode="decimal" type="text" placeholder="$ from refinery">') +
          field("Reference / notes (optional)", '<input id="saleRef" class="big-input" type="text" placeholder="Settlement #, wire ref…">') +
          '<div class="card pl" id="settlePreview"></div>' +
          '<button id="registerSaleBtn" class="btn btn-danger btn-xl">Sell ' + esc(metalLabel(metal)) + " Lot &amp; Close</button>" +
          '<div class="muted small">Closing computes profit / loss (sale − accumulated expenses) for this ' + esc(metalLabel(metal).toLowerCase()) + ' lot, then starts a fresh open lot with any later purchases.</div>' +
        "</div>";

      // Switching the metal segment re-scopes the whole flow to that metal's lot.
      $("#metalSeg", body).addEventListener("click", function (e) {
        var b = e.target.closest("[data-metal]"); if (!b) return;
        var m = b.getAttribute("data-metal");
        if (m !== metal) drawMeltAndSale(body, m, false);
      });

      // Render / re-render the scoped lot summary.
      function renderSummary() {
        var later = openAll.length - scope.count;
        $("#lotSummaryWrap", body).innerHTML =
          '<h2 class="sub">' + esc(metalLabel(metal)) + " lot to sell" + (scope.dateStart ? " · " + lotRange(scope.dateStart, scope.dateEnd) : "") + "</h2>" +
          '<div class="card lot-summary"><div class="kpi-grid">' +
            kpi(scope.count, "transactions") +
            kpi(scope.dayCount + " day" + (scope.dayCount === 1 ? "" : "s"), "buying days") +
            kpi(P.num(scope.dwt, 2) + " dwt", "gross bought") +
            kpi(P.num(scope.fineDwt, 2) + " dwt", "fine content") +
            kpi(P.money(scope.expenses), "accumulated expenses") +
          "</div>" +
          (later > 0
            ? '<div class="muted small scope-note">Counts purchases up to the sale date. ' + later +
              " later purchase" + (later === 1 ? " stays" : "s stay") + " in the open lot.</div>"
            : "") +
          "</div>";
      }

      // Keep dwt BEFORE in sync with the scoped weight until the user edits it.
      function syncBeforeDefault() {
        if (beforeDirty) return;
        var f = $("#dwtBefore", body);
        if (f) f.value = scope.count ? scope.dwt.toFixed(2) : "";
      }

      // melt loss (whole lot)
      function recomputeMelt() {
        var before = parseFloat($("#dwtBefore", body).value) || 0;
        var after = parseFloat($("#dwtAfter", body).value);
        var ml = $("#meltLoss", body);
        if (after && before && after <= before) {
          var lossDwt = before - after, lossPct = before ? lossDwt / before : 0;
          ml.innerHTML = '<div class="bd-row"><span>Melt loss</span><b>' + P.num(lossDwt, 2) + " dwt · " + P.pct(lossPct, 2) + "</b></div>";
        } else {
          ml.innerHTML = '<div class="muted">Enter before/after dwt to see the lot\'s melt loss.</div>';
        }
      }

      // settlement preview + register
      function recomputeSettle() {
        var sale = parseFloat($("#saleAmt", body).value);
        var pv = $("#settlePreview", body);
        if (!sale || sale <= 0) {
          pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big pending">Enter the sale amount</div>';
          return;
        }
        var pl = sale - scope.expenses;
        pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big ' + (pl >= 0 ? "pos" : "neg") + '">' +
          (pl >= 0 ? "+" : "−") + P.money(Math.abs(pl)) + "</div>" +
          '<div class="muted small">Sale ' + P.money(sale) + " − accumulated expenses " + P.money(scope.expenses) + "</div>";
      }

      $("#dwtBefore", body).addEventListener("input", function () { beforeDirty = true; recomputeMelt(); });
      $("#dwtAfter", body).addEventListener("input", recomputeMelt);
      $("#saleAmt", body).addEventListener("input", recomputeSettle);
      $("#saleDate", body).addEventListener("change", function () {
        scope = scopeFor($("#saleDate", body).value || today);
        renderSummary(); syncBeforeDefault(); recomputeMelt(); recomputeSettle();
      });

      renderSummary(); syncBeforeDefault(); recomputeMelt(); recomputeSettle();

      $("#registerSaleBtn", body).addEventListener("click", function () {
        var sale = parseFloat($("#saleAmt", body).value);
        if (!sale || sale <= 0) { toast("Enter the refinery sale amount.", "warn"); return; }
        if (!scope.count) { toast("No purchases on/before this sale date to sell.", "warn"); return; }
        var before = parseFloat($("#dwtBefore", body).value) || scope.dwt;
        var after = parseFloat($("#dwtAfter", body).value);
        var saleDate = $("#saleDate", body).value || today;
        var melt = {
          dwtBefore: before,
          dwtAfter: (after > 0 ? after : null),
          meltLossDwt: (after > 0 ? before - after : null),
          meltLossPct: (after > 0 && before) ? (before - after) / before : null,
          saleDate: saleDate
        };
        registerRefinerySale(sale, $("#saleRef", body).value.trim(), scope, melt, { metal: metal, scope: "metal" }).then(function (st) {
          toast(metalLabel(metal) + " lot closed · " + (st.profitLoss >= 0 ? "profit " : "loss ") + P.money(Math.abs(st.profitLoss)), "ok");
          go("/lots");
        });
      });

      if (focusSale) { var h = $("#saleHead", body); if (h) h.scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
  }

  // CUSTOM LOT: hand-pick which open transactions of ONE metal were shipped to
  // the refinery, then enter the melted weight + money received. Produces a
  // settlement scoped to exactly the picked line items (scope: "custom").
  function drawCustomLot(body) {
    var cMetal = "gold";
    var selected = {};            // txn key -> true
    var selStock = {};            // stock id -> true
    var beforeDirty = false;

    function keyOfPur(p) { return p.txnId || ("solo_" + p.id); }

    function reload() {
      Promise.all([livePurchases(), liveStockEntries()]).then(function (r) {
        var openOfMetal = r[0].filter(function (p) { return inCurrentLot(p) && p.metal === cMetal; });
        var stockOfMetal = r[1].filter(function (e) { return !e.settlementId && e.metal === cMetal; });
        render(openOfMetal, stockOfMetal);
      });
    }

    function render(openOfMetal, stockOfMetal) {
      var txns = groupTxns(openOfMetal);
      var today = nyDateStr();

      function pickedTxns() { return openOfMetal.filter(function (p) { return selected[keyOfPur(p)]; }); }
      function pickedStock() { return stockOfMetal.filter(function (e) { return selStock[e.id]; }); }
      function combined() { return summarizeMembers(pickedTxns(), pickedStock()); }

      function txnRow(t) {
        var key = t.txnId || ("solo_" + t.firstId);
        return '<label class="list-row csel-row"><div class="del-main del-static"><div>' +
          '<input type="checkbox" class="cchk" data-key="' + esc(key) + '"' + (selected[key] ? " checked" : "") + "> " +
          "<b>" + esc(t.order) + '</b> <span class="muted">' + esc(t.clientName || "") + "</span>" +
          "<br><span class='muted small'>" + fmtDate(t.date) + " · " + P.num(t.grossDwt, 2) + " dwt</span></div></div>" +
          '<div class="amt">' + P.money(t.total) + "</div></label>";
      }
      function stockRowSel(e) {
        return '<label class="list-row csel-row"><div class="del-main del-static"><div>' +
          '<input type="checkbox" class="cstk" data-id="' + esc(e.id) + '"' + (selStock[e.id] ? " checked" : "") + "> " +
          "<b>" + P.num(e.dwt, 2) + " dwt</b> <span class='muted'>" + esc(e.source && e.source !== "manual" ? e.source : "stock") + "</span>" +
          "<br><span class='muted small'>" + fmtDate(e.date) + stockPurityText(e) + (e.notes ? " · " + esc(e.notes) : "") + "</span></div></div>" +
          '<div class="amt">' + P.money(e.cost) + "</div></label>";
      }

      // Group open transactions by DATE (newest first) so a whole day can be
      // selected at once — e.g. "select all transactions for July 12".
      var byDate = {}, dateOrder = [];
      txns.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); })
        .forEach(function (t) {
          if (!byDate[t.date]) { byDate[t.date] = []; dateOrder.push(t.date); }
          byDate[t.date].push(t);
        });
      function keysForDate(date) {
        return (byDate[date] || []).map(function (t) { return t.txnId || ("solo_" + t.firstId); });
      }
      var txnListHtml = txns.length
        ? dateOrder.map(function (date) {
            var group = byDate[date];
            var gd = group.reduce(function (s, t) { return s + (t.grossDwt || 0); }, 0);
            var gtot = group.reduce(function (s, t) { return s + (t.total || 0); }, 0);
            var allSel = group.every(function (t) { return selected[t.txnId || ("solo_" + t.firstId)]; });
            return '<div class="csel-datehead">' +
                '<div><b>' + fmtDate(date) + "</b> <span class='muted small'>" + group.length + " txn" + (group.length === 1 ? "" : "s") +
                  " · " + P.num(gd, 2) + " dwt · " + P.money(gtot) + "</span></div>" +
                '<button type="button" class="btn-link csel-all" data-seldate="' + esc(date) + '">' + (allSel ? "Clear" : "Select all") + "</button>" +
              "</div>" +
              group.map(txnRow).join("");
          }).join("")
        : '<div class="muted card">No open ' + esc(metalLabel(cMetal).toLowerCase()) + " transactions.</div>";

      body.innerHTML =
        '<div class="muted small pay-intro">Hand-pick the transactions and/or held stock you shipped to the refinery for one metal, then enter the melted weight and money received.</div>' +
        '<div class="seg metal-seg" id="cMetalSeg">' +
          P.METALS.map(function (m) {
            return '<button type="button" class="seg-btn' + (m.key === cMetal ? " active" : "") +
              '" data-metal="' + m.key + '">' + esc(m.label) + "</button>";
          }).join("") +
        "</div>" +
        '<h2 class="sub">Open ' + esc(metalLabel(cMetal)) + " transactions</h2>" +
        '<div id="cList" class="list">' + txnListHtml + "</div>" +
        '<h2 class="sub">' + esc(metalLabel(cMetal)) + " live stock</h2>" +
        '<div id="cStock" class="list">' +
          (stockOfMetal.length ? stockOfMetal.map(stockRowSel).join("") : '<div class="muted card">No ' + esc(metalLabel(cMetal).toLowerCase()) + " stock held.</div>") +
        "</div>" +
        '<h2 class="sub">Melt &amp; sell selected</h2>' +
        '<div class="card">' +
          '<div class="card lot-summary" id="cSel"></div>' +
          field("SALE DATE", '<input id="cDate" class="big-input" type="date" value="' + today + '">') +
          '<div class="grid2">' +
            field("dwt BEFORE melting", '<input id="cBefore" class="big-input huge" inputmode="decimal" type="text" placeholder="total dwt">') +
            field("dwt AFTER melting", '<input id="cAfter" class="big-input huge" inputmode="decimal" type="text" placeholder="melted dwt">') +
          "</div>" +
          '<div class="meltloss" id="cMelt"></div>' +
          field("Refinery sale amount received ($)", '<input id="cSaleAmt" class="big-input huge" inputmode="decimal" type="text" placeholder="$ from refinery">') +
          field("Reference / notes (optional)", '<input id="cRef" class="big-input" type="text" placeholder="Settlement #, wire ref…">') +
          '<div class="card pl" id="cPL"></div>' +
          '<button id="cRegister" class="btn btn-danger btn-xl">Create Custom Lot &amp; Close</button>' +
          '<div class="muted small">Closes a lot for exactly the selected ' + esc(metalLabel(cMetal).toLowerCase()) + ' transactions and stock. Un-selected transactions of this metal move into Live Stock.</div>' +
        "</div>";

      function refreshSel() {
        var s = combined();
        if (!beforeDirty) { var bf = $("#cBefore", body); if (bf) bf.value = s.count ? s.dwt.toFixed(2) : ""; }
        $("#cSel", body).innerHTML = '<div class="kpi-grid">' +
          kpi(s.count, "items selected") +
          kpi(P.num(s.dwt, 2) + " dwt", "gross selected") +
          kpi(P.money(s.expenses), "cost basis") +
        "</div>";
        recomputeMelt(); recomputePL(s);
      }
      function recomputeMelt() {
        var before = parseFloat($("#cBefore", body).value) || 0;
        var after = parseFloat($("#cAfter", body).value);
        var ml = $("#cMelt", body);
        if (after && before && after <= before) {
          var lossDwt = before - after, lossPct = before ? lossDwt / before : 0;
          ml.innerHTML = '<div class="bd-row"><span>Melt loss</span><b>' + P.num(lossDwt, 2) + " dwt · " + P.pct(lossPct, 2) + "</b></div>";
        } else {
          ml.innerHTML = '<div class="muted">Enter before/after dwt to see melt loss.</div>';
        }
      }
      function recomputePL(s) {
        s = s || combined();
        var sale = parseFloat($("#cSaleAmt", body).value);
        var pv = $("#cPL", body);
        if (!sale || sale <= 0) { pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big pending">Enter the sale amount</div>'; return; }
        var pl = sale - s.expenses;
        pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big ' + (pl >= 0 ? "pos" : "neg") + '">' +
          (pl >= 0 ? "+" : "−") + P.money(Math.abs(pl)) + "</div>" +
          '<div class="muted small">Sale ' + P.money(sale) + " − cost " + P.money(s.expenses) + "</div>";
      }

      $("#cMetalSeg", body).addEventListener("click", function (e) {
        var b = e.target.closest("[data-metal]"); if (!b) return;
        var m = b.getAttribute("data-metal");
        if (m === cMetal) return;
        cMetal = m; selected = {}; selStock = {}; beforeDirty = false; reload();
      });
      $("#cList", body).addEventListener("change", function (e) {
        var chk = e.target.closest(".cchk"); if (!chk) return;
        var key = chk.getAttribute("data-key");
        if (chk.checked) selected[key] = true; else delete selected[key];
        // Keep the day's Select-all/Clear label in sync with its rows.
        syncDateHeads();
        refreshSel();
      });
      // "Select all" / "Clear" for a whole day: toggles every transaction dated
      // that day, updating the checkboxes and label in place (sale inputs kept).
      $("#cList", body).addEventListener("click", function (e) {
        var btn = e.target.closest("[data-seldate]"); if (!btn) return;
        e.preventDefault();
        var date = btn.getAttribute("data-seldate");
        var keys = keysForDate(date);
        var allSel = keys.length && keys.every(function (k) { return selected[k]; });
        keys.forEach(function (k) {
          if (allSel) delete selected[k]; else selected[k] = true;
          var cb = body.querySelector('.cchk[data-key="' + k + '"]');
          if (cb) cb.checked = !allSel;
        });
        syncDateHeads();
        refreshSel();
      });
      function syncDateHeads() {
        $$(".csel-all", body).forEach(function (btn) {
          var keys = keysForDate(btn.getAttribute("data-seldate"));
          var allSel = keys.length && keys.every(function (k) { return selected[k]; });
          btn.textContent = allSel ? "Clear" : "Select all";
        });
      }
      $("#cStock", body).addEventListener("change", function (e) {
        var chk = e.target.closest(".cstk"); if (!chk) return;
        var id = chk.getAttribute("data-id");
        if (chk.checked) selStock[id] = true; else delete selStock[id];
        refreshSel();
      });
      $("#cBefore", body).addEventListener("input", function () { beforeDirty = true; recomputeMelt(); });
      $("#cAfter", body).addEventListener("input", recomputeMelt);
      $("#cSaleAmt", body).addEventListener("input", function () { recomputePL(); });

      $("#cRegister", body).addEventListener("click", function () {
        var chosenP = pickedTxns(), chosenS = pickedStock();
        if (!chosenP.length && !chosenS.length) { toast("Select at least one transaction or stock entry.", "warn"); return; }
        var sale = parseFloat($("#cSaleAmt", body).value);
        if (!sale || sale <= 0) { toast("Enter the refinery sale amount.", "warn"); return; }
        var acc = summarizeMembers(chosenP, chosenS);
        var before = parseFloat($("#cBefore", body).value) || acc.dwt;
        var after = parseFloat($("#cAfter", body).value);
        var saleDate = $("#cDate", body).value || today;
        var melt = {
          dwtBefore: before,
          dwtAfter: (after > 0 ? after : null),
          meltLossDwt: (after > 0 ? before - after : null),
          meltLossPct: (after > 0 && before) ? (before - after) / before : null,
          saleDate: saleDate
        };
        registerRefinerySale(sale, $("#cRef", body).value.trim(), acc, melt, { metal: cMetal, scope: "custom" }).then(function (st) {
          // Un-selected current-lot transactions of this metal are held for later.
          var leftover = openOfMetal.filter(function (p) { return !selected[keyOfPur(p)]; });
          return Promise.all(leftover.map(function (p) { return moveePurchaseToStock(p, "leftover"); })).then(function () {
            return { st: st, held: leftover.length };
          });
        }).then(function (res) {
          toast("Custom " + metalLabel(cMetal) + " lot closed · " + (res.st.profitLoss >= 0 ? "profit " : "loss ") + P.money(Math.abs(res.st.profitLoss)) +
            (res.held ? " · " + res.held + " held to stock" : ""), "ok");
          go("/lots");
        });
      });

      refreshSel();
    }

    reload();
  }

  // After editing purchases that belong to closed lots, re-derive each affected
  // settlement's totals from its CURRENT live members so expenses / weight /
  // profit-loss stay correct. Pass any purchases that were saved or deleted.
  function recomputeAffectedSettlements(purchases) {
    var ids = {};
    purchases.forEach(function (p) { if (p.settlementId) ids[p.settlementId] = true; });
    var idList = Object.keys(ids);
    if (!idList.length) return Promise.resolve();
    return Promise.all([livePurchases(), liveStockEntries()]).then(function (r) {
      var all = r[0], stockAll = r[1];
      return Promise.all(idList.map(function (sid) {
        return DB.get("settlements", sid).then(function (st) {
          if (!st || st.deleted) return;
          var members = all.filter(function (p) { return p.settlementId === sid; });
          var stkMembers = stockAll.filter(function (e) { return e.settlementId === sid; });
          var s = summarizeMembers(members, stkMembers);
          st.accumulatedExpenses = s.expenses;
          st.accumulatedDwt = s.dwt;
          st.txnCount = s.count;
          st.dayCount = s.dayCount;
          st.dateStart = s.dateStart; st.dateEnd = s.dateEnd;
          st.purchaseIds = members.map(function (p) { return p.id; });
          st.stockIds = stkMembers.map(function (e) { return e.id; });
          st.profitLoss = (Number(st.saleAmount) || 0) - s.expenses;
          return saveRecord("settlements", st);
        });
      }));
    });
  }

  // Close the open lot: P/L = sale − accumulated expenses; record the whole-lot
  // melt (dwt before/after); then start a fresh lot by stamping every open
  // purchase with this settlement id. A settlement record IS the closed lot.
  function registerRefinerySale(saleAmount, reference, acc, melt, meta) {
    melt = melt || {}; meta = meta || {};
    var stockMembers = acc.stock || [];
    var st = {
      id: DB.uid("set"), ts: nowTs(), date: (melt.saleDate || nyDateStr()), saleAmount: Number(saleAmount),
      metal: meta.metal || null, scope: meta.scope || "metal",
      accumulatedExpenses: acc.expenses, accumulatedDwt: acc.dwt, profitLoss: Number(saleAmount) - acc.expenses,
      txnCount: acc.count, dayCount: acc.dayCount,
      dateStart: acc.dateStart, dateEnd: acc.dateEnd,
      dwtBefore: (melt.dwtBefore != null ? melt.dwtBefore : acc.dwt),
      dwtAfter: (melt.dwtAfter != null ? melt.dwtAfter : null),
      meltLossDwt: (melt.meltLossDwt != null ? melt.meltLossDwt : null),
      meltLossPct: (melt.meltLossPct != null ? melt.meltLossPct : null),
      purchaseIds: acc.purchases.map(function (p) { return p.id; }),
      stockIds: stockMembers.map(function (e) { return e.id; }),
      reference: reference || "", deleted: false
    };
    return saveRecord("settlements", st).then(function () {
      return Promise.all(
        acc.purchases.map(function (p) { p.settlementId = st.id; return saveRecord("purchases", p); })
          .concat(stockMembers.map(function (e) { e.settlementId = st.id; return saveRecord("livestock", e); }))
      );
    }).then(function () { return st; });
  }

  // Delete a closed lot / refinery sale: un-stamp its purchases AND stock members
  // so they return (the sale is undone), then mark the settlement deleted.
  function deleteSettlement(st) {
    return Promise.all([livePurchases(), liveStockEntries()]).then(function (r) {
      var purMembers = r[0].filter(function (p) { return p.settlementId === st.id; });
      var stkMembers = r[1].filter(function (e) { return e.settlementId === st.id; });
      return Promise.all(
        purMembers.map(function (p) { p.settlementId = null; return saveRecord("purchases", p); })
          .concat(stkMembers.map(function (e) { e.settlementId = null; return saveRecord("livestock", e); }))
      );
    }).then(function () { return deleteRecord("settlements", st); });
  }

  // Edit a closed lot's sale amount, melt weights, date and reference. Profit /
  // loss is re-derived from the (unchanged) accumulated expenses.
  function editSettlementFlow(st, cb) {
    var beforeVal = (st.dwtBefore != null ? st.dwtBefore : "");
    var afterVal = (st.dwtAfter != null ? st.dwtAfter : "");
    modal(
      '<h2>Edit Closed Lot</h2>' +
      (st.metal ? '<div class="muted small">' + esc(metalLabel(st.metal)) + " lot</div>" : "") +
      field("Sale date", '<input id="esDate" class="big-input" type="date" value="' + esc(st.date || nyDateStr()) + '">') +
      '<div class="grid2">' +
        field("dwt BEFORE melting", '<input id="esBefore" class="big-input" inputmode="decimal" type="text" value="' + esc(beforeVal) + '">') +
        field("dwt AFTER melting", '<input id="esAfter" class="big-input" inputmode="decimal" type="text" value="' + esc(afterVal) + '">') +
      "</div>" +
      field("Refinery sale amount ($)", '<input id="esSale" class="big-input huge" inputmode="decimal" type="text" value="' + esc(st.saleAmount != null ? st.saleAmount : "") + '">') +
      field("Reference / notes", '<input id="esRef" class="big-input" type="text" value="' + esc(st.reference || "") + '">') +
      '<div class="muted small">Accumulated expenses ' + P.money(st.accumulatedExpenses || 0) + " ��� profit / loss updates from the sale amount.</div>" +
      '<div class="modal-actions"><button class="btn btn-ghost" id="esCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="esSave">Save Changes</button></div>',
      function (wrap, close) {
        $("#esCancel", wrap).addEventListener("click", close);
        $("#esSave", wrap).addEventListener("click", function () {
          var sale = parseFloat($("#esSale", wrap).value);
          if (!sale || sale <= 0) { toast("Enter the sale amount.", "warn"); return; }
          var before = parseFloat($("#esBefore", wrap).value);
          var after = parseFloat($("#esAfter", wrap).value);
          st.saleAmount = sale;
          st.date = $("#esDate", wrap).value || st.date;
          st.dwtBefore = (before > 0 ? before : null);
          st.dwtAfter = (after > 0 ? after : null);
          st.meltLossDwt = (after > 0 && before > 0 ? before - after : null);
          st.meltLossPct = (after > 0 && before > 0 ? (before - after) / before : null);
          st.reference = $("#esRef", wrap).value.trim();
          st.profitLoss = sale - (st.accumulatedExpenses || 0);
          saveRecord("settlements", st).then(function () {
            close(); toast("Lot updated.", "ok"); if (cb) cb(st);
          });
        });
      });
  }

  function drawPayments(body) {
    body.innerHTML =
      '<div class="muted small pay-intro">Money the refinery sent back. Recorded for the books; profit / loss is set when you register the sale.</div>' +
      '<button id="addPay" class="btn btn-primary btn-xl">+ Record Refinery Payment</button>' +
      '<div id="payTotals" class="card kpi-grid kpi-3"></div>' +
      '<div id="payList" class="list"></div>';
    $("#addPay", body).addEventListener("click", function () { addPaymentFlow(function () { drawPayments(body); }); });
    Promise.all([DB.all("payments"), liveSettlements()]).then(function (r) {
      var ps = r[0].filter(function (p) { return !p.deleted; });
      var settlements = r[1];
      ps.sort(function (a, b) { return b.ts - a.ts; });
      var totalReceived = ps.reduce(function (s, p) { return s + p.amount; }, 0);
      var totalSales = settlements.reduce(function (s, x) { return s + (x.saleAmount || 0); }, 0);
      $("#payTotals", body).innerHTML =
        kpi(P.money(totalSales), "total sales") +
        kpi(P.money(totalReceived), "received") +
        kpi(P.money(totalSales - totalReceived), "outstanding");
      $("#payList", body).innerHTML = ps.length ? ps.map(function (p) {
        return '<div class="list-row del-row"><div class="del-main del-static"><div><b>' + P.money(p.amount) + "</b>" +
          "<br><span class='muted small'>" + fmtDate(p.date) +
          (p.reference ? " · ref " + esc(p.reference) : "") + "</span></div></div>" +
          '<button class="edit-btn" data-id="' + esc(p.id) + '" aria-label="Edit payment">✎</button>' +
          '<button class="del-btn" data-id="' + esc(p.id) + '" aria-label="Delete payment">🗑</button></div>';
      }).join("") : '<div class="muted card">No payments recorded.</div>';

      $$(".edit-btn", body).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("payments", btn.getAttribute("data-id")).then(function (p) {
            if (p) addPaymentFlow(function () { drawPayments(body); }, p);
          });
        });
      });

      $$(".del-btn", body).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("payments", btn.getAttribute("data-id")).then(function (p) {
            if (!p) return;
            confirmDelete("Delete this refinery payment (" + P.money(p.amount) + " on " + fmtDate(p.date) + ")?", function () {
              deleteRecord("payments", p).then(function () { toast("Payment deleted.", "ok"); drawPayments(body); });
            });
          });
        });
      });
    });
  }

  // Record a new refinery payment, or edit an existing one when `existing` is passed.
  function addPaymentFlow(cb, existing) {
    var ed = existing || null;
    modal(
      "<h2>" + (ed ? "Edit" : "Record") + " Refinery Payment</h2>" +
      field("Payment date", '<input id="payDate" class="big-input" type="date" value="' + esc(ed ? ed.date : nyDateStr()) + '">') +
      field("Amount received ($)", '<input id="payAmt" class="big-input huge" inputmode="decimal" type="text" placeholder="0.00" value="' + esc(ed ? ed.amount : "") + '">') +
      field("Reference / notes", '<input id="payRef" class="big-input" type="text" placeholder="Check #, wire ref…" value="' + esc(ed ? ed.reference || "" : "") + '">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="payCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="paySave">Save Payment</button></div>',
      function (wrap, close) {
        $("#payCancel", wrap).addEventListener("click", close);
        $("#paySave", wrap).addEventListener("click", function () {
          var amt = parseFloat($("#payAmt", wrap).value);
          if (!amt || amt <= 0) { toast("Enter an amount.", "warn"); return; }
          var pay = ed || { id: DB.uid("pay"), ts: nowTs(), deleted: false };
          pay.date = $("#payDate", wrap).value || nyDateStr();
          pay.amount = amt;
          pay.reference = $("#payRef", wrap).value.trim();
          saveRecord("payments", pay).then(function () {
            close(); toast(ed ? "Payment updated." : "Payment recorded.", "ok"); if (cb) cb();
          });
        });
      });
  }

  // =====================================================================
  // VIEW: LOTS — the current OPEN lot (accumulating across days) plus every
  // CLOSED lot (a lot is closed when it's melted & sold to the refinery).
  // A closed lot IS a settlement record. All weights shown in dwt.
  // =====================================================================
  route("lots", function (view) {
    Promise.all([accumulatorSnapshot(), liveSettlements()]).then(function (r) {
      var acc = r[0], settlements = r[1];
      settlements.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });

      // One OPEN-lot card per metal — each accumulates until it's shipped to its
      // own refinery. Plus a Custom Lot button for hand-picked shipments.
      var openCards =
        '<div class="metal-lots">' +
          P.METALS.map(function (m) { return openLotCardHtml(m.key, acc.perMetal[m.key]); }).join("") +
        "</div>";

      view.innerHTML =
        '<div class="row-between"><h1 class="view-title">Lots</h1>' +
        '<a class="btn btn-primary" data-go="melt/custom">Custom Lot</a></div>' +
        '<div class="muted small lots-note">Gold, silver and platinum each accumulate their own lot and ship to different refineries. Sell a metal\'s lot from its card, or build a Custom Lot from hand-picked transactions.</div>' +
        openCards +
        '<h2 class="sub">Closed lots</h2>' +
        '<div class="list">' + (settlements.length ? settlements.map(function (s) {
          var span = (s.dateStart) ? lotRange(s.dateStart, s.dateEnd) : fmtDate(s.date);
          return '<div class="list-row del-row"><div class="del-main del-static"><div><b>' + span + "</b> " + metalTag(s.metal) +
            (s.scope === "custom" ? ' <span class="metal-tag metal-mixed">custom</span>' : "") +
            "<br><span class='muted small'>" + (s.txnCount || 0) + " txns · " + P.num(s.accumulatedDwt || 0, 2) + " dwt · expenses " + P.money(s.accumulatedExpenses) +
            (s.meltLossDwt != null ? " · melt loss " + P.num(s.meltLossDwt, 2) + " dwt" : "") +
            " · sold " + fmtDate(s.date) + "</span></div>" +
            '<span class="' + (s.profitLoss >= 0 ? "pos" : "neg") + '">' +
            (s.profitLoss >= 0 ? "+" : "−") + P.money(Math.abs(s.profitLoss)) + "</span></div>" +
            '<button class="edit-btn" data-id="' + esc(s.id) + '" aria-label="Edit lot">✎</button>' +
            '<button class="del-btn" data-id="' + esc(s.id) + '" aria-label="Delete lot">🗑</button></div>';
        }).join("") : '<div class="muted card">No lots sold yet.</div>') + "</div>";

      $$(".edit-btn", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("settlements", btn.getAttribute("data-id")).then(function (s) {
            if (s) editSettlementFlow(s, function () { render(); });
          });
        });
      });

      $$(".del-btn", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("settlements", btn.getAttribute("data-id")).then(function (s) {
            if (!s) return;
            confirmDelete("Delete this sold lot (" + fmtDate(s.date) + ", P/L " +
              (s.profitLoss >= 0 ? "+" : "−") + P.money(Math.abs(s.profitLoss)) +
              ")? Its purchases return to the open lot so you can re-sell them.", function () {
              deleteSettlement(s).then(function () { toast("Lot deleted.", "ok"); render(); });
            });
          });
        });
      });
    });
  });

  // =====================================================================
  // VIEW: LIVE STOCK — held metal, itemized per metal (add / edit / delete).
  //   Separate from the current lot; can be folded into a Custom Lot later.
  // =====================================================================
  function stockPurityText(e) {
    if (e.metal === "gold") return e.karat ? " · " + e.karat + "k" : "";
    return e.mille ? " · " + metalLabel(e.metal) + " " + e.mille : "";
  }
  route("stock", function (view) {
    liveStockEntries().then(function (all) {
      var stock = all.filter(function (e) { return !e.settlementId; });
      function stockRow(e) {
        return '<div class="list-row del-row"><div class="del-main del-static"><div>' +
          "<b>" + P.num(e.dwt, 2) + " dwt</b> <span class='muted'>" + P.money(e.cost) + "</span>" +
          "<br><span class='muted small'>" + fmtDate(e.date) + stockPurityText(e) +
          (e.source && e.source !== "manual" ? " · " + esc(e.source) : "") +
          (e.notes ? " · " + esc(e.notes) : "") + "</span></div></div>" +
          '<button class="edit-btn stk-edit" data-id="' + esc(e.id) + '" aria-label="Edit stock">✎</button>' +
          '<button class="del-btn stk-del" data-id="' + esc(e.id) + '" aria-label="Delete stock">🗑</button></div>';
      }
      view.innerHTML =
        '<h1 class="view-title">Live Stock</h1>' +
        '<div class="muted small lots-note">Metal held back and saved for later — separate from the current lot. Add stock here, or fold it into a Custom Lot when you refine.</div>' +
        P.METALS.map(function (m) {
          var entries = stock.filter(function (e) { return e.metal === m.key; })
            .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });
          var s = summarizeStock(entries);
          return '<div class="card stock-metal metal-' + m.key + '">' +
            '<div class="row-between"><h2 class="sub stock-metal-h">' + esc(m.label) + "</h2>" +
              '<div class="card-actions">' +
                (entries.length ? '<button class="btn btn-ghost btn-sm" data-sendstock="' + m.key + '">Send to Refinery</button>' : "") +
                '<button class="btn btn-ghost btn-sm" data-addstock="' + m.key + '">＋ Add</button>' +
              "</div></div>" +
            '<div class="kpi-grid kpi-2">' +
              '<div class="kpi-cell"><b>' + P.num(s.dwt, 2) + " dwt</b><span>held weight</span></div>" +
              '<div class="kpi-cell"><b>' + P.money(s.cost) + "</b><span>held value</span></div></div>" +
            '<div class="list">' + (entries.length ? entries.map(stockRow).join("") : '<div class="muted card">No ' + esc(m.label.toLowerCase()) + " stock.</div>") + "</div>" +
          "</div>";
        }).join("");

      $$(".stk-edit", view).forEach(function (b) {
        b.addEventListener("click", function () {
          DB.get("livestock", b.getAttribute("data-id")).then(function (e) {
            if (e) stockEntryFlow(e, e.metal, function () { render(); });
          });
        });
      });
      $$(".stk-del", view).forEach(function (b) {
        b.addEventListener("click", function () {
          DB.get("livestock", b.getAttribute("data-id")).then(function (e) {
            if (!e) return;
            confirmDelete("Delete this " + esc(metalLabel(e.metal)) + " stock (" + P.num(e.dwt, 2) + " dwt)?" +
              (e.fromPurchaseId ? " Its transaction returns to the current lot." : ""), function () {
              deleteStockEntry(e, function () { toast("Stock deleted.", "ok"); render(); });
            });
          });
        });
      });
    });
  });

  // Add or edit one live-stock entry. `metalDefault` seeds the metal for new entries.
  function stockEntryFlow(entry, metalDefault, cb) {
    var ed = entry || null;
    var metal0 = ed ? ed.metal : (metalDefault || "gold");
    var purVal = ed ? (ed.metal === "gold" ? (ed.karat || "") : (ed.mille || "")) : "";
    modal(
      "<h2>" + (ed ? "Edit" : "Add") + " Stock</h2>" +
      field("Metal", '<select id="stMetal" class="big-input">' + P.METALS.map(function (m) {
        return '<option value="' + m.key + '"' + (m.key === metal0 ? " selected" : "") + ">" + m.label + "</option>";
      }).join("") + "</select>") +
      '<div class="grid2">' +
        field("Weight", '<input id="stWeight" class="big-input" inputmode="decimal" type="text" value="' + esc(ed ? ed.dwt : "") + '" placeholder="0.00">') +
        field("Unit", '<select id="stUnit" class="big-input"><option value="dwt" selected>DWT</option><option value="g">g</option><option value="ozt">ozt</option></select>') +
      "</div>" +
      '<div class="grid2">' +
        field("Purity (optional)", '<input id="stPurity" class="big-input" inputmode="decimal" type="text" value="' + esc(purVal) + '" placeholder="' + (metal0 === "gold" ? "14" : "925") + '">') +
        field("Cost $ (optional)", '<input id="stCost" class="big-input" inputmode="decimal" type="text" value="' + esc(ed ? ed.cost : "") + '" placeholder="0.00">') +
      "</div>" +
      field("Date", '<input id="stDate" class="big-input" type="date" value="' + esc(ed ? ed.date : nyDateStr()) + '">') +
      field("Notes (optional)", '<input id="stNotes" class="big-input" type="text" value="' + esc(ed ? ed.notes || "" : "") + '">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="stCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="stSave">Save Stock</button></div>',
      function (wrap, close) {
        $("#stCancel", wrap).addEventListener("click", close);
        $("#stSave", wrap).addEventListener("click", function () {
          var metal = $("#stMetal", wrap).value;
          var unit = $("#stUnit", wrap).value;
          var dwt = P.toDwt(parseFloat($("#stWeight", wrap).value) || 0, unit);
          if (!(dwt > 0)) { toast("Enter a weight.", "warn"); return; }
          var purRaw = $("#stPurity", wrap).value.trim();
          var fineness = null, mille = null, karat = null;
          if (purRaw) {
            if (metal === "gold") { var k = parseFloat(purRaw); if (k > 0) { karat = k; fineness = P.goldEffFineness(k); } }
            else { fineness = P.finenessFromMille(purRaw); mille = P.mille(fineness); }
          }
          var rec = ed || { id: DB.uid("stk"), ts: nowTs(), source: "manual", fromPurchaseId: null, settlementId: null };
          rec.kind = "stock"; rec.metal = metal; rec.dwt = dwt;
          rec.fineness = fineness; rec.mille = mille; rec.karat = karat;
          rec.cost = parseFloat($("#stCost", wrap).value) || 0;
          rec.date = $("#stDate", wrap).value || nyDateStr();
          rec.notes = $("#stNotes", wrap).value.trim();
          rec.deleted = false;
          saveRecord("livestock", rec).then(function () {
            close(); toast(ed ? "Stock updated." : "Stock added.", "ok"); if (cb) cb();
          });
        });
      });
  }

  // Delete a stock entry; if it was moved from a purchase, return that purchase
  // to its current lot by clearing its stockId.
  function deleteStockEntry(entry, cb) {
    var p = deleteRecord("livestock", entry);
    if (entry.fromPurchaseId) {
      p = p.then(function () { return DB.get("purchases", entry.fromPurchaseId); }).then(function (pur) {
        if (pur && pur.stockId === entry.id) { pur.stockId = null; return saveRecord("purchases", pur); }
      });
    }
    return p.then(function () { if (cb) cb(); });
  }

  // Move an open purchase into live stock: create a stock entry mirroring it and
  // stamp the purchase with stockId so it leaves the current lot (receipt kept).
  function moveePurchaseToStock(p, source) {
    var entry = {
      id: DB.uid("stk"), kind: "stock", metal: p.metal, dwt: p.grossDwt || 0,
      fineness: (p.fineness != null ? p.fineness : null),
      mille: (p.mille != null ? p.mille : null),
      karat: (p.karat != null ? p.karat : null),
      cost: p.price || 0, date: p.date, ts: nowTs(),
      notes: "from " + (p.order || ""), source: source || "heldback",
      fromPurchaseId: p.id, settlementId: null, deleted: false
    };
    return saveRecord("livestock", entry).then(function () {
      p.stockId = entry.id; return saveRecord("purchases", p);
    }).then(function () { return entry; });
  }

  // Move every current-lot line item of a transaction (optionally only one metal)
  // into live stock.
  function moveTxnToStock(txnId, metalFilter, source) {
    return livePurchases().then(function (all) {
      var items = all.filter(function (p) {
        return inCurrentLot(p) && (p.txnId === txnId || p.id === txnId) &&
          (!metalFilter || p.metal === metalFilter);
      });
      return Promise.all(items.map(function (p) { return moveePurchaseToStock(p, source); }));
    });
  }

  // FEATURE 1a — pick individual current-lot line items of ONE metal (grouped by
  // invoice) and move only those into Live Stock; the rest stay in the lot.
  function moveItemsToStockFlow(metal, cb) {
    livePurchases().then(function (all) {
      var items = all.filter(function (p) { return inCurrentLot(p) && p.metal === metal; })
        .sort(function (a, b) { return String(a.order).localeCompare(String(b.order)) || (a.ts - b.ts); });
      if (!items.length) { toast("No " + metalLabel(metal).toLowerCase() + " in the current lot.", "warn"); return; }
      var sel = {};
      function itemRow(p) {
        var kt = p.metal === "gold" ? ((p.karat != null ? p.karat : "") + "k")
          : ((p.mille != null ? p.mille : P.mille(p.fineness || 0)) + "");
        return '<label class="list-row csel-row"><div class="del-main del-static"><div>' +
          '<input type="checkbox" class="miChk" data-id="' + esc(p.id) + '"' + (sel[p.id] ? " checked" : "") + "> " +
          "<b>" + esc(p.order) + '</b> <span class="muted">' + esc(kt) + "</span>" +
          "<br><span class='muted small'>" + fmtDate(p.date) + " · " + P.num(p.grossDwt, 2) + " dwt</span></div></div>" +
          '<div class="amt">' + P.money(p.price) + "</div></label>";
      }
      modal(
        "<h2>Move " + esc(metalLabel(metal)) + " items to Stock</h2>" +
        '<div class="muted small">Pick line items to hold in Live Stock. Unselected items stay in the current lot.</div>' +
        '<div class="list mi-list">' + items.map(itemRow).join("") + "</div>" +
        '<div class="modal-actions"><button class="btn btn-ghost" id="miCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="miMove">Move selected</button></div>',
        function (wrap, close) {
          wrap.addEventListener("change", function (e) {
            var c = e.target.closest(".miChk"); if (!c) return;
            if (c.checked) sel[c.getAttribute("data-id")] = true; else delete sel[c.getAttribute("data-id")];
          });
          $("#miCancel", wrap).addEventListener("click", close);
          $("#miMove", wrap).addEventListener("click", function () {
            var chosen = items.filter(function (p) { return sel[p.id]; });
            if (!chosen.length) { toast("Select at least one item.", "warn"); return; }
            Promise.all(chosen.map(function (p) { return moveePurchaseToStock(p, "heldback"); })).then(function () {
              close(); toast(chosen.length + " item" + (chosen.length === 1 ? "" : "s") + " moved to stock.", "ok"); if (cb) cb();
            });
          });
        });
    });
  }

  // FEATURE 1b — pick individual held stock items of ONE metal and ship only
  // those to the refinery (settlement); unselected items stay in Live Stock.
  function sendStockToRefineryFlow(metal, cb) {
    liveStockEntries().then(function (all) {
      var entries = all.filter(function (e) { return !e.settlementId && e.metal === metal; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });
      if (!entries.length) { toast("No " + metalLabel(metal).toLowerCase() + " stock held.", "warn"); return; }
      var sel = {}, today = nyDateStr();
      function picked() { return entries.filter(function (e) { return sel[e.id]; }); }
      function stkRow(e) {
        return '<label class="list-row csel-row"><div class="del-main del-static"><div>' +
          '<input type="checkbox" class="srChk" data-id="' + esc(e.id) + '"' + (sel[e.id] ? " checked" : "") + "> " +
          "<b>" + P.num(e.dwt, 2) + " dwt</b> <span class='muted'>" + P.money(e.cost) + "</span>" +
          "<br><span class='muted small'>" + fmtDate(e.date) + stockPurityText(e) + (e.notes ? " · " + esc(e.notes) : "") + "</span></div></div></label>";
      }
      modal(
        "<h2>Send " + esc(metalLabel(metal)) + " stock to Refinery</h2>" +
        '<div class="muted small">Pick held items to ship. Unselected items stay in Live Stock.</div>' +
        '<div class="list">' + entries.map(stkRow).join("") + "</div>" +
        '<div class="card lot-summary" id="srSel"></div>' +
        field("SALE DATE", '<input id="srDate" class="big-input" type="date" value="' + today + '">') +
        '<div class="grid2">' +
          field("dwt BEFORE melting", '<input id="srBefore" class="big-input" inputmode="decimal" type="text" placeholder="total dwt">') +
          field("dwt AFTER melting", '<input id="srAfter" class="big-input" inputmode="decimal" type="text" placeholder="melted dwt">') +
        "</div>" +
        field("Refinery sale amount received ($)", '<input id="srSale" class="big-input huge" inputmode="decimal" type="text" placeholder="$ from refinery">') +
        field("Reference / notes (optional)", '<input id="srRef" class="big-input" type="text" placeholder="Settlement #, wire ref…">') +
        '<div class="card pl" id="srPL"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="srCancel">Cancel</button>' +
        '<button class="btn btn-danger" id="srGo">Send &amp; Close</button></div>',
        function (wrap, close) {
          var beforeDirty = false;
          function refresh() {
            var s = summarizeStock(picked());
            if (!beforeDirty) { var bf = $("#srBefore", wrap); if (bf) bf.value = s.count ? s.dwt.toFixed(2) : ""; }
            $("#srSel", wrap).innerHTML = '<div class="kpi-grid">' +
              kpi(s.count, "items") + kpi(P.num(s.dwt, 2) + " dwt", "selected") + kpi(P.money(s.cost), "cost basis") + "</div>";
            pl();
          }
          function pl() {
            var s = summarizeStock(picked());
            var sale = parseFloat($("#srSale", wrap).value);
            var pv = $("#srPL", wrap);
            if (!sale || sale <= 0) { pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big pending">Enter the sale amount</div>'; return; }
            var d = sale - s.cost;
            pv.innerHTML = '<div class="pl-label">Profit / Loss</div><div class="pl-big ' + (d >= 0 ? "pos" : "neg") + '">' +
              (d >= 0 ? "+" : "−") + P.money(Math.abs(d)) + "</div>" +
              '<div class="muted small">Sale ' + P.money(sale) + " − cost " + P.money(s.cost) + "</div>";
          }
          wrap.addEventListener("change", function (e) {
            var c = e.target.closest(".srChk"); if (!c) return;
            if (c.checked) sel[c.getAttribute("data-id")] = true; else delete sel[c.getAttribute("data-id")];
            refresh();
          });
          $("#srBefore", wrap).addEventListener("input", function () { beforeDirty = true; });
          $("#srSale", wrap).addEventListener("input", pl);
          $("#srCancel", wrap).addEventListener("click", close);
          $("#srGo", wrap).addEventListener("click", function () {
            var chosen = picked();
            if (!chosen.length) { toast("Select at least one item.", "warn"); return; }
            var sale = parseFloat($("#srSale", wrap).value);
            if (!sale || sale <= 0) { toast("Enter the refinery sale amount.", "warn"); return; }
            var acc = summarizeMembers([], chosen);
            var before = parseFloat($("#srBefore", wrap).value) || acc.dwt;
            var after = parseFloat($("#srAfter", wrap).value);
            var saleDate = $("#srDate", wrap).value || today;
            var melt = {
              dwtBefore: before, dwtAfter: (after > 0 ? after : null),
              meltLossDwt: (after > 0 ? before - after : null),
              meltLossPct: (after > 0 && before) ? (before - after) / before : null,
              saleDate: saleDate
            };
            registerRefinerySale(sale, $("#srRef", wrap).value.trim(), acc, melt, { metal: metal, scope: "custom" }).then(function (st) {
              close(); toast(metalLabel(metal) + " stock lot closed · " + (st.profitLoss >= 0 ? "profit " : "loss ") + P.money(Math.abs(st.profitLoss)), "ok"); if (cb) cb();
            });
          });
          refresh();
        });
    });
  }

  // Manual current-lot adjustment (Feature D): a ± weight / ± cost correction
  // stored as a single lotadj record per metal.
  function lotAdjustFlow(metal, cb) {
    var id = "lotadj_" + metal;
    DB.get("livestock", id).then(function (cur) {
      var live = cur && !cur.deleted;
      modal(
        "<h2>Adjust " + esc(metalLabel(metal)) + " Lot</h2>" +
        '<div class="muted small">A manual correction added to this metal\'s current-lot totals. It does not change any transaction.</div>' +
        '<div class="grid2">' +
          field("Weight adjustment (± dwt)", '<input id="ajDwt" class="big-input" inputmode="decimal" type="text" value="' + esc(live ? cur.dwt : "") + '" placeholder="0.00">') +
          field("Cost adjustment (± $)", '<input id="ajCost" class="big-input" inputmode="decimal" type="text" value="' + esc(live ? cur.cost : "") + '" placeholder="0.00">') +
        "</div>" +
        '<div class="modal-actions"><button class="btn btn-ghost" id="ajCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="ajSave">Save</button></div>',
        function (wrap, close) {
          $("#ajCancel", wrap).addEventListener("click", close);
          $("#ajSave", wrap).addEventListener("click", function () {
            var dwt = parseFloat($("#ajDwt", wrap).value) || 0;
            var cost = parseFloat($("#ajCost", wrap).value) || 0;
            var done = function () { close(); toast("Lot adjusted.", "ok"); if (cb) cb(); };
            var rec = cur || { id: id };
            rec.id = id; rec.kind = "lotadj"; rec.metal = metal; rec.dwt = dwt; rec.cost = cost; rec.deleted = false;
            if (!dwt && !cost) {
              if (live) { deleteRecord("livestock", rec).then(done); } else { close(); if (cb) cb(); }
            } else {
              saveRecord("livestock", rec).then(done);
            }
          });
        });
    });
  }

  // =====================================================================
  // BALANCE — a running cash account. You insert your current total (opening),
  // then it moves DOWN by each purchase payout and UP by each refinery sale,
  // plus manual Emergent Expenses (−) and Fulfillments (+). Re-inserting the
  // total re-baselines: only activity AT/AFTER the opening's timestamp counts.
  // =====================================================================
  function liveCash() {
    return DB.all("cash").then(function (all) { return all.filter(function (c) { return !c.deleted; }); });
  }
  function computeBalance() {
    return Promise.all([liveCash(), livePurchases(), liveSettlements()]).then(function (r) {
      var cash = r[0], purchases = r[1], settlements = r[2];
      var opening = cash.filter(function (c) { return c.kind === "opening"; })[0] || null;
      var base = opening ? (opening.amount || 0) : 0;
      var baseTs = opening ? (opening.ts || 0) : 0;
      var after = function (x) { return (x.ts || 0) >= baseTs; };
      var purchasesOut = purchases.filter(after).reduce(function (s, p) { return s + (p.price || 0); }, 0);
      var refineryIn = settlements.filter(after).reduce(function (s, x) { return s + (x.saleAmount || 0); }, 0);
      var fulfillIn = cash.filter(function (c) { return c.kind === "fulfillment" && after(c); }).reduce(function (s, c) { return s + (c.amount || 0); }, 0);
      var emergentOut = cash.filter(function (c) { return c.kind === "emergent" && after(c); }).reduce(function (s, c) { return s + (c.amount || 0); }, 0);
      var balance = base - purchasesOut + refineryIn + fulfillIn - emergentOut;
      var entries = cash.filter(function (c) { return c.kind === "emergent" || c.kind === "fulfillment"; })
        .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return {
        opening: opening, base: base, balance: balance,
        purchasesOut: purchasesOut, refineryIn: refineryIn, fulfillIn: fulfillIn, emergentOut: emergentOut,
        entries: entries
      };
    });
  }

  route("balance", function (view) {
    computeBalance().then(function (b) {
      function entryRow(c) {
        var pos = c.kind === "fulfillment";
        return '<div class="list-row del-row"><div class="del-main del-static"><div><b>' +
          (pos ? "+" : "−") + P.money(c.amount) + '</b> <span class="metal-tag metal-mixed">' + (pos ? "fulfillment" : "emergent") + "</span>" +
          "<br><span class='muted small'>" + fmtDate(c.date) + (c.note ? " · " + esc(c.note) : "") + "</span></div></div>" +
          '<button class="edit-btn cash-edit" data-id="' + esc(c.id) + '" aria-label="Edit">✎</button>' +
          '<button class="del-btn cash-del" data-id="' + esc(c.id) + '" aria-label="Delete">🗑</button></div>';
      }
      view.innerHTML =
        '<div class="row-between"><h1 class="view-title">Balance</h1>' +
          '<button class="btn btn-ghost btn-sm" id="balSet">Set total</button></div>' +
        '<div class="card accum-card"><div class="pl-label">Current balance</div>' +
          '<div class="price-big ' + (b.balance >= 0 ? "pos" : "neg") + '">' + P.money(b.balance) + "</div>" +
          '<div class="muted small">' + (b.opening ? "Baseline " + P.money(b.base) + " set " + fmtDate(b.opening.date) : "No opening total set — press “Set total”.") + "</div>" +
        "</div>" +
        '<div class="row-gap"><button class="btn btn-danger" id="balEmergent">− Emergent Expense</button>' +
          '<button class="btn btn-primary" id="balFulfill">＋ Fulfillment</button></div>' +
        '<h2 class="sub">Since baseline</h2>' +
        '<div class="card kpi-grid kpi-2">' +
          kpi(P.money(b.base), "opening total") +
          kpi("−" + P.money(b.purchasesOut), "purchase payouts") +
          kpi("+" + P.money(b.refineryIn), "refinery sales") +
          kpi("+" + P.money(b.fulfillIn) + " / −" + P.money(b.emergentOut), "fulfillments / emergent") +
        "</div>" +
        '<h2 class="sub">Manual entries</h2>' +
        '<div class="list">' + (b.entries.length ? b.entries.map(entryRow).join("") : '<div class="muted card">No emergent expenses or fulfillments yet.</div>') + "</div>";

      $("#balSet", view).addEventListener("click", function () { setBalanceFlow(function () { render(); }); });
      $("#balEmergent", view).addEventListener("click", function () { cashEntryFlow("emergent", null, function () { render(); }); });
      $("#balFulfill", view).addEventListener("click", function () { cashEntryFlow("fulfillment", null, function () { render(); }); });
      $$(".cash-edit", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("cash", btn.getAttribute("data-id")).then(function (c) { if (c) cashEntryFlow(c.kind, c, function () { render(); }); });
        });
      });
      $$(".cash-del", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          DB.get("cash", btn.getAttribute("data-id")).then(function (c) {
            if (!c) return;
            confirmDelete("Delete this " + c.kind + " entry (" + P.money(c.amount) + ")?", function () {
              deleteRecord("cash", c).then(function () { toast("Entry deleted.", "ok"); render(); });
            });
          });
        });
      });
    });
  });

  // Insert / re-baseline the current total cash on hand.
  function setBalanceFlow(cb) {
    DB.get("cash", "cash_opening").then(function (cur) {
      modal(
        "<h2>Set Balance Total</h2>" +
        '<div class="muted small">Enter the total money you currently have. This becomes the baseline — only purchases, refinery sales and adjustments from now on change it.</div>' +
        field("Total on hand ($)", '<input id="balAmt" class="big-input huge" inputmode="decimal" type="text" value="' + esc(cur && !cur.deleted ? cur.amount : "") + '" placeholder="0.00">') +
        '<div class="modal-actions"><button class="btn btn-ghost" id="balCancel">Cancel</button>' +
        '<button class="btn btn-primary" id="balSave">Save Total</button></div>',
        function (wrap, close) {
          $("#balCancel", wrap).addEventListener("click", close);
          $("#balSave", wrap).addEventListener("click", function () {
            var v = parseFloat($("#balAmt", wrap).value);
            if (!isFinite(v)) { toast("Enter an amount.", "warn"); return; }
            var rec = { id: "cash_opening", kind: "opening", amount: v, ts: nowTs(), date: nyDateStr(), deleted: false };
            saveRecord("cash", rec).then(function () { close(); toast("Balance total set.", "ok"); if (cb) cb(); });
          });
        });
    });
  }

  // Record (or edit) an Emergent Expense (money out) or Fulfillment (money in).
  function cashEntryFlow(kind, existing, cb) {
    var ed = existing || null;
    var isOut = kind === "emergent";
    modal(
      "<h2>" + (ed ? "Edit " : "") + (isOut ? "Emergent Expense" : "Fulfillment") + "</h2>" +
      '<div class="muted small">' + (isOut ? "Money you took out of the account." : "Money you added to the account.") + "</div>" +
      field("Amount ($)", '<input id="ceAmt" class="big-input huge" inputmode="decimal" type="text" value="' + esc(ed ? ed.amount : "") + '" placeholder="0.00">') +
      field("Date", '<input id="ceDate" class="big-input" type="date" value="' + esc(ed ? ed.date : nyDateStr()) + '">') +
      field("Note (optional)", '<input id="ceNote" class="big-input" type="text" value="' + esc(ed ? ed.note || "" : "") + '">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="ceCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="ceSave">Save</button></div>',
      function (wrap, close) {
        $("#ceCancel", wrap).addEventListener("click", close);
        $("#ceSave", wrap).addEventListener("click", function () {
          var v = parseFloat($("#ceAmt", wrap).value);
          if (!v || v <= 0) { toast("Enter an amount.", "warn"); return; }
          var rec = ed || { id: DB.uid("cash"), kind: kind, ts: nowTs() };
          rec.kind = kind; rec.amount = v; rec.date = $("#ceDate", wrap).value || nyDateStr();
          rec.note = $("#ceNote", wrap).value.trim(); rec.deleted = false;
          saveRecord("cash", rec).then(function () { close(); toast("Saved.", "ok"); if (cb) cb(); });
        });
      });
  }

  // =====================================================================
  // VIEW: SETTINGS — config + daily fix (spec v3 §2 + Config block)
  // =====================================================================
  route("settings", function (view) {
    var cfg = DB.getConfig();
    var date = fixEffectiveDate();
    view.innerHTML =
      '<h1 class="view-title">Settings</h1>' +

      '<h2 class="sub">Metal Prices (manual $/ozt)</h2>' +
      '<div class="muted small">Each metal prices off the fixed $/ozt you enter here (the most recent is used until you update it). Gold uses the London fix + payout %; silver = fix × 0.75 × purity; platinum = (fix − 35) × purity × 0.85. Today (NY): <b>' + fmtDate(date) + "</b></div>" +
      P.METALS.map(function (m) {
        var ph = m.key === "gold" ? "e.g. 2350.00" : (m.key === "silver" ? "e.g. 30.00" : "e.g. 1000.00");
        return '<div class="card metal-' + m.key + '">' +
          '<div class="row-between"><b>' + esc(m.label) + '</b><div class="fix-state" data-fixstate="' + m.key + '"></div></div>' +
          field(m.label + " fix $/ozt", '<input class="big-input" data-fxval="' + m.key + '" inputmode="decimal" type="text" placeholder="' + ph + '">') +
          '<button class="btn btn-primary" data-fxlock="' + m.key + '">Save ' + esc(m.label) + " Fix for Today</button></div>";
      }).join("") +

      '<h2 class="sub">Cross-Device Sync</h2>' +
      '<div class="card">' +
      field("Sync endpoint", '<input id="cfgGas" class="big-input" type="text" value="' + esc(cfg.appsScriptUrl) + '" placeholder="/api/sync">') +
      field("Owner email", '<input id="cfgOwner" class="big-input" inputmode="email" type="text" value="' + esc(cfg.ownerEmail) + '">') +
      '<div class="muted small">Defaults to this app\'s built-in cloud database (<b>/api/sync</b>). Every device that opens this app stays in sync automatically — writes save to the cloud and other devices refresh every few seconds. Leave the endpoint as <b>/api/sync</b> unless you are pointing at a custom backend.</div>' +
      "</div>" +

      '<h2 class="sub">Payout & Timezone</h2>' +
      '<div class="card grid2">' +
        field("Default payout %", '<input id="cfgPayout" class="big-input" inputmode="decimal" type="text" value="' + esc(cfg.defaultPayout) + '">') +
        field("Timezone", '<input id="cfgTz" class="big-input" type="text" value="' + esc(cfg.fixTimezone) + '">') +
      "</div>" +

      '<h2 class="sub">Staff Passcode</h2>' +
      '<div class="card">' + field("Passcode", '<input id="cfgPass" class="big-input" inputmode="numeric" type="text" value="' + esc(cfg.passcode) + '">') + "</div>" +

      '<button id="cfgSave" class="btn btn-primary btn-xl">Save Settings</button>' +
      '<button id="cfgSync" class="btn btn-ghost btn-xl">Flush Sync Queue Now</button>' +
      '<div class="sync-detail muted small" id="syncDetail"></div>';

    function drawFixState() {
      P.METALS.forEach(function (m) {
        Promise.all([DB.get("fixLocks", lockKey(date, m.key)), latestFix(m.key)]).then(function (r) {
          var l = r[0] || r[1];
          var s = view.querySelector('[data-fixstate="' + m.key + '"]');
          if (!s) return;
          if (l) {
            var isToday = (l.date === date);
            s.innerHTML = '<span class="fix-big">' + P.money(l.fix) + "/ozt</span> " +
              '<span class="muted small">' + (isToday ? "today" : "from " + fmtDate(l.date)) + "</span>";
          } else {
            s.innerHTML = '<span class="warn-chip">none set</span>';
          }
        });
      });
    }
    $$("[data-fxlock]", view).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var m = btn.getAttribute("data-fxlock");
        var inp = view.querySelector('[data-fxval="' + m + '"]');
        var v = parseFloat(inp.value);
        if (!v || v <= 0) { toast("Enter a fix value.", "warn"); return; }
        lockFix(m, date, v).then(function () {
          toast(metalLabel(m) + " fix saved for today.", "ok"); inp.value = ""; drawFixState();
        });
      });
    });
    drawFixState();

    $("#cfgSave", view).addEventListener("click", function () {
      cfg.appsScriptUrl = $("#cfgGas", view).value.trim();
      cfg.ownerEmail = $("#cfgOwner", view).value.trim();
      cfg.defaultPayout = parseFloat($("#cfgPayout", view).value) || 99;
      cfg.fixTimezone = $("#cfgTz", view).value.trim() || "America/New_York";
      cfg.passcode = $("#cfgPass", view).value.trim() || "1947";
      DB.saveConfig(cfg);
      state.config = cfg;
      Sync.emitStatus();
      toast("Settings saved.", "ok");
    });
    $("#cfgSync", view).addEventListener("click", function () {
      Sync.flush().then(function () { return Sync.pendingCount(); }).then(function (n) {
        toast(n === 0 ? "Sync queue empty — all synced." : n + " item(s) still queued.", n === 0 ? "ok" : "warn");
      });
    });
    Sync.pendingCount().then(function (n) {
      $("#syncDetail", view).textContent = (Sync.endpoint() ? "Endpoint configured. " : "No Apps Script URL set. ") + n + " write(s) queued.";
    });
  });

  // ---------------------------------------------------------------------
  // Header: fix chip + sync chip
  // ---------------------------------------------------------------------
  function refreshFixChip() {
    var chip = $("#fixChip");
    if (!chip) return;
    Promise.all(P.METALS.map(function (m) { return getEffectiveFix(m.key); })).then(function (locks) {
      var parts = P.METALS.map(function (m, i) {
        var l = locks[i];
        return l ? m.label.charAt(0) + " <b>" + P.money(l.fix) + "</b>" : "";
      }).filter(Boolean);
      if (parts.length) chip.innerHTML = parts.join('<span class="fix-sep"> · </span>');
      else chip.innerHTML = '<span class="warn-chip">No prices — set in Settings</span>';
    });
  }
  window.addEventListener("roizin-sync", function (e) {
    var chip = $("#syncChip");
    if (!chip) return;
    var d = e.detail;
    if (!d.configured) { chip.className = "chip chip-warn"; chip.textContent = "Sync off"; return; }
    if (!d.online) { chip.className = "chip chip-warn"; chip.textContent = "Offline · " + d.pending + " queued"; return; }
    if (d.pending > 0) { chip.className = "chip chip-sync"; chip.textContent = "Syncing · " + d.pending; return; }
    chip.className = "chip chip-ok"; chip.textContent = "Synced";
  });

  // ---------------------------------------------------------------------
  // Passcode gate
  // ---------------------------------------------------------------------
  function gate() {
    var ok = sessionStorage.getItem("roizin.unlocked") === "1";
    if (ok) { state.locked = false; return Promise.resolve(); }
    state.locked = true;
    return new Promise(function (resolve) {
      var g = $("#gate");
      g.classList.remove("hidden");
      g.innerHTML =
        '<div class="gate-card"><img src="icons/logo.png" class="gate-logo" alt="Roizin Jewelry Co.">' +
        '<div class="gate-title">Staff Passcode</div>' +
        '<input id="passInput" class="big-input huge gate-input" inputmode="numeric" type="password" placeholder="••••">' +
        '<button id="passBtn" class="btn btn-primary btn-xl">Unlock</button>' +
        '<div id="passErr" class="warn hidden">Incorrect passcode.</div></div>';
      function tryUnlock() {
        if ($("#passInput", g).value === DB.getConfig().passcode) {
          sessionStorage.setItem("roizin.unlocked", "1");
          state.locked = false; g.classList.add("hidden"); resolve();
        } else {
          $("#passErr", g).classList.remove("hidden");
          $("#passInput", g).value = "";
        }
      }
      $("#passBtn", g).addEventListener("click", tryUnlock);
      $("#passInput", g).addEventListener("keydown", function (e) { if (e.key === "Enter") tryUnlock(); });
      $("#passInput", g).focus();
    });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function boot() {
    // There is no service worker shipped. Proactively remove any stale one (and
    // its caches) left by an earlier build so the browser never serves an old,
    // blank-rendering bundle. This self-heals "pages went blank after update".
    try {
      if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          regs.forEach(function (r) { r.unregister(); });
        }).catch(function () { });
      }
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) { keys.forEach(function (k) { caches.delete(k); }); }).catch(function () { });
      }
    } catch (e) { }

    DB.open().then(gate).then(function () {
      // Load shared state from the backend before first paint (v5 cross-device).
      return initialLoad().catch(function () { });
    }).then(function () {
      render();
      refreshFixChip();
      Sync.emitStatus();
      Sync.flush();
      startPolling();
    }).catch(function (err) {
      // Never leave a silent blank screen — surface the failure with a retry.
      try { console.error("Boot failed:", err); } catch (e) { }
      var v = $("#view");
      if (v) {
        v.innerHTML = '<div class="card"><h2 class="sub">Couldn’t start</h2>' +
          '<div class="muted">' + (err && err.message ? esc(err.message) : "A startup error occurred.") + "</div>" +
          '<div class="muted small" style="margin-top:8px">If the app is open in another tab or the installed app, close it, then reload.</div>' +
          '<button class="btn btn-primary btn-xl" onclick="location.reload()" style="margin-top:12px">Reload</button></div>';
      }
    });
  }
  boot();
})();
