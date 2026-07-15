/* =====================================================================
   Roizin Jewelry Co. — Local store (IndexedDB) + config + sync queue
   Local-first: the app reads/writes here instantly and offline. sync.js
   mirrors writes up to the Google Sheet via Apps Script.
   ===================================================================== */
(function (global) {
  "use strict";

  var DB_NAME = "roizin-gold";
  var DB_VERSION = 2;
  var STORES = ["clients", "purchases", "lots", "settlements", "refinerySent", "payments", "fixLocks", "queue", "meta"];

  var _db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("clients"))      db.createObjectStore("clients", { keyPath: "id" });
        if (!db.objectStoreNames.contains("purchases"))    db.createObjectStore("purchases", { keyPath: "id" });
        if (!db.objectStoreNames.contains("lots"))         db.createObjectStore("lots", { keyPath: "date" });
        if (!db.objectStoreNames.contains("settlements"))  db.createObjectStore("settlements", { keyPath: "id" });
        if (!db.objectStoreNames.contains("refinerySent")) db.createObjectStore("refinerySent", { keyPath: "id" });
        if (!db.objectStoreNames.contains("payments"))     db.createObjectStore("payments", { keyPath: "id" });
        if (!db.objectStoreNames.contains("fixLocks"))     db.createObjectStore("fixLocks", { keyPath: "key" }); // key = date|metal
        if (!db.objectStoreNames.contains("queue"))        db.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
        if (!db.objectStoreNames.contains("meta"))         db.createObjectStore("meta", { keyPath: "k" });
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function put(store, value) {
    return tx(store, "readwrite").then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.put(value);
        r.onsuccess = function () { res(value); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function get(store, key) {
    return tx(store, "readonly").then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.get(key);
        r.onsuccess = function () { res(r.result || null); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function all(store) {
    return tx(store, "readonly").then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.getAll();
        r.onsuccess = function () { res(r.result || []); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function del(store, key) {
    return tx(store, "readwrite").then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.delete(key);
        r.onsuccess = function () { res(); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function clear(store) {
    return tx(store, "readwrite").then(function (os) {
      return new Promise(function (res, rej) {
        var r = os.clear();
        r.onsuccess = function () { res(); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  // --- ID helper ----------------------------------------------------------
  function uid(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + "_" +
      Math.random().toString(36).slice(2, 8);
  }

  // --- Config (in localStorage; small, frequently read, owner-editable) ---
  var CFG_KEY = "roizin.config.v1";
  var DEFAULT_CONFIG = {
    appsScriptUrl: "/api/sync",               // same-origin sync endpoint (Neon-backed). Cross-device sync works out of the box.
    ownerEmail: "davidroizin@gmail.com",
    defaultPayout: 99,                        // default payout % typed on New Transaction
    fixTimezone: "America/New_York",          // used for NY day boundaries / display
    // Gold price = manual London fix (entered in app). Silver & platinum =
    // manual $/ozt typed per line item. No automatic metal-price feed.
    passcode: "1947",                         // staff passcode (change in Settings)
    business: {
      name: "Roizin Jewelry Co.",
      address: "37 West 47th Street, Booth 57, New York, NY 10036",
      phone: "(917) 647-6282",
      email: "davidroizin@gmail.com"
    }
  };

  function getConfig() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      var saved = JSON.parse(raw);
      // shallow-merge defaults so new keys appear after upgrades
      return Object.assign(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), saved, {
        business: Object.assign({}, DEFAULT_CONFIG.business, saved.business || {})
      });
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }
  function saveConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    return cfg;
  }

  global.DB = {
    open: open, put: put, get: get, all: all, del: del, clear: clear,
    uid: uid, getConfig: getConfig, saveConfig: saveConfig,
    DEFAULT_CONFIG: DEFAULT_CONFIG, STORES: STORES
  };
})(typeof window !== "undefined" ? window : this);
