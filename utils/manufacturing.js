// ─── Manufacturing helpers ─────────────────────────────────────────────────
// Shared by routes/manufacturing.js and routes/rawMaterials.js. The costing
// functions are mirrored in client/src/pages/manufacturing/mfgKit.js for the
// live figures in the batch and purchase forms; the server stays
// authoritative (the batch preview step shows the server's figures).
const { todayPKT } = require('./dateUtils');

const MAX_MONEY = 9999999999.99;          // DECIMAL(12,2)
const BASE_SYMBOL = { weight: 'g', volume: 'ml', count: 'pcs' };

const num = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** Trimmed, inner whitespace collapsed to one space. */
const cleanText = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** Identity key for "the same name": case and extra spaces ignored. */
const normKey = (value) => String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

/** SQL twin of normKey for a column. */
const normSql = (column) => `LOWER(TRIM(REGEXP_REPLACE(${column}, '[[:space:]]+', ' ')))`;

/** Pack size label stored in products.pack_size: number + unit ("200 ml").
 *  The pack type is never part of it (owner 2026-10-15): it is shown on
 *  every document beside the product name. */
const packLabel = (volume, symbol) => {
  const n = String(Number(Math.round((Number(volume) + Number.EPSILON) * 10000) / 10000));
  return `${n} ${symbol}`;
};

const isDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** MySQL DATE (mysql2 hands back a Date at PKT midnight, or a string) -> 'YYYY-MM-DD'. */
function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return todayPKT(value);
}

/** True when n has no more than `places` decimals (quantities are DECIMAL(14,4)). */
const decimalsOk = (n, places) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;

const fmtNumber = (value, max = 4) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: max });
const fmtPKR = (value) => `PKR ${round2(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (value, symbol) => `${fmtNumber(value)}${symbol ? ` ${symbol}` : ''}`;

const plural = (n, one, many) => `${fmtNumber(n, 0)} ${Number(n) === 1 ? one : many}`;
/** "a", "a and b", "a, b and c" */
function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** An Error the route handlers turn into a JSON response: { message, field?, step?, line? }. */
function fail(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function sendError(res, err, fallback) {
  if (err && err.status) {
    const body = { message: err.message };
    for (const key of ['field', 'step', 'line', 'code']) if (err[key] !== undefined) body[key] = err[key];
    return res.status(err.status).json(body);
  }
  console.error(err);
  return res.status(500).json({ message: fallback });
}

/**
 * Split `total` across `weights` in proportion, to the paisa, so the parts
 * always add up to round2(total) exactly (largest-remainder method).
 */
function allocate(total, weights) {
  const totalPaisa = Math.round(round2(total) * 100);
  const weightSum = weights.reduce((s, w) => s + Math.max(0, Number(w) || 0), 0);
  if (weights.length === 0) return [];
  if (weightSum <= 0) return weights.map((_, i) => (i === 0 ? totalPaisa / 100 : 0));
  const exact = weights.map(w => (totalPaisa * Math.max(0, Number(w) || 0)) / weightSum);
  const floors = exact.map(Math.floor);
  let remainder = totalPaisa - floors.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) floors[order[k].i] += 1;
  return floors.map(p => p / 100);
}

/**
 * Landed rate of each purchase line (brief 7.3): the purchase's other charges
 * are shared in proportion to each line's value.
 *   line landed rate = (line total + charges × line total ÷ Σ line totals) ÷ qty
 * lines: [{ qty, rate }] -> [{ lineTotal, chargesShare, landedRate }]
 */
function landedRates(lines, otherCharges) {
  const totals = lines.map(l => round2(l.qty * l.rate));
  const shares = allocate(otherCharges || 0, totals);
  return lines.map((l, i) => ({
    lineTotal: totals[i],
    chargesShare: shares[i],
    landedRate: l.qty > 0 ? round4((totals[i] + shares[i]) / l.qty) : 0,
  }));
}

/**
 * Batch costing (brief section 8):
 *   shared cost   = raw materials + misc expense − Σ (by-product qty × purchase rate)
 *   pack row cost = share of the shared cost by packed volume + its own packaging
 *   cost per unit = pack row cost ÷ units;  by-product cost per unit = its purchase rate
 * Sale tax is never part of cost (owner decision 2026-10-12).
 *
 * materials:  [{ qty, rate }]
 * packs:      [{ units, packedBase, packaging: [{ qty, rate }] }]
 * byProducts: [{ qty, rate }]
 */
function computeBatchCosting({ materials, miscExpense, packs, byProducts }) {
  const materialLines = materials.map(m => ({ total: round2(m.qty * m.rate) }));
  const rawCost = round2(materialLines.reduce((s, m) => s + m.total, 0));
  const misc = round2(miscExpense || 0);
  const byLines = byProducts.map(b => ({ total: round2(b.qty * b.rate), costPerUnit: round4(b.rate) }));
  const byProductValue = round2(byLines.reduce((s, b) => s + b.total, 0));
  const sharedCost = round2(rawCost + misc - byProductValue);

  const shares = allocate(Math.max(sharedCost, 0), packs.map(p => p.packedBase));
  const packLines = packs.map((p, i) => {
    const packaging = p.packaging.map(x => ({ total: round2(x.qty * x.rate) }));
    const packagingCost = round2(packaging.reduce((s, x) => s + x.total, 0));
    const totalCost = round2(shares[i] + packagingCost);
    return {
      packaging,
      packagingCost,
      sharedCost: shares[i],
      totalCost,
      costPerUnit: p.units > 0 ? round4(totalCost / p.units) : 0,
    };
  });
  const packagingCost = round2(packLines.reduce((s, p) => s + p.packagingCost, 0));
  return {
    rawCost,
    packagingCost,
    miscExpense: misc,
    byProductValue,
    sharedCost,
    totalCost: round2(rawCost + packagingCost + misc),
    materials: materialLines,
    packs: packLines,
    byProducts: byLines,
  };
}

/**
 * Weighted average rate of a material after one purchase line:
 *   stock before = max(stock before the line, 0)
 *   new rate     = (stock before × current rate + qty × landed rate) ÷ (stock before + qty)
 * With no stock before, the new rate is the landed rate. Using stock in a
 * batch never changes the rate.
 */
function weightedAverageRate(stockBefore, currentRate, qty, landedRate) {
  const before = Math.max(Number(stockBefore) || 0, 0);
  if (!(before > 0)) return round4(landedRate);
  return round4((before * (Number(currentRate) || 0) + qty * landedRate) / (before + qty));
}

/**
 * A material's average rate rebuilt from its stock ledger, in date order
 * (date, then the time the row was written): purchases ('rm_purchase', at
 * their landed rate) move the average, batch deductions only reduce stock.
 * Returns null when no purchase is left (the caller keeps the current rate).
 * Mirrored by server/migrations/mfg_weighted_average.sql.
 */
async function replayAverageRate(conn, rawMaterialId) {
  const [rows] = await conn.query(
    `SELECT qty_in, qty_out, unit_cost FROM rm_ledger
      WHERE raw_material_id = ? ORDER BY date, created_at, id`, [rawMaterialId]
  );
  let stock = 0;
  let rate = null;
  for (const r of rows) {
    const qtyIn = parseFloat(r.qty_in) || 0;
    const qtyOut = parseFloat(r.qty_out) || 0;
    if (qtyIn > 0) rate = weightedAverageRate(rate === null ? 0 : stock, rate, qtyIn, parseFloat(r.unit_cost) || 0);
    stock += qtyIn - qtyOut;
  }
  return rate;
}

module.exports = {
  MAX_MONEY,
  BASE_SYMBOL,
  num,
  round2,
  round4,
  cleanText,
  normKey,
  normSql,
  packLabel,
  isDate,
  dateOnly,
  decimalsOk,
  fmtNumber,
  fmtPKR,
  fmtQty,
  plural,
  joinAnd,
  fail,
  sendError,
  allocate,
  landedRates,
  computeBatchCosting,
  weightedAverageRate,
  replayAverageRate,
};
