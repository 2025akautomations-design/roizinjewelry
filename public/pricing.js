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

  // Fineness from a typed millesimal or decimal value. Silver/platinum purity
  // is typed by hand as a millesimal (e.g. 925) — accept either form so 925 and
  // .925 both yield 0.925. Returns 0 for anything non-numeric.
  function finenessFromMille(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return n > 1 ? n / 1000 : n;
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

  // --- Per-metal fixed multipliers used by the payout formulas -------------
  // silver:   payout/ozt = fix × 0.75 × purity
  // platinum: payout/ozt = (fix − 35) × purity × 0.85
  var SILVER_FACTOR = 0.75;
  var PLAT_FACTOR = 0.85;
  var PLAT_DEDUCT = 35;

  // Payout per TROY OUNCE, before converting to the entered unit. Gold uses the
  // karat purity factor and the typed payout % (rate). Silver and platinum use
  // their own fixed formulas and ignore the payout % entirely.
  //   gold:     (karat-0.5)/24 × rate × fix
  //   silver:   fix × 0.75 × fineness
  //   platinum: max(0, fix − 35) × fineness × 0.85
  function payoutPerOzt(metal, marketPrice, karat, fineness, rate) {
    var price = Number(marketPrice) || 0;
    if (metal === "silver") return price * SILVER_FACTOR * (Number(fineness) || 0);
    if (metal === "platinum") return Math.max(0, price - PLAT_DEDUCT) * (Number(fineness) || 0) * PLAT_FACTOR;
    // gold (default)
    var purityFrac = (karat != null) ? goldEffFineness(karat) : Number(fineness) || 0;
    return purityFrac * (Number(rate) || 0) * price;
  }

  // --- The line-item payout calculation ------------------------------------
  //   perOzt       = payoutPerOzt(metal, …)            (metal-specific formula)
  //   pricePerUnit = perOzt ÷ unitsPerOzt[unit]        (dwt / g / ozt aware)
  //   amount       = pricePerUnit × weight
  // marketPrice ($/ozt) = the metal's locked fix. Pass args.karat for gold,
  // args.fineness for silver/platinum (typed millesimal → fraction).
  function calcLineItem(args) {
    var unit = args.unit || "dwt";
    var upo = UNITS_PER_OZT[unit] || DWT_PER_OZT;
    var metal = args.metal || "gold";
    var karat = (args.karat != null) ? Number(args.karat) : null;
    var fineness = Number(args.fineness);
    var rate = Number(args.rate);
    var marketPrice = Number(args.marketPrice);          // $/ozt
    var weight = Number(args.weight) || 0;

    var perOzt = payoutPerOzt(metal, marketPrice, karat, fineness, rate);
    var pricePerUnit = perOzt / upo;
    var amount = pricePerUnit * weight;
    var grossDwt = toDwt(weight, unit);                   // for the dwt accumulator
    var purityFrac = (karat != null) ? goldEffFineness(karat) : fineness;

    return {
      unit: unit, weight: weight, grossDwt: grossDwt,
      karat: karat,
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
    SILVER_FACTOR: SILVER_FACTOR,
    PLAT_FACTOR: PLAT_FACTOR,
    PLAT_DEDUCT: PLAT_DEDUCT,
    goldEffFineness: goldEffFineness,
    payoutPerOzt: payoutPerOzt,
    finenessFromMille: finenessFromMille,
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
