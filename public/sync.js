/* =====================================================================
   Roizin Jewelry Co. — Sync client (app  ->  Google Apps Script  ->  Sheet)
   Local-first: every write is persisted locally first, then enqueued here
   and flushed to the Apps Script web app. Failed pushes stay queued and
   retry when back online. Reads (live fix, manual override) also go here.

   Apps Script CORS note: we POST as text/plain to avoid a CORS preflight
   (Apps Script web apps don't return preflight headers). The Apps Script
   parses the raw body as JSON. See apps_script/Code.gs.
   ===================================================================== */
(function (global) {
  "use strict";

  function cfg() { return global.DB.getConfig(); }

  function endpoint() {
    var u = cfg().appsScriptUrl;
    if (!u) return null;
    if (/^https?:\/\//.test(u)) return u;   // absolute URL (legacy Apps Script)
    if (u.charAt(0) === "/") return u;       // same-origin API route (e.g. /api/sync)
    return null;
  }

  // Low-level POST to Apps Script. Resolves with parsed JSON or throws.
  function post(action, payload) {
    var url = endpoint();
    if (!url) return Promise.reject(new Error("No Apps Script URL configured"));
    return fetch(url, {
      method: "POST",
      // text/plain => "simple request" => no CORS preflight
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: action, payload: payload, ts: Date.now() })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { return { ok: true, raw: t }; }
    });
  }

  // GET helper (live fix / pulls). Uses query string; Apps Script doGet.
  function getJson(params) {
    var url = endpoint();
    if (!url) return Promise.reject(new Error("No Apps Script URL configured"));
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
    return fetch(url + (url.indexOf("?") < 0 ? "?" : "&") + qs)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  // --- Outbound queue -----------------------------------------------------
  // Each queued item: { action, payload }. Flushed in order.
  function enqueue(action, payload) {
    return global.DB.put("queue", { action: action, payload: payload, t: Date.now() })
      .then(function () { flush(); });
  }

  var _flushing = false;
  function flush() {
    if (_flushing) return Promise.resolve();
    if (!endpoint()) return Promise.resolve();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve();
    _flushing = true;
    return global.DB.all("queue").then(function (items) {
      items.sort(function (a, b) { return a.qid - b.qid; });
      return items.reduce(function (chain, item) {
        return chain.then(function () {
          return post(item.action, item.payload).then(function () {
            return global.DB.del("queue", item.qid);
          }).catch(function () { /* leave in queue, retry later */ throw new Error("stop"); });
        });
      }, Promise.resolve());
    }).catch(function () { /* stop chain on first failure */ })
      .then(function () { _flushing = false; emitStatus(); })
      .catch(function () { _flushing = false; });
  }

  function pendingCount() {
    return global.DB.all("queue").then(function (i) { return i.length; });
  }

  // --- Cross-device sync (v5) --------------------------------------------
  // The Apps Script + Sheet is the shared source of truth. Every record write
  // pushes a full-fidelity record up (upsert into the _Sync tab); pull() reads
  // records changed since a watermark so other devices converge.
  function push(store, record) {
    return enqueue("upsert", { store: store, record: record });
  }
  // Returns { ok, records:[{store,id,deleted,record}], now } or null on failure.
  function pull(since) {
    return getJson({ action: "pull", since: since || 0 })
      .then(function (j) { return j && j.ok ? j : null; })
      .catch(function () { return null; });
  }

  // --- Status broadcast (header chip) ------------------------------------
  function emitStatus() {
    if (typeof global.dispatchEvent !== "function") return;
    pendingCount().then(function (n) {
      global.dispatchEvent(new CustomEvent("roizin-sync", {
        detail: { online: navigator.onLine !== false, pending: n, configured: !!endpoint() }
      }));
    });
  }

  if (typeof global.addEventListener === "function") {
    global.addEventListener("online", function () { flush(); emitStatus(); });
    global.addEventListener("offline", emitStatus);
  }

  global.Sync = {
    post: post, getJson: getJson, enqueue: enqueue, flush: flush,
    pendingCount: pendingCount, push: push, pull: pull,
    endpoint: endpoint, emitStatus: emitStatus
  };
})(typeof window !== "undefined" ? window : this);
