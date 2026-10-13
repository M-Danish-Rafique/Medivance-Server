const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, nowPKT } = require('../utils/dateUtils');
const {
  MAX_MONEY, BASE_SYMBOL, num, round2, round4, cleanText, isDate, dateOnly, decimalsOk,
  fmtNumber, fmtPKR, fmtQty, plural, joinAnd, fail, sendError, landedRates,
  weightedAverageRate, replayAverageRate,
} = require('../utils/manufacturing');

// ─── Raw materials, units of measure, raw material purchases ──────────────
// raw_materials.cost_per_unit is the material's weighted average rate (API
// name `purchase_rate`). Each purchase line moves it:
//   new rate = (max(stock before, 0) × rate + qty × landed rate) ÷ (stock before + qty)
// and using stock in a batch never changes it. A batch freezes the rate of
// each material when it takes the stock (manufacturing.js). Deleting a
// purchase, or a batch that took stock, rebuilds the average from the stock
// ledger in date order (replayAverageRate). The rate is typed by hand only
// until the material's first purchase.

const MFG_FLAGS = ['perm_mfg_products', 'perm_mfg_raw_materials', 'perm_mfg_batches', 'perm_mfg_yields'];
const canRead = requirePermission.any(MFG_FLAGS, 'Manufacturing');
const canEdit = requirePermission('perm_mfg_raw_materials', 'Raw Materials');

// ── Units of measure ───────────────────────────────────────────────────────
// Symbol only, in exactly three categories: weight (base g), volume (base ml),
// count (base pcs). to_base_factor = base units in one of this unit (kg = 1000);
// a count unit is a whole number of pcs, at least 2 (dozen = 12). `name` is
// kept for older code and always mirrors the symbol.
const UOM_TYPES = { weight: 'Weight', volume: 'Volume', count: 'Count' };
const isBaseUnit = (u) => BASE_SYMBOL[u.base_type] === u.symbol;

async function uomUsage(conn, id) {
  const [[r]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM products WHERE volume_uom_id = ?) AS products,
            (SELECT COUNT(*) FROM raw_materials WHERE uom_id = ? OR volume_uom_id = ?) AS materials,
            (SELECT COUNT(DISTINCT batch_id) FROM (
               SELECT id AS batch_id FROM mfg_batches WHERE volume_uom_id = ?
               UNION ALL SELECT batch_id FROM mfg_batch_packs WHERE pack_volume_uom_id = ?
             ) t) AS batches`,
    [id, id, id, id, id]
  );
  const parts = [];
  if (Number(r.products)) parts.push(plural(r.products, 'product', 'products'));
  if (Number(r.materials)) parts.push(plural(r.materials, 'raw material', 'raw materials'));
  if (Number(r.batches)) parts.push(plural(r.batches, 'batch', 'batches'));
  return parts.length ? `Used by ${joinAnd(parts)}.` : null;
}

router.get('/uom', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, symbol, base_type, to_base_factor FROM units_of_measurement
        ORDER BY FIELD(base_type, 'weight', 'volume', 'count'), to_base_factor, symbol`
    );
    const out = [];
    for (const u of rows) {
      const usage = await uomUsage(db, u.id);
      out.push({ ...u, is_base: isBaseUnit(u), in_use: !!usage, usage });
    }
    res.json(out);
  } catch (err) { sendError(res, err, 'The units could not be loaded.'); }
});

function parseUomInput(body, baseType) {
  const symbol = String(body.symbol ?? '').trim();
  if (!symbol) throw fail(400, 'Enter a symbol.', { field: 'symbol' });
  if (/\s/.test(symbol)) throw fail(400, 'The symbol cannot contain spaces.', { field: 'symbol' });
  if (symbol.length > 10) throw fail(400, 'The symbol must have 10 characters or fewer.', { field: 'symbol' });
  const factor = num(body.to_base_factor);
  if (!(factor > 0) || factor > 1e9 || !decimalsOk(factor, 8)) {
    throw fail(400, `Enter how many ${BASE_SYMBOL[baseType]} make one ${symbol}.`, { field: 'to_base_factor' });
  }
  if (baseType === 'count' && !Number.isInteger(factor)) throw fail(400, 'Enter a whole number of pcs.', { field: 'to_base_factor' });
  if (baseType === 'count' && factor < 2) throw fail(400, `One ${symbol} must be at least 2 pcs.`, { field: 'to_base_factor' });
  return { symbol, to_base_factor: factor };
}

async function assertSymbolFree(conn, symbol, excludeId) {
  const [dups] = await conn.query(
    'SELECT symbol FROM units_of_measurement WHERE LOWER(symbol) = LOWER(?) AND id <> ? LIMIT 1', [symbol, excludeId || 0]
  );
  if (dups.length) throw fail(409, `${dups[0].symbol} already exists.`, { field: 'symbol' });
}

router.post('/uom', auth, canEdit, async (req, res) => {
  try {
    const baseType = req.body.base_type;
    if (!UOM_TYPES[baseType]) throw fail(400, 'Choose Weight, Volume or Count.', { field: 'base_type' });
    const uom = parseUomInput(req.body, baseType);
    await assertSymbolFree(db, uom.symbol);
    const [result] = await db.query(
      'INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor) VALUES (?,?,?,?)',
      [uom.symbol, uom.symbol, baseType, uom.to_base_factor]
    );
    await logAudit(req, 'CREATE', 'raw-materials/uom', result.insertId,
      `Added unit ${uom.symbol} (1 ${uom.symbol} = ${fmtNumber(uom.to_base_factor, 8)} ${BASE_SYMBOL[baseType]})`);
    res.status(201).json({ id: result.insertId, base_type: baseType, ...uom, is_base: false, in_use: false, usage: null });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'symbol', message: 'This symbol already exists.' });
    sendError(res, err, 'The unit could not be added. Try again.');
  }
});

// The category never changes; the factor only while nothing uses the unit,
// because stored batch volumes and costs were worked out with it.
router.put('/uom/:id', auth, canEdit, async (req, res) => {
  try {
    const [[current]] = await db.query('SELECT id, symbol, base_type, to_base_factor FROM units_of_measurement WHERE id=?', [req.params.id]);
    if (!current) throw fail(404, 'The unit no longer exists.');
    if (isBaseUnit(current)) throw fail(409, `${current.symbol} is the base unit for ${UOM_TYPES[current.base_type].toLowerCase()} and cannot be changed.`);
    const uom = parseUomInput(req.body, current.base_type);
    await assertSymbolFree(db, uom.symbol, current.id);
    if (Math.abs(uom.to_base_factor - parseFloat(current.to_base_factor)) > 1e-9) {
      const usage = await uomUsage(db, current.id);
      if (usage) throw fail(409, `${usage} The conversion cannot change while the unit is in use.`, { field: 'to_base_factor' });
    }
    await db.query('UPDATE units_of_measurement SET name=?, symbol=?, to_base_factor=? WHERE id=?',
      [uom.symbol, uom.symbol, uom.to_base_factor, current.id]);
    await logAudit(req, 'UPDATE', 'raw-materials/uom', current.id,
      `Updated unit ${current.symbol} to ${uom.symbol} (1 ${uom.symbol} = ${fmtNumber(uom.to_base_factor, 8)} ${BASE_SYMBOL[current.base_type]})`);
    const usage = await uomUsage(db, current.id);
    res.json({ id: current.id, base_type: current.base_type, ...uom, is_base: false, in_use: !!usage, usage });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'symbol', message: 'This symbol already exists.' });
    sendError(res, err, 'The unit could not be saved. Try again.');
  }
});

router.delete('/uom/:id', auth, canEdit, async (req, res) => {
  try {
    const [[current]] = await db.query('SELECT id, symbol, base_type FROM units_of_measurement WHERE id=?', [req.params.id]);
    if (!current) throw fail(404, 'The unit no longer exists.');
    if (isBaseUnit(current)) throw fail(409, `${current.symbol} is the base unit for ${UOM_TYPES[current.base_type].toLowerCase()} and cannot be deleted.`);
    const usage = await uomUsage(db, current.id);
    if (usage) throw fail(409, usage, { code: 'UOM_IN_USE' });
    await db.query('DELETE FROM units_of_measurement WHERE id=?', [current.id]);
    await logAudit(req, 'DELETE', 'raw-materials/uom', current.id, `Deleted unit ${current.symbol}`);
    res.json({ message: `Unit ${current.symbol} deleted.` });
  } catch (err) { sendError(res, err, 'The unit could not be deleted. Try again.'); }
});

// ── Raw materials ──────────────────────────────────────────────────────────
const MATERIAL_SELECT = `
  SELECT rm.id, rm.name, rm.material_type, rm.uom_id, u.symbol AS uom_symbol, u.base_type,
         rm.cost_per_unit AS purchase_rate, rm.stock_qty, rm.updated_at,
         (SELECT COUNT(*) FROM rm_purchase_lines l WHERE l.raw_material_id = rm.id) AS purchase_count,
         (SELECT l.rate FROM rm_purchase_lines l JOIN rm_purchase_headers h ON h.id = l.header_id
           WHERE l.raw_material_id = rm.id ORDER BY h.date DESC, h.id DESC LIMIT 1) AS last_purchase_rate,
         (SELECT h.date FROM rm_purchase_lines l JOIN rm_purchase_headers h ON h.id = l.header_id
           WHERE l.raw_material_id = rm.id ORDER BY h.date DESC, h.id DESC LIMIT 1) AS last_purchase_date,
         (SELECT COUNT(DISTINCT t.batch_id) FROM (
            SELECT bm.batch_id FROM mfg_batch_materials bm WHERE bm.raw_material_id = rm.id
            UNION ALL
            SELECT bp.batch_id FROM mfg_batch_pack_materials pm
              JOIN mfg_batch_packs bp ON bp.id = pm.pack_id WHERE pm.raw_material_id = rm.id
          ) t) AS batch_count
    FROM raw_materials rm
    LEFT JOIN units_of_measurement u ON u.id = rm.uom_id`;

function materialUsage(row) {
  const parts = [];
  if (Number(row.purchase_count)) parts.push(plural(row.purchase_count, 'purchase', 'purchases'));
  if (Number(row.batch_count)) parts.push(plural(row.batch_count, 'batch', 'batches'));
  return parts.length ? `Used in ${joinAnd(parts)}.` : null;
}

const shapeMaterial = (r) => {
  const usage = materialUsage(r);
  return {
    ...r, purchase_count: Number(r.purchase_count), batch_count: Number(r.batch_count),
    last_purchase_date: dateOnly(r.last_purchase_date), in_use: !!usage, usage,
  };
};

router.get('/', auth, canRead, async (req, res) => {
  try {
    const { type } = req.query;
    const params = [];
    let sql = MATERIAL_SELECT;
    if (type === 'raw_material' || type === 'packaging_material') { sql += ' WHERE rm.material_type = ?'; params.push(type); }
    sql += ' ORDER BY rm.material_type, rm.name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(shapeMaterial));
  } catch (err) { sendError(res, err, 'The materials could not be loaded.'); }
});

// `current` (on edit): once the material has a purchase its rate is the
// average of its purchases and cannot be typed; a missing rate keeps it.
async function validateMaterial(conn, body, current) {
  const excludeId = current?.id;
  const name = cleanText(body.name);
  if (!name) throw fail(400, 'Enter the material name.', { field: 'name' });
  if (name.length > 200) throw fail(400, 'The name must have 200 characters or fewer.', { field: 'name' });
  const type = body.material_type;
  if (type !== 'raw_material' && type !== 'packaging_material') throw fail(400, 'Choose the material type.', { field: 'material_type' });

  let uomId;
  if (type === 'packaging_material') {
    // Packaging is always counted in pcs.
    const [[pcs]] = await conn.query("SELECT id FROM units_of_measurement WHERE symbol = 'pcs' LIMIT 1");
    if (!pcs) throw fail(400, 'The pcs unit is missing. Add it under Units of measure.', { field: 'uom_id' });
    uomId = pcs.id;
  } else {
    const [[uom]] = await conn.query('SELECT id FROM units_of_measurement WHERE id = ?', [body.uom_id || 0]);
    if (!uom) throw fail(400, 'Choose the unit.', { field: 'uom_id' });
    uomId = uom.id;
  }

  let rate;
  if (current && current.purchase_count > 0) {
    rate = parseFloat(current.purchase_rate);
    const blank = body.purchase_rate === undefined || body.purchase_rate === null || body.purchase_rate === '';
    if (!blank && Math.abs(round4(num(body.purchase_rate)) - rate) > 1e-9) {
      throw fail(409, `The rate of ${current.name} is the average of its purchases and cannot be changed by hand.`, { field: 'purchase_rate' });
    }
  } else {
    rate = num(body.purchase_rate);
    if (!(rate > 0)) throw fail(400, 'Enter a purchase rate greater than 0.', { field: 'purchase_rate' });
    if (rate > MAX_MONEY || !decimalsOk(rate, 4)) throw fail(400, 'Enter the purchase rate with at most 4 decimals.', { field: 'purchase_rate' });
  }

  const [dups] = await conn.query(
    'SELECT id, name FROM raw_materials WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ? LIMIT 1', [name, excludeId || 0]
  );
  if (dups.length) throw fail(409, `${dups[0].name} already exists.`, { field: 'name' });
  return { name, material_type: type, uom_id: uomId, purchase_rate: round4(rate) };
}

router.post('/', auth, canEdit, async (req, res) => {
  try {
    const v = await validateMaterial(db, req.body);
    const [result] = await db.query(
      'INSERT INTO raw_materials (name, material_type, uom_id, cost_per_unit, stock_qty) VALUES (?,?,?,?,0)',
      [v.name, v.material_type, v.uom_id, v.purchase_rate]
    );
    await logAudit(req, 'CREATE', 'raw-materials', result.insertId, `Added material "${v.name}" at ${fmtPKR(v.purchase_rate)}`);
    res.status(201).json({ id: result.insertId, ...v, stock_qty: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A material with this name already exists.' });
    sendError(res, err, 'The material could not be saved. Try again.');
  }
});

router.put('/:id', auth, canEdit, async (req, res) => {
  try {
    const [rows] = await db.query(`${MATERIAL_SELECT} WHERE rm.id = ?`, [req.params.id]);
    if (!rows.length) throw fail(404, 'The material no longer exists.');
    const current = shapeMaterial(rows[0]);
    const v = await validateMaterial(db, req.body, current);
    if (current.in_use && v.material_type !== current.material_type) {
      throw fail(409, 'The type cannot change once the material has purchases or batches.', { field: 'material_type' });
    }
    if (current.in_use && Number(v.uom_id) !== Number(current.uom_id)) {
      throw fail(409, 'The unit cannot change once the material has purchases or batches.', { field: 'uom_id' });
    }
    await db.query('UPDATE raw_materials SET name=?, material_type=?, uom_id=?, cost_per_unit=? WHERE id=?',
      [v.name, v.material_type, v.uom_id, v.purchase_rate, current.id]);
    const rateNote = Math.abs(parseFloat(current.purchase_rate) - v.purchase_rate) > 1e-9
      ? `; purchase rate ${fmtPKR(current.purchase_rate)} to ${fmtPKR(v.purchase_rate)}` : '';
    await logAudit(req, 'UPDATE', 'raw-materials', current.id, `Updated material "${v.name}"${rateNote}`);
    res.json({ id: current.id, ...v });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A material with this name already exists.' });
    sendError(res, err, 'The material could not be saved. Try again.');
  }
});

router.delete('/:id', auth, canEdit, async (req, res) => {
  try {
    const [rows] = await db.query(`${MATERIAL_SELECT} WHERE rm.id = ?`, [req.params.id]);
    if (!rows.length) throw fail(404, 'The material no longer exists.');
    const current = shapeMaterial(rows[0]);
    if (current.in_use) throw fail(409, current.usage, { code: 'MATERIAL_IN_USE' });
    await db.query('DELETE FROM rm_ledger WHERE raw_material_id = ?', [current.id]);
    await db.query('DELETE FROM raw_materials WHERE id = ?', [current.id]);
    await logAudit(req, 'DELETE', 'raw-materials', current.id, `Deleted material "${current.name}"`);
    res.json({ message: `${current.name} deleted.` });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ message: 'The material is in use and cannot be deleted.' });
    sendError(res, err, 'The material could not be deleted. Try again.');
  }
});

// ── Raw material purchases ─────────────────────────────────────────────────
// One document, many lines. Other charges (freight, loading…) are purchase cost
// only: they raise each line's landed rate but are NOT owed to the supplier,
// so the supplier ledger gets the items total. Ledger rows use reference_type
// 'rm_purchase' -> rm_purchase_headers.id (never 'purchase', which is the
// distribution purchases' type).

const purchasePrefix = (date) => `RP${date.slice(2, 4)}`;

async function nextPurchaseNo(conn, date) {
  const prefix = purchasePrefix(date);
  const [rows] = await conn.query(
    `SELECT purchase_no FROM rm_purchase_headers WHERE purchase_no LIKE ?
      ORDER BY LENGTH(purchase_no) DESC, purchase_no DESC LIMIT 1 FOR UPDATE`,
    [`${prefix}-%`]
  );
  const last = rows.length ? parseInt(rows[0].purchase_no.split('-')[1], 10) || 0 : 0;
  return `${prefix}-${String(last + 1).padStart(5, '0')}`;
}

const HEADER_SELECT = `
  SELECT h.id, h.purchase_no, h.supplier_id, s.name AS supplier_name, h.date, h.invoice_no,
         h.items_total, h.other_charges, h.charges_note, h.created_at, u.full_name AS created_by_name,
         (SELECT COUNT(*) FROM rm_purchase_lines l WHERE l.header_id = h.id) AS line_count
    FROM rm_purchase_headers h
    JOIN suppliers s ON s.id = h.supplier_id
    LEFT JOIN users u ON u.id = h.created_by`;

async function loadPurchaseLines(conn, headerIds) {
  const out = new Map(headerIds.map(id => [id, []]));
  if (!headerIds.length) return out;
  const [lines] = await conn.query(
    `SELECT l.id, l.header_id, l.raw_material_id, rm.name AS rm_name, rm.material_type, u.symbol AS uom_symbol,
            l.qty, l.rate, l.line_total, l.charges_share, l.landed_rate
       FROM rm_purchase_lines l
       JOIN raw_materials rm ON rm.id = l.raw_material_id
       LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
      WHERE l.header_id IN (?) ORDER BY l.id`, [headerIds]
  );
  lines.forEach(l => out.get(l.header_id).push(l));
  return out;
}

const shapeHeader = (h) => ({ ...h, date: dateOnly(h.date), created_at: h.created_at ? nowPKT(h.created_at) : null, line_count: Number(h.line_count) });

router.get('/purchases', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`${HEADER_SELECT} ORDER BY h.date DESC, h.id DESC`);
    const headers = rows.map(shapeHeader);
    const lines = await loadPurchaseLines(db, headers.map(h => h.id));
    res.json(headers.map(h => ({ ...h, lines: lines.get(h.id) })));
  } catch (err) { sendError(res, err, 'The purchases could not be loaded.'); }
});

router.get('/purchases/:id', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`${HEADER_SELECT} WHERE h.id = ?`, [req.params.id]);
    if (!rows.length) throw fail(404, 'The purchase no longer exists.');
    const header = shapeHeader(rows[0]);
    const lines = await loadPurchaseLines(db, [header.id]);
    res.json({ ...header, lines: lines.get(header.id) });
  } catch (err) { sendError(res, err, 'The purchase could not be loaded.'); }
});

router.post('/purchases', auth, canEdit, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const body = req.body || {};

    // Header
    const supplierId = Number(body.supplier_id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) throw fail(400, 'Choose the supplier.', { field: 'supplier_id' });
    const [[supplier]] = await conn.query('SELECT id, name, supplier_type FROM suppliers WHERE id = ? FOR UPDATE', [supplierId]);
    if (!supplier || !['raw_material', 'both'].includes(supplier.supplier_type)) {
      throw fail(400, 'Choose a raw material supplier from the list.', { field: 'supplier_id' });
    }
    if (!isDate(body.date)) throw fail(400, 'Enter the purchase date.', { field: 'date' });
    if (body.date > todayPKT()) throw fail(400, 'The purchase date cannot be in the future.', { field: 'date' });
    const invoiceNo = cleanText(body.invoice_no) || null;
    if (invoiceNo && invoiceNo.length > 100) throw fail(400, 'The invoice number must have 100 characters or fewer.', { field: 'invoice_no' });
    const charges = body.other_charges === '' || body.other_charges == null ? 0 : num(body.other_charges);
    if (!Number.isFinite(charges) || charges < 0) throw fail(400, 'Enter other charges of 0 or more.', { field: 'other_charges' });
    if (charges > MAX_MONEY || !decimalsOk(charges, 2)) throw fail(400, 'Enter other charges with at most 2 decimals.', { field: 'other_charges' });
    const chargesNote = cleanText(body.charges_note) || null;
    if (chargesNote && chargesNote.length > 150) throw fail(400, 'The note must have 150 characters or fewer.', { field: 'charges_note' });

    // Lines (materials locked in id order)
    const linesIn = Array.isArray(body.lines) ? body.lines : [];
    if (!linesIn.length) throw fail(400, 'Add at least one material.', { field: 'lines' });
    const ids = [...new Set(linesIn.map(l => Number(l.raw_material_id)).filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
    const rmById = new Map();
    if (ids.length) {
      const [rmRows] = await conn.query(
        `SELECT rm.id, rm.name, rm.stock_qty, rm.cost_per_unit, u.symbol AS uom_symbol, u.base_type
           FROM raw_materials rm LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
          WHERE rm.id IN (?) ORDER BY rm.id FOR UPDATE`, [ids]
      );
      rmRows.forEach(r => rmById.set(r.id, r));
    }
    const seen = new Set();
    const lines = linesIn.map((l, i) => {
      const rm = rmById.get(Number(l.raw_material_id));
      if (!rm) throw fail(400, 'Choose a material on every line.', { field: 'lines', line: i });
      if (seen.has(rm.id)) throw fail(400, `${rm.name} is listed twice. Combine the quantities on one line.`, { field: 'lines', line: i });
      seen.add(rm.id);
      const qty = num(l.qty);
      if (!(qty > 0)) throw fail(400, `Enter a quantity greater than 0 for ${rm.name}.`, { field: 'lines', line: i });
      if (rm.base_type === 'count' && !Number.isInteger(qty)) throw fail(400, `Enter a whole number of ${rm.uom_symbol} for ${rm.name}.`, { field: 'lines', line: i });
      if (qty > 9999999999 || !decimalsOk(qty, 4)) throw fail(400, `Enter the quantity of ${rm.name} with at most 4 decimals.`, { field: 'lines', line: i });
      const rate = num(l.rate);
      if (!(rate > 0)) throw fail(400, `Enter a rate greater than 0 for ${rm.name}.`, { field: 'lines', line: i });
      if (rate > MAX_MONEY || !decimalsOk(rate, 4)) throw fail(400, `Enter the rate of ${rm.name} with at most 4 decimals.`, { field: 'lines', line: i });
      return { rm, qty, rate };
    });
    const costs = landedRates(lines, charges);
    const itemsTotal = round2(costs.reduce((s, c) => s + c.lineTotal, 0));
    if (itemsTotal > MAX_MONEY) throw fail(400, 'The purchase total is too large to record.', { field: 'lines' });

    const purchaseNo = await nextPurchaseNo(conn, body.date);
    const [result] = await conn.query(
      `INSERT INTO rm_purchase_headers (purchase_no, supplier_id, date, invoice_no, items_total, other_charges, charges_note, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [purchaseNo, supplier.id, body.date, invoiceNo, itemsTotal, round2(charges), chargesNote, req.user?.id || null]
    );
    const headerId = result.insertId;

    const averages = [];
    for (let i = 0; i < lines.length; i += 1) {
      const { rm, qty, rate } = lines[i];
      const c = costs[i];
      await conn.query(
        `INSERT INTO rm_purchase_lines (header_id, raw_material_id, qty, rate, line_total, charges_share, landed_rate)
         VALUES (?,?,?,?,?,?,?)`,
        [headerId, rm.id, qty, rate, c.lineTotal, c.chargesShare, c.landedRate]
      );
      // Weighted average over the stock already held (row locked above).
      const average = weightedAverageRate(parseFloat(rm.stock_qty), parseFloat(rm.cost_per_unit), qty, c.landedRate);
      averages.push(average);
      await conn.query('UPDATE raw_materials SET stock_qty = stock_qty + ?, cost_per_unit = ? WHERE id = ?', [qty, average, rm.id]);
      const [[{ stock_qty: balance }]] = await conn.query('SELECT stock_qty FROM raw_materials WHERE id = ?', [rm.id]);
      await conn.query(
        `INSERT INTO rm_ledger (raw_material_id, date, reference_type, reference_id, description, qty_in, qty_out, balance_qty, unit_cost)
         VALUES (?,?,'rm_purchase',?,?,?,0,?,?)`,
        [rm.id, body.date, headerId, `Purchase ${purchaseNo}${invoiceNo ? ` (invoice ${invoiceNo})` : ''}`, qty, balance, c.landedRate]
      );
    }

    // Supplier payable: the items only.
    await conn.query('UPDATE suppliers SET balance = balance + ? WHERE id = ?', [itemsTotal, supplier.id]);
    const [[{ balance: supplierBalance }]] = await conn.query('SELECT balance FROM suppliers WHERE id = ?', [supplier.id]);
    await conn.query(
      `INSERT INTO supplier_ledger (supplier_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
       VALUES (?,?,?,?,?,0,?,'rm_purchase',?)`,
      [supplier.id, body.date, invoiceNo, `Raw material purchase ${purchaseNo}`, itemsTotal, supplierBalance, headerId]
    );

    await conn.commit();
    await logAudit(req, 'CREATE', 'raw-materials/purchases', headerId,
      `Recorded purchase ${purchaseNo} from ${supplier.name}: ${plural(lines.length, 'line', 'lines')}, items ${fmtPKR(itemsTotal)}`
      + (charges > 0 ? `, other charges ${fmtPKR(charges)}` : ''));
    res.status(201).json({
      id: headerId, purchase_no: purchaseNo, items_total: itemsTotal, other_charges: round2(charges),
      lines: lines.map((l, i) => ({ raw_material_id: l.rm.id, landed_rate: costs[i].landedRate, purchase_rate: averages[i] })),
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Another purchase was recorded at the same moment. Save the purchase again.' });
    }
    sendError(res, err, 'The purchase could not be recorded. Try again.');
  } finally { conn.release(); }
});

// Deleting takes the purchased quantity back out of stock, so it is refused
// when that would leave less than nothing (some of it has gone into batches).
// Each material's average is then rebuilt from its remaining ledger; batches
// keep the costs they froze.
router.delete('/purchases/:id', auth, canEdit, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[header]] = await conn.query('SELECT * FROM rm_purchase_headers WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!header) throw fail(404, 'The purchase no longer exists.');
    const [lines] = await conn.query('SELECT * FROM rm_purchase_lines WHERE header_id = ? ORDER BY raw_material_id', [header.id]);
    if (lines.length) {
      const [rmRows] = await conn.query(
        `SELECT rm.id, rm.name, rm.stock_qty, rm.cost_per_unit, u.symbol AS uom_symbol
           FROM raw_materials rm LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
          WHERE rm.id IN (?) ORDER BY rm.id FOR UPDATE`, [lines.map(l => l.raw_material_id)]
      );
      const rmById = new Map(rmRows.map(r => [r.id, r]));
      const used = lines
        .map(l => ({ rm: rmById.get(l.raw_material_id), short: round4(parseFloat(l.qty) - parseFloat(rmById.get(l.raw_material_id).stock_qty)) }))
        .filter(x => x.short > 1e-9);
      if (used.length) {
        const amounts = used.map(x => `${fmtQty(x.short, x.rm.uom_symbol)}${lines.length > 1 ? ` of ${x.rm.name}` : ''}`);
        const what = lines.length > 1 ? `${joinAnd(amounts)} from it` : `${amounts[0]} of it`;
        throw fail(409, `${header.purchase_no} can't be deleted: ${what} ${used.length > 1 ? 'have' : 'has'} already been used in batches.`,
          { code: 'PURCHASE_STOCK_USED' });
      }
      for (const l of lines) {
        await conn.query('UPDATE raw_materials SET stock_qty = stock_qty - ? WHERE id = ?', [l.qty, l.raw_material_id]);
      }
    }
    await conn.query('SELECT id FROM suppliers WHERE id = ? FOR UPDATE', [header.supplier_id]);
    await conn.query('UPDATE suppliers SET balance = balance - ? WHERE id = ?', [header.items_total, header.supplier_id]);
    await conn.query(`DELETE FROM supplier_ledger WHERE reference_type = 'rm_purchase' AND reference_id = ?`, [header.id]);
    await conn.query(`DELETE FROM rm_ledger WHERE reference_type = 'rm_purchase' AND reference_id = ?`, [header.id]);
    await conn.query('DELETE FROM rm_purchase_headers WHERE id = ?', [header.id]);
    for (const l of lines) {
      const average = await replayAverageRate(conn, l.raw_material_id);
      if (average !== null) await conn.query('UPDATE raw_materials SET cost_per_unit = ? WHERE id = ?', [average, l.raw_material_id]);
    }
    await conn.commit();
    await logAudit(req, 'DELETE', 'raw-materials/purchases', header.id, `Deleted purchase ${header.purchase_no}; stock, average rates and supplier balance reversed`);
    res.json({ message: `Purchase ${header.purchase_no} deleted.` });
  } catch (err) {
    await conn.rollback().catch(() => {});
    sendError(res, err, 'The purchase could not be deleted. Try again.');
  } finally { conn.release(); }
});

// ── Per-material history (detail dialog) ───────────────────────────────────
router.get('/:id/purchases', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT h.id AS purchase_id, h.purchase_no, h.date, s.name AS supplier_name, h.invoice_no,
              l.qty, l.rate, l.line_total, l.landed_rate
         FROM rm_purchase_lines l
         JOIN rm_purchase_headers h ON h.id = l.header_id
         JOIN suppliers s ON s.id = h.supplier_id
        WHERE l.raw_material_id = ?
        ORDER BY h.date DESC, h.id DESC`, [req.params.id]
    );
    res.json(rows.map(r => ({ ...r, date: dateOnly(r.date) })));
  } catch (err) { sendError(res, err, 'The purchase history could not be loaded.'); }
});

router.get('/:id/usage-history', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.id AS batch_id, b.batch_code, b.batch_date, b.status, b.product_name, NULL AS pack_size, bm.qty
         FROM mfg_batch_materials bm JOIN mfg_batches b ON b.id = bm.batch_id
        WHERE bm.raw_material_id = ?
       UNION ALL
       SELECT b.id, b.batch_code, b.batch_date, b.status, b.product_name, p.pack_size, pm.qty
         FROM mfg_batch_pack_materials pm
         JOIN mfg_batch_packs bp ON bp.id = pm.pack_id
         JOIN mfg_batches b ON b.id = bp.batch_id
         JOIN products p ON p.id = bp.product_id
        WHERE pm.raw_material_id = ?
       ORDER BY batch_date DESC, batch_id DESC`, [req.params.id, req.params.id]
    );
    res.json(rows.map(r => ({ ...r, batch_date: dateOnly(r.batch_date) })));
  } catch (err) { sendError(res, err, 'The usage history could not be loaded.'); }
});

router.get('/:id/ledger', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM rm_ledger WHERE raw_material_id=? ORDER BY date ASC, id ASC', [req.params.id]
    );
    res.json(rows.map(r => ({ ...r, date: dateOnly(r.date) })));
  } catch (err) { sendError(res, err, 'The ledger could not be loaded.'); }
});

router.get('/:id', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`${MATERIAL_SELECT} WHERE rm.id = ?`, [req.params.id]);
    if (!rows.length) throw fail(404, 'The material no longer exists.');
    res.json(shapeMaterial(rows[0]));
  } catch (err) { sendError(res, err, 'The material could not be loaded.'); }
});

module.exports = router;
