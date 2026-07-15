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
  var _watermark = 0;
  function pullAndMerge() {
    if (!Sync.endpoint()) return Promise.resolve(false);
    return Promise.all([Sync.pull(_watermark), pendingKeys()]).then(function (r) {
      var res = r[0], pending = r[1];
      if (!res || !res.records) return false;
      var changed = res.records.length > 0;
      var maxUpdated = res.records.reduce(function (m, it) {
        return Math.max(m, Number(it.record && it.record.updatedAt) || 0);
      }, 0);
      return res.records.reduce(function (ch, item) {
        return ch.then(function () { return mergeRecord(item.store, item.record, pending); });
      }, Promise.resolve()).then(function () {
        // Advance only to the newest server-stamped record we received (strict
        // ">" on the server means no re-pull loop and nothing skipped).
        _watermark = Math.max(_watermark, maxUpdated);
        return DB.put("meta", { k: "syncWatermark", v: _watermark }).then(function () { return changed; });
      });
    }).catch(function () { return false; });
  }
  function initialLoad() {
    return DB.get("meta", "syncWatermark").then(function (m) { _watermark = (m && m.v) || 0; })
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
      t.items.push(p);
      t.total += (p.price || 0);
      t.grossDwt += (p.grossDwt || 0);
      if (p.ts < t.ts) { t.ts = p.ts; t.firstId = p.id; }
    });
    return order.map(function (k) { return byKey[k]; });
  }

  // Open = belongs to the current (unsettled) lot.
  function isOpen(rec) { return !rec.settlementId; }

  // Snapshot of the CURRENT OPEN LOT: every purchase bought since the last
  // refinery sale, with weight always totalled in dwt (any purchase unit is
  // converted to dwt at save time via grossDwt).
  function accumulatorSnapshot() {
    return livePurchases().then(function (all) {
      var open = all.filter(isOpen);
      var expenses = open.reduce(function (s, p) { return s + (p.price || 0); }, 0);
      var dwt = open.reduce(function (s, p) { return s + (p.grossDwt || 0); }, 0);
      var dates = {};
      open.forEach(function (p) { dates[p.date] = true; });
      var dateList = Object.keys(dates).sort();
      return {
        purchases: open,
        expenses: expenses,
        dwt: dwt,                  // accumulated GROSS weight in dwt
        count: open.length,        // number of line items
        dayCount: dateList.length, // how many distinct days we bought on
        dateStart: dateList[0] || null,
        dateEnd: dateList[dateList.length - 1] || null
      };
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
    return { name: parts[0] || "dashboard", arg: parts[1] ? decodeURIComponent(parts[1]) : null };
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
    fn(view, r.arg);
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

  // =====================================================================
  // VIEW: DASHBOARD — Expenses · Sales · Profits · Losses (spec v3 §13)
  // =====================================================================
  route("dashboard", function (view) {
    Promise.all([accumulatorSnapshot(), liveSettlements(), DB.all("payments")]).then(function (r) {
      var acc = r[0], settlements = r[1], payments = r[2].filter(function (p) { return !p.deleted; });
      settlements.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.ts - a.ts); });

      var totalSales = settlements.reduce(function (s, x) { return s + (x.saleAmount || 0); }, 0);
      var settledExpenses = settlements.reduce(function (s, x) { return s + (x.accumulatedExpenses || 0); }, 0);
      var netPL = settlements.reduce(function (s, x) { return s + (x.profitLoss || 0); }, 0);
      var totalReceived = payments.reduce(function (s, x) { return s + (x.amount || 0); }, 0);
      var last = settlements[0] || null;

      view.innerHTML =
        '<h1 class="view-title">Dashboard</h1>' +

        // The headline numbers for the CURRENT OPEN LOT: accumulated expenses
        // AND total weight in dwt — both climb with every purchase until the
        // refinery sale closes the lot.
        '<div class="card accum-card">' +
          '<div class="pl-label">Current lot</div>' +
          '<div class="accum-twin">' +
            '<div><div class="pl-label">Accumulated expenses</div><div class="price-big">' + P.money(acc.expenses) + "</div></div>" +
            '<div><div class="pl-label">Accumulated weight</div><div class="price-big">' + P.num(acc.dwt, 2) + ' <span class="accum-unit">dwt</span></div></div>' +
          "</div>" +
          '<div class="muted">' +
            (acc.count
              ? acc.count + " transaction" + (acc.count === 1 ? "" : "s") + " over " +
                acc.dayCount + " day" + (acc.dayCount === 1 ? "" : "s") +
                (acc.dateStart ? " · " + lotRange(acc.dateStart, acc.dateEnd) : "")
              : "No purchases in the current lot yet.") +
          "</div>" +
          '<div class="muted small accum-note">No profit / loss yet — it is calculated when you sell this lot to the refinery.</div>' +
          '<a class="btn btn-primary btn-xl accum-cta" data-go="melt/sale">Sell Lot to Refinery</a>' +
        "</div>" +

        // Lifetime money tracking.
        '<h2 class="sub">Lifetime</h2>' +
        '<div class="card kpi-grid kpi-3">' +
          kpi(P.money(settledExpenses + acc.expenses), "total expenses") +
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
          return '<div class="list-row"><div><b>' + fmtDate(s.date) + "</b>" +
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
  route("new", function (view) {
    var cfg = DB.getConfig();
    var tx = { customer: "", date: nyDateStr(), payout: cfg.defaultPayout };
    var items = [];
    var goldFix = null, goldFixDate = null;

    function rate() { var v = parseFloat(tx.payout); return (isFinite(v) && v > 0) ? v / 100 : 0; }
    function blankItem() { return { metal: "gold", purity: "14k", unit: "dwt", weight: 0, pricePerOzt: "", perUnit: "", priceMode: "auto", pricePerUnit: 0, amount: 0, grossDwt: 0 }; }
    function marketPriceFor(it) { return it.metal === "gold" ? (goldFix || 0) : (parseFloat(it.pricePerOzt) || 0); }
    // Auto-suggested price for the chosen unit, from the live formula (London
    // fix for gold, typed spot $/oz for silver/platinum). 0 if no market price.
    function autoPerUnit(it) {
      var market = marketPriceFor(it);
      if (!(market > 0)) return 0;
      var karat = P.karatFor(it.metal, it.purity);
      var fineness = (karat == null) ? P.finenessFor(it.metal, it.purity) : null;
      return P.calcLineItem({ metal: it.metal, karat: karat, fineness: fineness, unit: it.unit, weight: 1, rate: rate(), marketPrice: market }).pricePerUnit;
    }
    // Back-imply a spot $/oz from a custom per-unit price so saved records and
    // receipts still carry a metal price for reference. 0 if not derivable.
    function impliedSpot(it) {
      var karat = P.karatFor(it.metal, it.purity);
      var purityFrac = (karat != null) ? P.goldEffFineness(karat) : P.finenessFor(it.metal, it.purity);
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
      return (it.metal === "gold" && goldFix == null) ? "set gold fix in Settings" : "enter price";
    }
    // One editable "$ / unit" field for every metal. It defaults to the auto
    // value but the owner can type any price per dwt/g/ozt. Silver & platinum
    // also get an optional spot $/oz helper that drives the auto suggestion.
    function priceCellHtml(it) {
      recalc(it);
      var spot = (it.metal !== "gold")
        ? '<input class="lit-spot" data-role="spot" inputmode="decimal" type="text" placeholder="spot $/oz" value="' + esc(it.pricePerOzt) + '">'
        : "";
      var puVal = (it.priceMode === "custom") ? (it.perUnit || "") : (it._auto ? it._auto.toFixed(2) : "");
      var resetHidden = (it.priceMode === "custom" && it._auto > 0) ? "" : ' style="display:none"';
      return '<input class="big-input lit-perunit" data-role="perunit" inputmode="decimal" type="text" placeholder="$/' + it.unit + '" value="' + esc(puVal) + '">' +
        '<div class="lit-sub">' + spot +
          '<span class="lit-submeta" data-role="priceSub">' + priceSubText(it) + "</span>" +
          '<button type="button" class="btn-link lit-resetbtn" data-role="resetPrice"' + resetHidden + ">use auto</button>" +
        "</div>";
    }
    function rowHtml(it, idx) {
      return '<div class="lit-row" data-idx="' + idx + '">' +
        '<label class="lit-cell"><span class="lit-lbl">METAL</span><select class="big-input" data-role="metal">' + metalOptions(it) + "</select></label>" +
        '<label class="lit-cell"><span class="lit-lbl">KARAT</span><select class="big-input" data-role="purity">' + purOptions(it) + "</select></label>" +
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

    function drawGoldBanner() {
      var el = $("#goldBanner", view);
      if (goldFix == null) {
        el.innerHTML = '<div class="warn">No gold London fix entered — gold rows can\'t price. Set it in ' +
          '<a data-go="settings" class="lnk">Settings → Gold London Fix</a>.</div>';
      } else {
        var stale = (goldFixDate !== fixEffectiveDate());
        el.innerHTML = '<div class="muted small nt-fix">Gold London fix: <b>' + P.money(goldFix) + " /oz</b> · " + fmtDate(goldFixDate) +
          (stale ? ' <span class="warn-chip">(update in Settings)</span>' : "") + "</div>";
      }
    }

    // --- events (delegated on the rows container) ---
    $("#litRows", view).addEventListener("input", function (e) {
      var el = e.target.closest(".lit-row"); if (!el) return;
      var idx = +el.getAttribute("data-idx"), role = e.target.getAttribute("data-role");
      if (role === "weight") { items[idx].weight = parseFloat(e.target.value) || 0; updateRowDisplay(idx); }
      else if (role === "perunit") {
        // Typing a price overrides the formula; clearing it restores auto.
        if (e.target.value.trim() === "") { items[idx].priceMode = "auto"; items[idx].perUnit = ""; }
        else { items[idx].priceMode = "custom"; items[idx].perUnit = e.target.value; }
        updateRowDisplay(idx, { from: "perunit" });
      }
      else if (role === "spot") { items[idx].pricePerOzt = e.target.value; updateRowDisplay(idx, { from: "spot" }); }
    });
    $("#litRows", view).addEventListener("change", function (e) {
      var el = e.target.closest(".lit-row"); if (!el) return;
      var idx = +el.getAttribute("data-idx"), role = e.target.getAttribute("data-role");
      if (role === "metal") {
        items[idx].metal = e.target.value;
        items[idx].purity = P.puritiesFor(items[idx].metal)[0].key;
        if (items[idx].metal === "gold") items[idx].purity = "14k";
        items[idx].pricePerOzt = ""; items[idx].perUnit = ""; items[idx].priceMode = "auto";
        renderRows();                          // metal change swaps karat options + price cell type
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
        return nextOrderNo(date).then(function (order) {
          var ts = nowTs(), txnId = DB.uid("txn");
          var recs = valid.map(function (it) {
            var karat = P.karatFor(it.metal, it.purity);
            var fineness = (karat != null) ? P.goldEffFineness(karat) : P.finenessFor(it.metal, it.purity);
            return {
              id: DB.uid("pur"), order: order, txnId: txnId, date: date, ts: ts,
              clientId: client ? client.id : null, clientName: client ? client.name : (tx.customer || ""),
              clientPhone: client ? client.phone : "", clientEmail: client ? client.email : "",
              metal: it.metal, purity: it.purity, purityLabel: P.purityLabel(it.metal, it.purity),
              karat: karat, fineness: fineness, mille: (karat != null ? null : P.mille(fineness)),
              payoutPercent: parseFloat(tx.payout) || 0, rate: rate(),
              metalPrice: (it.metal === "gold" ? (goldFix || 0) : (marketPriceFor(it) || impliedSpot(it))),
              priceSource: (it.priceMode === "custom" ? "custom" : (it.metal === "gold" ? "London fix" : "manual")),
              unit: it.unit, weight: it.weight, grossDwt: it.grossDwt,
              pricePerUnit: it.pricePerUnit, pricePerDwt: (it.grossDwt ? it.amount / it.grossDwt : 0),
              price: it.amount,                 // amount — feeds the expense + weight accumulators
              notes: "", settlementId: null, deleted: false
            };
          });
          return Promise.all(recs.map(function (r) { return saveRecord("purchases", r); })).then(function () {
            var tot = recs.reduce(function (s, r) { return s + r.price; }, 0);
            toast("Saved " + order + " · " + recs.length + " item" + (recs.length === 1 ? "" : "s") + " · " + P.money(tot), "ok");
            if (printAfter) {
              var holder = $("#print-area");
              holder.innerHTML = '<div class="receipt-simple">' + receiptHtml(recs, cfg.business) + "</div>";
              window.print();
            }
            go("/purchase/" + recs[0].id);
          });
        });
      });
    }

    // --- boot the form ---
    items.push(blankItem());
    renderRows();
    drawGoldBanner();
    getEffectiveFix("gold").then(function (lock) {
      if (lock && lock.fix) { goldFix = lock.fix; goldFixDate = lock.date; }
      drawGoldBanner();
      renderRows();   // gold rows now price
    });
    refreshFixChip();
  });

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
          '<button id="printBtn" class="btn btn-primary btn-xl">🖨  Print Receipt</button>' +
          '<div class="card receipt-simple" id="receipt">' + receiptHtml(items, b) + "</div>";
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
    var p0 = items[0];
    var metals = items.map(function (i) { return i.metal; }).filter(function (m, idx, a) { return a.indexOf(m) === idx; });
    var titleMetal = (metals.length === 1) ? P.metalByKey(metals[0]).label.toUpperCase() + " " : "";
    var allNonGold = items.every(function (i) { return i.metal !== "gold"; });
    var ktHead = allNonGold ? "FINE" : "KT";
    var total = items.reduce(function (s, i) { return s + i.price; }, 0);

    // One price line per distinct metal that has a price.
    var priceLines = metals.map(function (m) {
      var it = items.filter(function (i) { return i.metal === m && i.metalPrice != null; })[0];
      return it ? "<div>" + P.metalByKey(m).label + " Price: " + P.money(it.metalPrice) + " / oz</div>" : "";
    }).join("");

    var rows = items.map(function (p) {
      var isGold = (p.metal === "gold");
      var ktVal = isGold ? ((p.karat != null ? p.karat : "") + "K")
                         : (p.mille != null ? p.mille : P.mille(p.fineness || 0));
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
        // summarises the day: total spent and total pennyweights (dwt) bought.
        // Every purchase unit (oz / dwt / g) is already normalised to dwt.
        var days = [], byDay = {};
        txns.forEach(function (t) {
          if (!byDay[t.date]) { byDay[t.date] = { date: t.date, txns: [], spent: 0, dwt: 0 }; days.push(byDay[t.date]); }
          var d = byDay[t.date];
          d.txns.push(t); d.spent += (t.total || 0); d.dwt += (t.grossDwt || 0);
        });
        // Guarantee chronological order (newest day first), and order the
        // transactions within each day by entry time — independent of the
        // order groupTxns happens to return.
        days.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
        days.forEach(function (d) { d.txns.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }); });
        $("#phList", view).innerHTML = txns.length ? days.map(function (d) {
          var head =
            '<div class="day-divider">' +
              '<span class="day-date">' + fmtDate(d.date) + "</span>" +
              '<span class="day-stats">' + P.money(d.spent) + " · " + P.num(d.dwt, 2) + " dwt</span>" +
            "</div>";
          var rows = d.txns.map(function (t) {
            var summary = t.items.length === 1
              ? P.metalByKey(t.items[0].metal).label + " " + (t.items[0].karat != null ? t.items[0].karat + "k" : esc(t.items[0].purityLabel))
              : t.items.length + " items";
            return '<div class="list-row del-row">' +
              '<a class="del-main" data-go="purchase/' + t.firstId + '">' +
              '<div><b>' + esc(t.clientName) + "</b><span class='muted'> · " + esc(t.order) + "</span>" +
              "<br><span class='muted small'>" + summary +
              " · " + P.num(t.grossDwt, 2) + " dwt" + (t.settled ? " · settled" : "") + "</span></div>" +
              '<div class="amt">' + P.money(t.total) + "</div></a>" +
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
        '<div class="card"><div class="muted">' + esc(c.phone || "") + (c.email ? " · " + esc(c.email) : (c.phone ? "" : "no contact info")) +
        "</div><div class='muted small'>Client since " + fmtDateTime(c.created) + "</div>" +
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
    });
  }

  // =====================================================================
  // VIEW: MELT & REFINERY — combined section
  //   Tabs: Sell Lot | Payments
  //   Selling the lot is a single flow: review the whole open lot, melt it
  //   (dwt before/after -> melt loss), enter the refinery sale amount, then
  //   close the lot -> settlement -> P/L, and a fresh empty lot begins.
  // =====================================================================
  route("melt", function (view, arg) {
    view.innerHTML =
      '<h1 class="view-title">Melt &amp; Refinery</h1>' +
      '<div class="tabs" id="mrTabs">' +
        '<button class="tab" data-t="melt">Sell Lot</button>' +
        '<button class="tab" data-t="payments">Payments</button>' +
      '</div><div id="mrBody"></div>';
    var start = (arg === "sale") ? "melt" : (arg || "melt");
    $("#mrTabs", view).addEventListener("click", function (e) {
      var b = e.target.closest(".tab"); if (!b) return;
      $$(".tab", view).forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      drawTab(b.getAttribute("data-t"));
    });
    function setActive(t) { $$(".tab", view).forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-t") === t); }); }
    function drawTab(t) {
      setActive(t);
      var body = $("#mrBody", view);
      if (t === "payments") return drawPayments(body);
      return drawMeltAndSale(body, arg === "sale");
    }
    drawTab(start);
  });

  function drawMeltAndSale(body, focusSale) {
    livePurchases().then(function (all) {
      var openAll = all.filter(isOpen);
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
        // ----- The lot being sold (scoped to the sale date) -----------------
        '<div id="lotSummaryWrap"></div>' +

        // ----- Melt the lot (dwt before/after) ------------------------------
        '<h2 class="sub" id="saleHead">Melt &amp; sell this lot</h2>' +
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
          '<button id="registerSaleBtn" class="btn btn-danger btn-xl">Sell Lot &amp; Close</button>' +
          '<div class="muted small">Closing computes profit / loss (sale − accumulated expenses) for this lot, then starts a fresh open lot with any later purchases.</div>' +
        "</div>";

      // Render / re-render the scoped lot summary.
      function renderSummary() {
        var later = openAll.length - scope.count;
        $("#lotSummaryWrap", body).innerHTML =
          '<h2 class="sub">Lot to sell' + (scope.dateStart ? " · " + lotRange(scope.dateStart, scope.dateEnd) : "") + "</h2>" +
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
        registerRefinerySale(sale, $("#saleRef", body).value.trim(), scope, melt).then(function (st) {
          toast("Lot closed · " + (st.profitLoss >= 0 ? "profit " : "loss ") + P.money(Math.abs(st.profitLoss)), "ok");
          go("/lots");
        });
      });

      if (focusSale) { var h = $("#saleHead", body); if (h) h.scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
  }

  // Close the open lot: P/L = sale − accumulated expenses; record the whole-lot
  // melt (dwt before/after); then start a fresh lot by stamping every open
  // purchase with this settlement id. A settlement record IS the closed lot.
  function registerRefinerySale(saleAmount, reference, acc, melt) {
    melt = melt || {};
    var st = {
      id: DB.uid("set"), ts: nowTs(), date: (melt.saleDate || nyDateStr()), saleAmount: Number(saleAmount),
      accumulatedExpenses: acc.expenses, accumulatedDwt: acc.dwt, profitLoss: Number(saleAmount) - acc.expenses,
      txnCount: acc.count, dayCount: acc.dayCount,
      dateStart: acc.dateStart, dateEnd: acc.dateEnd,
      dwtBefore: (melt.dwtBefore != null ? melt.dwtBefore : acc.dwt),
      dwtAfter: (melt.dwtAfter != null ? melt.dwtAfter : null),
      meltLossDwt: (melt.meltLossDwt != null ? melt.meltLossDwt : null),
      meltLossPct: (melt.meltLossPct != null ? melt.meltLossPct : null),
      purchaseIds: acc.purchases.map(function (p) { return p.id; }),
      reference: reference || "", deleted: false
    };
    return saveRecord("settlements", st).then(function () {
      return Promise.all(acc.purchases.map(function (p) {
        p.settlementId = st.id; return saveRecord("purchases", p);
      }));
    }).then(function () { return st; });
  }

  // Delete a closed lot / refinery sale: un-stamp its purchases so they return
  // to the open lot (the sale is undone), then mark the settlement deleted.
  function deleteSettlement(st) {
    return livePurchases().then(function (all) {
      var members = all.filter(function (p) { return p.settlementId === st.id; });
      return Promise.all(members.map(function (p) {
        p.settlementId = null; return saveRecord("purchases", p);
      }));
    }).then(function () { return deleteRecord("settlements", st); });
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
          '<button class="del-btn" data-id="' + esc(p.id) + '" aria-label="Delete payment">🗑</button></div>';
      }).join("") : '<div class="muted card">No payments recorded.</div>';

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

  function addPaymentFlow(cb) {
    modal(
      '<h2>Record Refinery Payment</h2>' +
      field("Payment date", '<input id="payDate" class="big-input" type="date" value="' + nyDateStr() + '">') +
      field("Amount received ($)", '<input id="payAmt" class="big-input huge" inputmode="decimal" type="text" placeholder="0.00">') +
      field("Reference / notes", '<input id="payRef" class="big-input" type="text" placeholder="Check #, wire ref…">') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="payCancel">Cancel</button>' +
      '<button class="btn btn-primary" id="paySave">Save Payment</button></div>',
      function (wrap, close) {
        $("#payCancel", wrap).addEventListener("click", close);
        $("#paySave", wrap).addEventListener("click", function () {
          var amt = parseFloat($("#payAmt", wrap).value);
          if (!amt || amt <= 0) { toast("Enter an amount.", "warn"); return; }
          var pay = {
            id: DB.uid("pay"), date: $("#payDate", wrap).value || nyDateStr(), amount: amt,
            reference: $("#payRef", wrap).value.trim(), ts: nowTs(), deleted: false
          };
          saveRecord("payments", pay).then(function () {
            close(); toast("Payment recorded.", "ok"); if (cb) cb();
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

      // The open lot card — always shown; it's what's currently accumulating.
      var openCard =
        '<div class="card lot-open">' +
          '<div class="row-between"><b>Open lot</b><span class="ok-text">buying</span></div>' +
          '<div class="muted small">' +
            (acc.count
              ? acc.count + " txns · " + acc.dayCount + " day" + (acc.dayCount === 1 ? "" : "s") +
                (acc.dateStart ? " · " + lotRange(acc.dateStart, acc.dateEnd) : "")
              : "No purchases yet.") +
          "</div>" +
          '<div class="kpi-grid kpi-2">' +
            kpi(P.num(acc.dwt, 2) + " dwt", "gross bought") +
            kpi(P.money(acc.expenses), "accumulated expenses") +
          "</div>" +
          (acc.count ? '<a class="btn btn-primary btn-xl" data-go="melt/sale">Melt &amp; Sell This Lot</a>' : "") +
        "</div>";

      view.innerHTML =
        '<div class="row-between"><h1 class="view-title">Lots</h1>' +
        '<a class="btn btn-primary" data-go="melt/sale">Sell Lot</a></div>' +
        '<div class="muted small lots-note">A lot is every purchase between refinery sales. Buying adds to the open lot; selling to the refinery closes it.</div>' +
        openCard +
        '<h2 class="sub">Closed lots</h2>' +
        '<div class="list">' + (settlements.length ? settlements.map(function (s) {
          var span = (s.dateStart) ? lotRange(s.dateStart, s.dateEnd) : fmtDate(s.date);
          return '<div class="list-row del-row"><div class="del-main del-static"><div><b>' + span + "</b>" +
            "<br><span class='muted small'>" + (s.txnCount || 0) + " txns · " + P.num(s.accumulatedDwt || 0, 2) + " dwt · expenses " + P.money(s.accumulatedExpenses) +
            (s.meltLossDwt != null ? " · melt loss " + P.num(s.meltLossDwt, 2) + " dwt" : "") +
            " · sold " + fmtDate(s.date) + "</span></div>" +
            '<span class="' + (s.profitLoss >= 0 ? "pos" : "neg") + '">' +
            (s.profitLoss >= 0 ? "+" : "−") + P.money(Math.abs(s.profitLoss)) + "</span></div>" +
            '<button class="del-btn" data-id="' + esc(s.id) + '" aria-label="Delete lot">🗑</button></div>';
        }).join("") : '<div class="muted card">No lots sold yet.</div>') + "</div>";

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
  // VIEW: SETTINGS — config + daily fix (spec v3 §2 + Config block)
  // =====================================================================
  route("settings", function (view) {
    var cfg = DB.getConfig();
    var date = fixEffectiveDate();
    view.innerHTML =
      '<h1 class="view-title">Settings</h1>' +

      '<h2 class="sub">Gold London Fix (manual)</h2>' +
      '<div class="card" id="fixCard"><div class="muted small">Gold uses the London fix you enter here. ' +
        'Silver &amp; platinum are priced by typing their $/ozt on each transaction. The most recent gold fix is used until you update it. Today (NY): <b>' + fmtDate(date) + "</b></div>" +
        '<div id="fixState" class="fix-state"></div>' +
        field("Gold London fix $/ozt", '<input id="fxVal" class="big-input" inputmode="decimal" type="text" placeholder="e.g. 2350.00">') +
        '<div class="row-gap"><button id="fxLock" class="btn btn-primary">Save Gold Fix for Today</button></div></div>' +

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
      Promise.all([DB.get("fixLocks", lockKey(date, "gold")), latestFix("gold")]).then(function (r) {
        var l = r[0] || r[1];
        var s = $("#fixState", view);
        if (l) {
          var isToday = (l.date === date);
          s.innerHTML = '<div class="fix-big">' + P.money(l.fix) + " /ozt</div>" +
            '<div class="muted">Gold · entered ' + (l.lockedAt ? fmtDateTime(l.lockedAt) : fmtDate(l.date)) +
            (isToday ? " · current for today" : " <span class='warn-chip'>· from " + fmtDate(l.date) + ", enter today's below</span>") + "</div>";
        } else {
          s.innerHTML = '<div class="warn">No gold fix entered yet. Enter the official fix below.</div>';
        }
      });
    }
    $("#fxLock", view).addEventListener("click", function () {
      var v = parseFloat($("#fxVal", view).value);
      if (!v || v <= 0) { toast("Enter a fix value.", "warn"); return; }
      lockFix("gold", date, v).then(function () {
        toast("Gold fix saved for today.", "ok"); $("#fxVal", view).value = ""; drawFixState();
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
    var date = fixEffectiveDate();
    Promise.all([DB.get("fixLocks", lockKey(date, "gold")), latestFix("gold")]).then(function (r) {
      var l = r[0] || r[1];
      if (l) chip.innerHTML = "Gold fix <b>" + P.money(l.fix) + "</b><span>" + fmtDate(l.date) +
        (l.date === date ? "" : " · update") + "</span>";
      else chip.innerHTML = '<span class="warn-chip">No gold fix — set in Settings</span>';
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
    DB.open().then(gate).then(function () {
      // Load shared state from the backend before first paint (v5 cross-device).
      return initialLoad().catch(function () { });
    }).then(function () {
      render();
      refreshFixChip();
      Sync.emitStatus();
      Sync.flush();
      startPolling();
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js").catch(function () { });
      }
    });
  }
  boot();
})();
