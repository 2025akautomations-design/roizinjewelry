/* =====================================================================
   Roizin Jewelry Co. — Pricing & Conversion core
   Deterministic, pure functions. No DOM, no I/O. This is the WAT "tool"
   layer: the math the whole app trusts. Keep it boring and exact.
   ===================================================================== */
(function (global) {
  "use strict";

  // --- Unit constants (exact troy/pennyweight definitions) ----------------
  var GRAMS_PER_DWT = 1.55517384;   // 1 pennyweight = 1.55517384 g
  var DWT_PER_OZT = 20;             // 1 troy ounce = 20 dwt
  var GRAMS_PER_OZT = 31.1034768;   // 1 troy ounce = 31.1034768 g

  // --- Accepted karat range (spec v3 §1): 8k .. 24k only ------------------
  var MIN_KARAT = 8, MAX_KARAT = 24;

  // Per spec v3 §5 the purchase price uses the karat number directly via
  //   effFineness = (karat - 0.5) / 24
  // (the -0.5 is the refining deduction baked into the formula). We still
  // carry that as a "fineness" so the rest of the math is identical.
  function goldEffFineness(karat) { return (Number(karat) - 0.5) / 24; }

  var GOLD_KARATS = (function () {
    var list = [];
    for (var k = MAX_KARAT; k >= MIN_KARAT; k--) {
      list.push({ key: k + "k", label: k + "k", karat: k, fineness: goldEffFineness(k) });
    }
    return list;
  })();

  var SILVER_PURITIES = [
    { key: "fine",     label: "Fine .999",    fineness: 0.999 },
    { key: "sterling", label: "Sterling .925", fineness: 0.925 },
    { key: "coin",     label: "Coin .900",     fineness: 0.900 }
  ];

  var PLATINUM_PURITIES = [
    { key: "pt999", label: "Platinum .999", fineness: 0.999 },
    { key: "pt950", label: "Platinum .950", fineness: 0.950 },
    { key: "pt900", label: "Platinum .900", fineness: 0.900 }
  ];

  var METALS = [
    { key: "gold",     label: "Gold",     purities: GOLD_KARATS,      tag: "gold" },
    { key: "silver",   label: "Silver",   purities: SILVER_PURITIES,  tag: "silver" },
    { key: "platinum", label: "Platinum", purities: PLATINUM_PURITIES, tag: "platinum" }
  ];

  // --- Trade rates --------------------------------------------------------
  // Defaults; the live values come from config so the owner can edit them.
  var DEFAULT_RATES = { walkin: 0.99, fedex: 0.95 };

  function metalByKey(key) {
    for (var i = 0; i < METALS.length; i++) if (METALS[i].key === key) return METALS[i];
    return METALS[0];
  }

  function puritiesFor(metalKey) {
    return metalByKey(metalKey).purities;
  }

  function finenessFor(metalKey, purityKey) {
    var list = puritiesFor(metalKey);
    for (var i = 0; i < list.length; i++) if (list[i].key === purityKey) return list[i].fineness;
    return null;
  }

  function purityLabel(metalKey, purityKey) {
    var list = puritiesFor(metalKey);
    for (var i = 0; i < list.length; i++) if (list[i].key === purityKey) return list[i].label;
    return purityKey || "";
  }

  // Numeric karat for a gold purity key (null for non-gold / unknown).
  function karatFor(metalKey, purityKey) {
    if (metalKey !== "gold") return null;
    var list = puritiesFor(metalKey);
    for (var i = 0; i < list.length; i++) if (list[i].key === purityKey) return list[i].karat;
    return null;
  }

  function karatInRange(karat) {
    var k = Number(karat);
    return isFinite(k) && k >= MIN_KARAT && k <= MAX_KARAT;
  }

  // --- Weight conversion: any unit -> dwt ---------------------------------
  // unit one of: "dwt", "g", "ozt"
  function toDwt(value, unit) {
    var v = Number(value);
    if (!isFinite(v) || v <= 0) return 0;
    switch (unit) {
      case "g":   return v / GRAMS_PER_DWT;
      case "ozt": return v * DWT_PER_OZT;
      case "dwt":
      default:    return v;
    }
  }

  function dwtToGrams(dwt) { return Number(dwt) * GRAMS_PER_DWT; }
  function dwtToOzt(dwt)   { return Number(dwt) / DWT_PER_OZT; }

  // --- Fine (pure) content ------------------------------------------------
  // fine_dwt = gross_dwt * fineness
  // fine_ozt = fine_dwt / 20
  function fineDwt(grossDwt, fineness) {
    return Number(grossDwt) * Number(fineness);
  }
  function fineOzt(grossDwt, fineness) {
    return fineDwt(grossDwt, fineness) / DWT_PER_OZT;
  }

  // --- Units per troy ounce (price-per-unit conversion) -------------------
  var UNITS_PER_OZT = { ozt: 1, dwt: DWT_PER_OZT, g: GRAMS_PER_OZT };

  // --- The line-item payout calculation (v5 shared formula) ---------------
  //   pricePerUnit = ((karat-0.5)/24) × rate × marketPrice ÷ unitsPerOzt[unit]
  //   amount       = pricePerUnit × weight
  // rate = typed payout % ÷ 100. marketPrice ($/ozt) = locked London fix
  // (gold) or the manually-entered $/ozt (silver/platinum). purity factor is
  // (karat-0.5)/24 for gold, else the fineness (e.g. .925). Pass args.karat for
  // gold, args.fineness for silver/platinum.
  function calcLineItem(args) {
    var unit = args.unit || "dwt";
    var upo = UNITS_PER_OZT[unit] || DWT_PER_OZT;
    var purityFrac = (args.karat != null) ? goldEffFineness(args.karat) : Number(args.fineness);
    var rate = Number(args.rate);
    var marketPrice = Number(args.marketPrice);          // $/ozt
    var weight = Number(args.weight) || 0;

    var pricePerUnit = purityFrac * rate * marketPrice / upo;
    var amount = pricePerUnit * weight;
    var grossDwt = toDwt(weight, unit);                   // for the dwt accumulator

    return {
      unit: unit, weight: weight, grossDwt: grossDwt,
      karat: (args.karat != null) ? Number(args.karat) : null,
      purityFrac: purityFrac, rate: rate, marketPrice: marketPrice,
      pricePerUnit: pricePerUnit, amount: amount
    };
  }

  // --- Formatting helpers (display only) ----------------------------------
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Whole-dollar money (receipt totals), e.g. "$3,838".
  function money0(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  // Millesimal fineness for display, e.g. 0.925 -> 925.
  function mille(fineness) { return Math.round(Number(fineness) * 1000); }
  function num(n, dp) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    if (dp === undefined) dp = 3;
    return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function pct(n, dp) {
    if (dp === undefined) dp = 1;
    return num(Number(n) * 100, dp) + "%";
  }

  global.Pricing = {
    GRAMS_PER_DWT: GRAMS_PER_DWT,
    DWT_PER_OZT: DWT_PER_OZT,
    GRAMS_PER_OZT: GRAMS_PER_OZT,
    MIN_KARAT: MIN_KARAT,
    MAX_KARAT: MAX_KARAT,
    METALS: METALS,
    DEFAULT_RATES: DEFAULT_RATES,
    goldEffFineness: goldEffFineness,
    karatFor: karatFor,
    karatInRange: karatInRange,
    metalByKey: metalByKey,
    puritiesFor: puritiesFor,
    finenessFor: finenessFor,
    purityLabel: purityLabel,
    toDwt: toDwt,
    dwtToGrams: dwtToGrams,
    dwtToOzt: dwtToOzt,
    fineDwt: fineDwt,
    fineOzt: fineOzt,
    UNITS_PER_OZT: UNITS_PER_OZT,
    calcLineItem: calcLineItem,
    money: money,
    money0: money0,
    mille: mille,
    num: num,
    pct: pct
  };
})(typeof window !== "undefined" ? window : this);
