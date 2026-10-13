const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, nowPKT } = require('../utils/dateUtils');
const { canViewPurchaseRate } = require('../utils/purchaseRateAccess');
const {
  MAX_MONEY, num, round2, round4, cleanText, normKey, normSql, packLabel, isDate, dateOnly, decimalsOk,
  fmtNumber, fmtPKR, fmtQty, plural, fail, sendError, computeBatchCosting, replayAverageRate,
} = require('../utils/manufacturing');

// ─── Manufacturing ─────────────────────────────────────────────────────────
// Product categories, manufactured products, by-products and batches.
//
// Batch lifecycle (rework 2026-10-12):
//   POST /batches          deducts raw-material and packaging stock -> status 'ready'.
//                          Each line is costed at the material's weighted average
//                          rate at that moment (never a rate the client sends) and
//                          keeps that cost. A draft holds no stock; the editor
//                          previews it at the current averages
//   DELETE /batches/:id    only while 'ready'; returns the stock and rebuilds the
//                          materials' averages from the ledger
//   POST /batches/:id/send-to-inventory
//                          packs (batch code + batch expiry) and by-products (own
//                          batch no + expiry) into inventory -> 'in_inventory', read-only
// Ledger rows use reference_type 'mfg_batch' -> mfg_batches.id only, so a delete
// can never touch another table's rows.

// ── Database updates this code needs ───────────────────────────────────────
// Migrations are applied by hand before a deploy. If one is missing, every
// manufacturing request would fail with a bare "could not be loaded" (an
// unknown column); answer 503 naming the script instead. Checked until all
// are present, then never again for the life of the process.
const REQUIRED_SCHEMA = [
  { table: 'mfg_batch_byproducts', column: 'sale_rate', script: 'mfg_byproduct_sale_rate.sql' },
  { table: 'mfg_pack_types', column: 'name', script: 'mfg_pack_types.sql' },
  { table: 'products', column: 'pack_type_id', script: 'mfg_pack_types.sql' },
];
let schemaReady = false;
async function requireSchema(req, res, next) {
  if (schemaReady) return next();
  try {
    const [rows] = await db.query(
      `SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS col FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME, COLUMN_NAME) IN (?)`,
      [REQUIRED_SCHEMA.map(r => [r.table, r.column])]
    );
    const have = new Set(rows.map(r => r.col));
    const missing = [...new Set(REQUIRED_SCHEMA.filter(r => !have.has(`${r.table}.${r.column}`)).map(r => r.script))];
    if (!missing.length) { schemaReady = true; return next(); }
    console.error(`Manufacturing: the database is missing ${missing.join(', ')} (server/migrations).`);
    return res.status(503).json({
      code: 'SCHEMA_OUTDATED',
      message: `Manufacturing needs a database update before it can be used. Ask the administrator to run ${missing.join(' and ')}.`,
    });
  } catch (err) { return sendError(res, err, 'Manufacturing could not be loaded. Try again.'); }
}
router.use(requireSchema);

const MFG_FLAGS = ['perm_mfg_products', 'perm_mfg_raw_materials', 'perm_mfg_batches', 'perm_mfg_yields'];
const canRead = requirePermission.any(MFG_FLAGS, 'Manufacturing');
const canEditProducts = requirePermission('perm_mfg_products', 'Manufactured Products');
const canEditBatches = requirePermission('perm_mfg_batches', 'Batches');
const canSendToInventory = requirePermission('perm_mfg_yields', 'Yield');

// Same helper as purchases.js / sales.js / inventory.js (kept per file by convention).
async function recordInventoryMovement(conn, {
  productId, batchNo, date, refType, refId, qtyIn, qtyOut, rateAtMovement, note,
}) {
  await conn.query(
    `INSERT INTO inventory_movements
       (product_id, batch_no, movement_date, ref_type, ref_id,
        qty_in, qty_out, rate_at_movement, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [productId, batchNo || '', date, refType, refId,
     qtyIn || 0, qtyOut || 0, rateAtMovement ?? null, note || null]
  );
}

async function getUom(conn, id) {
  if (!id) return null;
  const [rows] = await conn.query(
    'SELECT id, symbol, base_type, to_base_factor FROM units_of_measurement WHERE id=?', [id]
  );
  const uom = rows[0];
  return uom && parseFloat(uom.to_base_factor) > 0 ? uom : null;
}

const blankValue = (v) => v === null || v === undefined || v === '';

/** "Used by 4 products." / "Used in 2 batches." — the reason a delete is refused. */
function productUsage(row) {
  const batches = Number(row.batch_count || 0);
  const sales = Number(row.sale_count || 0);
  const stock = Number(row.inventory_count || 0);
  const purchases = Number(row.purchase_count || 0);
  if (batches) return `Used in ${plural(batches, 'batch', 'batches')}.`;
  if (sales) return `Used on ${plural(sales, 'invoice line', 'invoice lines')}.`;
  if (purchases) return `Used on ${plural(purchases, 'purchase line', 'purchase lines')}.`;
  if (stock) return 'Held in inventory.';
  return null;
}

// ── Product categories ─────────────────────────────────────────────────────
router.get('/categories', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.id, c.name,
             (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
        FROM product_categories c
       ORDER BY c.name`);
    res.json(rows.map(r => ({ ...r, product_count: Number(r.product_count) })));
  } catch (err) { sendError(res, err, 'The categories could not be loaded.'); }
});

async function validateCategoryName(conn, rawName, excludeId) {
  const name = cleanText(rawName);
  if (!name) throw fail(400, 'Enter a category name.', { field: 'name' });
  if (name.length > 60) throw fail(400, 'The name must have 60 characters or fewer.', { field: 'name' });
  const [dups] = await conn.query(
    `SELECT id, name FROM product_categories WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ? LIMIT 1`,
    [name, excludeId || 0]
  );
  if (dups.length) throw fail(409, `A category named "${dups[0].name}" already exists.`, { field: 'name' });
  return name;
}

router.post('/categories', auth, canEditProducts, async (req, res) => {
  try {
    const name = await validateCategoryName(db, req.body.name);
    const [result] = await db.query('INSERT INTO product_categories (name) VALUES (?)', [name]);
    await logAudit(req, 'CREATE', 'manufacturing/categories', result.insertId, `Added product category "${name}"`);
    res.status(201).json({ id: result.insertId, name, product_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A category with this name already exists.' });
    sendError(res, err, 'The category could not be added. Try again.');
  }
});

router.put('/categories/:id', auth, canEditProducts, async (req, res) => {
  try {
    const [[existing]] = await db.query('SELECT id, name FROM product_categories WHERE id=?', [req.params.id]);
    if (!existing) throw fail(404, 'The category no longer exists.');
    const name = await validateCategoryName(db, req.body.name, existing.id);
    await db.query('UPDATE product_categories SET name=? WHERE id=?', [name, existing.id]);
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM products WHERE category_id=?', [existing.id]);
    await logAudit(req, 'UPDATE', 'manufacturing/categories', existing.id, `Renamed product category "${existing.name}" to "${name}"`);
    res.json({ id: existing.id, name, product_count: Number(n) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A category with this name already exists.' });
    sendError(res, err, 'The category could not be renamed. Try again.');
  }
});

router.delete('/categories/:id', auth, canEditProducts, async (req, res) => {
  try {
    const [[existing]] = await db.query('SELECT id, name FROM product_categories WHERE id=?', [req.params.id]);
    if (!existing) throw fail(404, 'The category no longer exists.');
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM products WHERE category_id=?', [existing.id]);
    if (Number(n) > 0) throw fail(409, `Used by ${plural(n, 'product', 'products')}.`, { code: 'CATEGORY_IN_USE' });
    await db.query('DELETE FROM product_categories WHERE id=?', [existing.id]);
    await logAudit(req, 'DELETE', 'manufacturing/categories', existing.id, `Deleted product category "${existing.name}"`);
    res.json({ message: 'Category deleted.' });
  } catch (err) { sendError(res, err, 'The category could not be deleted. Try again.'); }
});

// ── Pack types (manufactured products only) ────────────────────────────────
// A managed list like categories. The name is printed inside pack sizes
// ("200 ml Pouch") on invoices, so one in use can be neither renamed nor
// deleted. Names are unique, case and extra spaces ignored.
const PACK_TYPE_SELECT = `
  SELECT t.id, t.name, (SELECT COUNT(*) FROM products p WHERE p.pack_type_id = t.id) AS product_count
    FROM mfg_pack_types t`;
const packTypeInUse = (t) => fail(409,
  `${t.name} is used by ${plural(t.product_count, 'product', 'products')}, so it can't be renamed or deleted.`,
  { field: 'name', code: 'PACK_TYPE_IN_USE' });

async function findPackType(conn, id) {
  const [[row]] = await conn.query(`${PACK_TYPE_SELECT} WHERE t.id = ?`, [id]);
  if (!row) throw fail(404, 'The pack type no longer exists.');
  return { ...row, product_count: Number(row.product_count) };
}

async function validatePackTypeName(conn, rawName, excludeId) {
  const name = cleanText(rawName);
  if (!name) throw fail(400, 'Enter a pack type name.', { field: 'name' });
  if (name.length > 40) throw fail(400, 'The name must have 40 characters or fewer.', { field: 'name' });
  const [dups] = await conn.query(
    `SELECT id, name FROM mfg_pack_types WHERE ${normSql('name')} = ? AND id <> ? LIMIT 1`,
    [normKey(name), excludeId || 0]
  );
  if (dups.length) throw fail(409, `A pack type named "${dups[0].name}" already exists.`, { field: 'name' });
  return name;
}

router.get('/pack-types', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`${PACK_TYPE_SELECT} ORDER BY t.name`);
    res.json(rows.map(r => ({ ...r, product_count: Number(r.product_count) })));
  } catch (err) { sendError(res, err, 'The pack types could not be loaded.'); }
});

router.post('/pack-types', auth, canEditProducts, async (req, res) => {
  try {
    const name = await validatePackTypeName(db, req.body.name);
    const [result] = await db.query('INSERT INTO mfg_pack_types (name) VALUES (?)', [name]);
    await logAudit(req, 'CREATE', 'manufacturing/pack-types', result.insertId, `Added pack type "${name}"`);
    res.status(201).json({ id: result.insertId, name, product_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A pack type with this name already exists.' });
    sendError(res, err, 'The pack type could not be added. Try again.');
  }
});

router.put('/pack-types/:id', auth, canEditProducts, async (req, res) => {
  try {
    const existing = await findPackType(db, req.params.id);
    const name = await validatePackTypeName(db, req.body.name, existing.id);
    if (name === existing.name) return res.json(existing);
    if (existing.product_count > 0) throw packTypeInUse(existing);
    await db.query('UPDATE mfg_pack_types SET name=? WHERE id=?', [name, existing.id]);
    await logAudit(req, 'UPDATE', 'manufacturing/pack-types', existing.id, `Renamed pack type "${existing.name}" to "${name}"`);
    res.json({ id: existing.id, name, product_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A pack type with this name already exists.' });
    sendError(res, err, 'The pack type could not be renamed. Try again.');
  }
});

router.delete('/pack-types/:id', auth, canEditProducts, async (req, res) => {
  try {
    const existing = await findPackType(db, req.params.id);
    if (existing.product_count > 0) throw packTypeInUse(existing);
    await db.query('DELETE FROM mfg_pack_types WHERE id=?', [existing.id]);
    await logAudit(req, 'DELETE', 'manufacturing/pack-types', existing.id, `Deleted pack type "${existing.name}"`);
    res.json({ message: 'Pack type deleted.' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ message: 'The pack type is in use and cannot be deleted.' });
    sendError(res, err, 'The pack type could not be deleted. Try again.');
  }
});

// ── Manufactured products and by-products ──────────────────────────────────
// Both are rows in `products` (is_manufactured = 1), so Sale, Inventory and
// Reports treat them like any other product; all of them read pack_size.
//   Manufactured product: pack size = number + unit (volume, volume_uom_id, a
//     weight or volume) plus an optional pack type from the managed list
//     (pack_type_id; its name is copied to pack_type). pack_size is generated:
//     "200 ml", "200 ml Pouch". Unique by name + size in base units + pack type.
//   By-product: its pack size IS its unit ("kg", "pcs"): no number and no pack
//     type (volume is kept at 1 internally). Unique by name. The unit is fixed
//     once the by-product is in use.
const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.pack_size, p.pack_type, p.pack_type_id, p.volume, p.volume_uom_id,
         u.symbol AS vol_uom_symbol, u.base_type AS vol_uom_base_type, u.to_base_factor AS vol_uom_factor,
         p.purchase_rate, p.show_purchase_rate, p.sale_rate, p.retail_price,
         p.company_id, c.name AS company_name, p.category_id, pc.name AS category_name,
         p.tax_applicable, p.sale_tax_pct, p.is_by_product,
         (SELECT COUNT(DISTINCT bp.batch_id) FROM mfg_batch_packs bp WHERE bp.product_id = p.id)
           + (SELECT COUNT(DISTINCT bb.batch_id) FROM mfg_batch_byproducts bb WHERE bb.product_id = p.id) AS batch_count,
         (SELECT COUNT(*) FROM inventory i WHERE i.product_id = p.id) AS inventory_count,
         (SELECT COUNT(*) FROM sale_items si WHERE si.product_id = p.id) AS sale_count,
         (SELECT COUNT(*) FROM purchase_items pi WHERE pi.product_id = p.id) AS purchase_count
    FROM products p
    LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN product_categories pc ON pc.id = p.category_id`;

async function shapeProducts(req, rows) {
  const canView = await canViewPurchaseRate(req, db);
  return rows.map(r => {
    const usage = productUsage(r);
    return {
      ...r,
      batch_count: Number(r.batch_count),
      inventory_count: Number(r.inventory_count),
      sale_count: Number(r.sale_count),
      purchase_count: Number(r.purchase_count),
      in_use: !!usage,
      usage,
      purchase_rate: canView && Number(r.show_purchase_rate ?? 1) ? r.purchase_rate : null,
    };
  });
}

function moneyField(body, key, { field = key, label, allowZero = false }) {
  const value = num(body[key]);
  const rule = allowZero ? 'of 0 or more' : 'greater than 0';
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw fail(400, `Enter ${label} ${rule}.`, { field });
  }
  if (value > MAX_MONEY) throw fail(400, `Enter ${label} below ${fmtPKR(MAX_MONEY)}.`, { field });
  if (!decimalsOk(value, 2)) throw fail(400, `Enter ${label} with at most 2 decimals.`, { field });
  return round2(value);
}

/** Sale tax: the UI shows a checkbox and the % (owner decision 2026-10-12). 0–100 is
 *  accepted; a product is taxable only when the box is ticked AND the % is above 0. */
function taxFields(body) {
  const applicable = body.tax_applicable === true || body.tax_applicable === 1 || body.tax_applicable === '1';
  if (!applicable) return { tax_applicable: 0, sale_tax_pct: 0 };
  const pct = num(body.sale_tax_pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw fail(400, 'Enter a sale tax % from 0 to 100.', { field: 'sale_tax_pct' });
  }
  if (!decimalsOk(pct, 2)) throw fail(400, 'Enter the sale tax % with at most 2 decimals.', { field: 'sale_tax_pct' });
  return { tax_applicable: pct > 0 ? 1 : 0, sale_tax_pct: pct > 0 ? round2(pct) : 0 };
}

async function optionalRef(conn, table, id, field, message) {
  if (id === undefined || id === null || id === '') return null;
  const [rows] = await conn.query(`SELECT id FROM ${table} WHERE id=?`, [id]);
  if (!rows.length) throw fail(400, message, { field });
  return rows[0].id;
}

/** The pack type a product form names: pack_type_id from the list. An older
 *  client sends the name as text (pack_type): it is matched by name, and added
 *  to the list when new. Null for none. */
async function resolvePackType(conn, body) {
  if (!blankValue(body.pack_type_id)) {
    const [[row]] = await conn.query('SELECT id, name FROM mfg_pack_types WHERE id = ?', [body.pack_type_id]);
    if (!row) throw fail(400, 'Choose a pack type from the list.', { field: 'pack_type_id' });
    return row;
  }
  const text = cleanText(body.pack_type);
  if (!text) return null;
  const [[found]] = await conn.query(`SELECT id, name FROM mfg_pack_types WHERE ${normSql('name')} = ? LIMIT 1`, [normKey(text)]);
  if (found) return found;
  const name = await validatePackTypeName(conn, text);
  const [result] = await conn.query('INSERT INTO mfg_pack_types (name) VALUES (?)', [name]);
  return { id: result.insertId, name };
}

async function validateProduct(conn, body, kind, excludeId) {
  const name = cleanText(body.name);
  if (!name) throw fail(400, kind === 'by_product' ? 'Enter the by-product name.' : 'Enter the product name.', { field: 'name' });
  if (name.length > 200) throw fail(400, 'The name must have 200 characters or fewer.', { field: 'name' });

  const values = { name };
  if (kind === 'product') {
    // Pack size = number + unit (+ optional pack type from the list).
    const volume = num(body.volume);
    if (!(volume > 0)) throw fail(400, 'Enter the pack size.', { field: 'volume' });
    if (volume > 99999999 || !decimalsOk(volume, 3)) throw fail(400, 'Enter the pack size with at most 3 decimals.', { field: 'volume' });
    const uom = await getUom(conn, body.volume_uom_id);
    if (!uom) throw fail(400, 'Choose the pack size unit.', { field: 'volume_uom_id' });
    if (uom.base_type === 'count' && !Number.isInteger(volume)) throw fail(400, `Enter a whole number of ${uom.symbol} for the pack size.`, { field: 'volume' });
    const packType = await resolvePackType(conn, body);
    Object.assign(values, {
      pack_size: packLabel(volume, uom.symbol, packType?.name), pack_type: packType?.name || null, pack_type_id: packType?.id || null,
      volume: round4(volume), volume_uom_id: uom.id, _base: volume * parseFloat(uom.to_base_factor), _baseType: uom.base_type,
    });
    values.category_id = await optionalRef(conn, 'product_categories', body.category_id, 'category_id', 'Choose a category from the list.');
  } else {
    // Unit only. The withdrawn number + unit form sent it as volume_uom_id.
    const uom = await getUom(conn, blankValue(body.uom_id) ? body.volume_uom_id : body.uom_id);
    if (!uom) throw fail(400, 'Choose the unit.', { field: 'uom_id' });
    Object.assign(values, { pack_size: uom.symbol, pack_type: null, pack_type_id: null, volume: 1, volume_uom_id: uom.id });
    values.category_id = null;
    values.purchase_rate = moneyField(body, 'purchase_rate', { label: 'a purchase rate', allowZero: true });
  }
  if (body.company_id === undefined || body.company_id === null || body.company_id === '') {
    throw fail(400, 'Choose the company.', { field: 'company_id' });
  }
  values.company_id = await optionalRef(conn, 'companies', body.company_id, 'company_id', 'Choose a company from the list.');
  values.sale_rate = moneyField(body, 'sale_rate', { label: 'a sale rate' });
  values.retail_price = moneyField(body, 'retail_price', { label: 'a retail price' });
  Object.assign(values, taxFields(body));

  if (kind === 'product') {
    // Unique by name + size in base units + pack type, case and extra spaces
    // ignored, so 1 L and 1000 ml, or 1 kg and 1000 g, are one size.
    const [same] = await conn.query(
      `SELECT p.id, p.name, p.pack_size, p.pack_type, p.volume, u.to_base_factor, u.base_type
         FROM products p LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
        WHERE p.is_manufactured = 1 AND p.is_by_product = 0 AND ${normSql('p.name')} = ? AND p.id <> ?`,
      [normKey(values.name), excludeId || 0]
    );
    const dup = same.find(r => r.base_type === values._baseType
      && Math.abs(num(r.volume) * num(r.to_base_factor) - values._base) < 1e-6
      && normKey(r.pack_type || '') === normKey(values.pack_type || ''));
    if (dup) throw fail(409, `${dup.name} — ${dup.pack_size} already exists.`, { field: 'name' });
  } else {
    // One by-product per name, case and extra spaces ignored.
    const [[dup]] = await conn.query(
      `SELECT id, name FROM products
        WHERE is_manufactured = 1 AND is_by_product = 1 AND ${normSql('name')} = ? AND id <> ? LIMIT 1`,
      [normKey(values.name), excludeId || 0]
    );
    if (dup) throw fail(409, `A by-product named ${dup.name} already exists.`, { field: 'name' });
  }
  delete values._base; delete values._baseType;
  // Any product, distribution included, with the very same name and label.
  const [dups] = await conn.query(
    `SELECT id, name, pack_size FROM products
      WHERE ${normSql('name')} = ? AND ${normSql('pack_size')} = ? AND id <> ? LIMIT 1`,
    [normKey(values.name), normKey(values.pack_size), excludeId || 0]
  );
  if (dups.length) throw fail(409, `${dups[0].name} — ${dups[0].pack_size} already exists.`, { field: 'name' });
  return values;
}

function productRoutes(path, kind) {
  const isBy = kind === 'by_product' ? 1 : 0;
  const noun = kind === 'by_product' ? 'by-product' : 'product';

  router.get(path, auth, canRead, async (req, res) => {
    try {
      const [rows] = await db.query(
        `${PRODUCT_SELECT} WHERE p.is_manufactured = 1 AND p.is_by_product = ? ORDER BY p.name, p.volume * COALESCE(u.to_base_factor, 1)`, [isBy]
      );
      res.json(await shapeProducts(req, rows));
    } catch (err) { sendError(res, err, `The ${noun}s could not be loaded.`); }
  });

  router.post(path, auth, canEditProducts, async (req, res) => {
    try {
      const v = await validateProduct(db, req.body, kind);
      const [result] = await db.query(
        `INSERT INTO products (name, pack_size, pack_type, pack_type_id, volume, volume_uom_id, purchase_rate, show_purchase_rate,
           sale_rate, retail_price, company_id, category_id, is_manufactured, is_by_product, tax_applicable, sale_tax_pct)
         VALUES (?,?,?,?,?,?,?,1,?,?,?,?,1,?,?,?)`,
        [v.name, v.pack_size, v.pack_type, v.pack_type_id, v.volume, v.volume_uom_id, v.purchase_rate || 0,
         v.sale_rate, v.retail_price, v.company_id, v.category_id, isBy, v.tax_applicable, v.sale_tax_pct]
      );
      await logAudit(req, 'CREATE', 'manufacturing/products', result.insertId, `Added ${noun} "${v.name} — ${v.pack_size}"`);
      res.status(201).json({ id: result.insertId, ...v });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A product with this name and pack size already exists.' });
      sendError(res, err, `The ${noun} could not be saved. Try again.`);
    }
  });

  router.put(`${path}/:id`, auth, canEditProducts, async (req, res) => {
    try {
      const [rows] = await db.query(
        `${PRODUCT_SELECT} WHERE p.id = ? AND p.is_manufactured = 1 AND p.is_by_product = ?`, [req.params.id, isBy]
      );
      if (!rows.length) throw fail(404, `The ${noun} no longer exists.`);
      const current = rows[0];
      const v = await validateProduct(db, req.body, kind, current.id);
      // Stock and batch quantities of a by-product count its unit, so the unit
      // is fixed once in use, and so is the stored label (one the unit-only
      // migration could not convert, such as "25 kg Bag", keeps its meaning).
      if (kind === 'by_product' && productUsage(current)) {
        if (Number(v.volume_uom_id) !== Number(current.volume_uom_id)) {
          throw fail(409, 'The unit cannot change once the by-product is in a batch, in inventory or on an invoice.', { field: 'uom_id' });
        }
        Object.assign(v, { pack_size: current.pack_size, pack_type: current.pack_type, volume: current.volume });
      }
      const fields = ['name=?', 'pack_size=?', 'pack_type=?', 'pack_type_id=?', 'volume=?', 'volume_uom_id=?', 'sale_rate=?', 'retail_price=?',
        'company_id=?', 'category_id=?', 'tax_applicable=?', 'sale_tax_pct=?'];
      const params = [v.name, v.pack_size, v.pack_type, v.pack_type_id, v.volume, v.volume_uom_id, v.sale_rate, v.retail_price,
        v.company_id, v.category_id, v.tax_applicable, v.sale_tax_pct];
      // A manufactured product's purchase rate is its latest batch cost, set when a
      // batch is sent to inventory; a by-product's is entered here.
      if (kind === 'by_product') { fields.push('purchase_rate=?'); params.push(v.purchase_rate); }
      await db.query(`UPDATE products SET ${fields.join(', ')} WHERE id=?`, [...params, current.id]);
      await logAudit(req, 'UPDATE', 'manufacturing/products', current.id, `Updated ${noun} "${v.name} — ${v.pack_size}"`);
      res.json({ id: current.id, ...v });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ field: 'name', message: 'A product with this name and pack size already exists.' });
      sendError(res, err, `The ${noun} could not be saved. Try again.`);
    }
  });

  router.delete(`${path}/:id`, auth, canEditProducts, async (req, res) => {
    try {
      const [rows] = await db.query(
        `${PRODUCT_SELECT} WHERE p.id = ? AND p.is_manufactured = 1 AND p.is_by_product = ?`, [req.params.id, isBy]
      );
      if (!rows.length) throw fail(404, `The ${noun} no longer exists.`);
      const usage = productUsage(rows[0]);
      if (usage) throw fail(409, usage, { code: 'PRODUCT_IN_USE' });
      await db.query('DELETE FROM products WHERE id=?', [rows[0].id]);
      await logAudit(req, 'DELETE', 'manufacturing/products', rows[0].id, `Deleted ${noun} "${rows[0].name} — ${rows[0].pack_size}"`);
      res.json({ message: 'Deleted.' });
    } catch (err) {
      if (err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ message: 'The record is in use and cannot be deleted.' });
      sendError(res, err, `The ${noun} could not be deleted. Try again.`);
    }
  });
}

productRoutes('/products', 'product');
productRoutes('/by-products', 'by_product');

// ── Batches ────────────────────────────────────────────────────────────────
const batchPrefix = (date) => {
  const [y, m, d] = date.split('-');
  return `B-${y.slice(-2)}${m}${d}`;
};

/** Next free code for the batch date, B-YYMMDD-NN. `lock` holds the range so two
 *  creates on the same date cannot take the same number. */
async function nextBatchCode(conn, date, { lock } = {}) {
  const prefix = batchPrefix(date);
  const [rows] = await conn.query(
    `SELECT batch_code FROM mfg_batches WHERE batch_code LIKE ?
      ORDER BY LENGTH(batch_code) DESC, batch_code DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [`${prefix}-%`]
  );
  const last = rows.length ? parseInt(rows[0].batch_code.split('-')[2], 10) || 0 : 0;
  return `${prefix}-${String(last + 1).padStart(2, '0')}`;
}

async function nextYieldCode(conn) {
  const [rows] = await conn.query('SELECT yield_code FROM mfg_yields ORDER BY id DESC LIMIT 1 FOR UPDATE');
  const last = rows.length ? parseInt(rows[0].yield_code.split('-')[1], 10) || 0 : 0;
  return `YLD-${String(last + 1).padStart(5, '0')}`;
}

router.get('/batches/next-code', auth, canRead, async (req, res) => {
  try {
    const date = isDate(req.query.date) ? req.query.date : todayPKT();
    res.json({ batch_code: await nextBatchCode(db, date) });
  } catch (err) { sendError(res, err, 'The batch code could not be generated.'); }
});

const stepError = (step, field, message, line) => fail(400, message, { step, field, line });

/** A by-product's batch number when the form leaves it to the system: the
 *  batch code plus "-BP", so it never equals the batch code of the packs. */
const byProductBatchNo = (batchNo, batchCode) => batchNo || `${batchCode}-BP`;

/**
 * Validate a batch request and cost it. Used by create
 * (raw-material rows locked FOR UPDATE, in id order). Errors carry the wizard
 * `step` they belong to, checked in step order so the first error is the
 * earliest step that needs attention.
 */
async function planBatch(conn, body, { lock }) {
  // ── Step 1: product and total output ──
  const productName = cleanText(body.product_name);
  if (!productName) throw stepError('batch', 'product', 'Choose the product.');
  const categoryId = body.category_id === '' || body.category_id === undefined || body.category_id === null
    ? null : Number(body.category_id);
  const [group] = await conn.query(
    `SELECT p.id, p.name, p.pack_size, p.volume, p.volume_uom_id, p.sale_rate, p.category_id,
            pc.name AS category_name, u.symbol AS uom_symbol, u.base_type, u.to_base_factor
       FROM products p
       LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE p.is_manufactured = 1 AND p.is_by_product = 0
        AND ${normSql('p.name')} = ? AND p.category_id <=> ?`,
    [normKey(productName), categoryId]
  );
  if (!group.length) throw stepError('batch', 'product', 'Choose a manufactured product from the list.');
  const displayName = group[0].name;

  const outputQty = num(body.output_qty);
  if (!(outputQty > 0)) throw stepError('batch', 'output_qty', 'Enter the total output.');
  if (!decimalsOk(outputQty, 4) || outputQty > 99999999) throw stepError('batch', 'output_qty', 'Enter the total output with at most 4 decimals.');
  const outUom = await getUom(conn, body.output_uom_id);
  if (!outUom) throw stepError('batch', 'output_uom_id', 'Choose the unit of the total output.');
  if (outUom.base_type === 'count' && !Number.isInteger(outputQty)) throw stepError('batch', 'output_qty', `Enter a whole number of ${outUom.symbol} for the total output.`);
  const outFactor = parseFloat(outUom.to_base_factor);
  const outputBase = outputQty * outFactor;

  // Every raw and packaging material the request names, read (and locked) once.
  const materialsIn = Array.isArray(body.materials) ? body.materials : [];
  const packsIn = Array.isArray(body.packs) ? body.packs : [];
  const byIn = Array.isArray(body.by_products) ? body.by_products : [];
  const rmIds = [...new Set([
    ...materialsIn.map(m => Number(m.raw_material_id)),
    ...packsIn.flatMap(p => (Array.isArray(p.packaging) ? p.packaging : []).map(x => Number(x.raw_material_id))),
  ].filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const rmById = new Map();
  if (rmIds.length) {
    const [rmRows] = await conn.query(
      `SELECT rm.id, rm.name, rm.material_type, rm.stock_qty, rm.cost_per_unit, rm.uom_id, u.symbol AS uom_symbol, u.base_type
         FROM raw_materials rm LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
        WHERE rm.id IN (?) ORDER BY rm.id${lock ? ' FOR UPDATE' : ''}`,
      [rmIds]
    );
    rmRows.forEach(r => rmById.set(r.id, r));
  }
  const usedQty = new Map();   // raw_material_id -> qty this batch takes
  const take = (id, qty) => usedQty.set(id, (usedQty.get(id) || 0) + qty);
  const stockError = (rm, step, line) => stepError(step, 'qty',
    `Only ${fmtQty(rm.stock_qty, rm.uom_symbol)} of ${rm.name} is in stock.`, line);
  const checkQty = (rm, qty, step, line) => {
    if (!(qty > 0)) throw stepError(step, 'qty', `Enter a quantity greater than 0 for ${rm.name}.`, line);
    if (rm.base_type === 'count' && !Number.isInteger(qty)) throw stepError(step, 'qty', `Enter a whole number of ${rm.uom_symbol} for ${rm.name}.`, line);
    if (!decimalsOk(qty, 4)) throw stepError(step, 'qty', `Enter the quantity of ${rm.name} with at most 4 decimals.`, line);
  };

  // ── Step 2: raw materials (costed at the average rate read above) ──
  if (!materialsIn.length) throw stepError('materials', 'materials', 'Add at least one raw material.');
  const seenRaw = new Set();
  const materials = materialsIn.map((m, i) => {
    const rm = rmById.get(Number(m.raw_material_id));
    if (!rm || rm.material_type !== 'raw_material') throw stepError('materials', 'raw_material_id', 'Choose a raw material on every line.', i);
    if (seenRaw.has(rm.id)) throw stepError('materials', 'raw_material_id', `${rm.name} is listed twice. Combine the quantities on one line.`, i);
    seenRaw.add(rm.id);
    const qty = num(m.qty);
    checkQty(rm, qty, 'materials', i);
    take(rm.id, qty);
    if (usedQty.get(rm.id) > parseFloat(rm.stock_qty) + 1e-9) throw stockError(rm, 'materials', i);
    return { rm, qty, rate: parseFloat(rm.cost_per_unit) || 0 };
  });

  // ── Step 3: packs ──
  if (!packsIn.length) throw stepError('packs', 'packs', 'Add at least one pack size.');
  const groupById = new Map(group.map(p => [p.id, p]));
  const seenPack = new Set();
  const packs = packsIn.map((p, i) => {
    const prod = groupById.get(Number(p.product_id));
    if (!prod) throw stepError('packs', 'product_id', `Choose a pack size of ${displayName} on every row.`, i);
    if (seenPack.has(prod.id)) throw stepError('packs', 'product_id', `${prod.pack_size} is listed twice. Combine the units on one row.`, i);
    seenPack.add(prod.id);
    if (!(parseFloat(prod.volume) > 0) || !(parseFloat(prod.to_base_factor) > 0)) {
      throw stepError('packs', 'product_id', `${prod.name} — ${prod.pack_size} has no volume. Set its volume on the Manufactured Products screen.`, i);
    }
    if (prod.base_type !== outUom.base_type) {
      throw stepError('packs', 'product_id', `${prod.pack_size} is measured in ${prod.uom_symbol}, which cannot be converted to ${outUom.symbol}.`, i);
    }
    const units = num(p.units);
    if (!Number.isInteger(units) || units <= 0) throw stepError('packs', 'units', `Enter a whole number of units for ${prod.pack_size}.`, i);
    if (units > 10000000) throw stepError('packs', 'units', `Enter fewer units for ${prod.pack_size}.`, i);

    const packagingIn = Array.isArray(p.packaging) ? p.packaging : [];
    if (!packagingIn.length) throw stepError('packs', 'packaging', `Add the packaging for ${prod.pack_size}.`, i);
    const seenPkg = new Set();
    const packaging = packagingIn.map(x => {
      const rm = rmById.get(Number(x.raw_material_id));
      if (!rm || rm.material_type !== 'packaging_material') throw stepError('packs', 'packaging', `Choose a packaging material on every line of ${prod.pack_size}.`, i);
      if (seenPkg.has(rm.id)) throw stepError('packs', 'packaging', `${rm.name} is listed twice for ${prod.pack_size}.`, i);
      seenPkg.add(rm.id);
      const qty = num(x.qty);
      checkQty(rm, qty, 'packs', i);
      take(rm.id, qty);
      if (usedQty.get(rm.id) > parseFloat(rm.stock_qty) + 1e-9) throw stockError(rm, 'packs', i);
      return { rm, qty, rate: parseFloat(rm.cost_per_unit) || 0 };
    });
    const packedBase = units * parseFloat(prod.volume) * parseFloat(prod.to_base_factor);
    return { prod, units, packedBase, packaging };
  });
  const packedBase = packs.reduce((s, p) => s + p.packedBase, 0);
  const inOutputUnit = (base) => round4(base / outFactor);
  if (packedBase > outputBase * (1 + 1e-9) + 1e-6) {
    throw stepError('packs', 'units',
      `The packs hold ${fmtQty(inOutputUnit(packedBase), outUom.symbol)}, more than the total output of ${fmtQty(outputQty, outUom.symbol)}. Reduce the units.`);
  }

  // ── Step 6 (read early: by-product expiry is checked against it) ──
  const batchDate = body.batch_date;
  const expiryDate = body.expiry_date;

  // ── Step 4: by-products ──
  const byIds = [...new Set(byIn.map(b => Number(b.product_id)).filter(id => Number.isInteger(id) && id > 0))];
  const byById = new Map();
  if (byIds.length) {
    const [byRows] = await conn.query(
      `SELECT p.id, p.name, p.pack_size, p.volume, u.symbol AS uom_symbol, p.purchase_rate, p.sale_rate, p.is_by_product
         FROM products p LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
        WHERE p.id IN (?) AND p.is_by_product = 1`, [byIds]
    );
    byRows.forEach(r => byById.set(r.id, r));
  }
  const seenBy = new Set();
  const byProducts = byIn.map((b, i) => {
    const prod = byById.get(Number(b.product_id));
    if (!prod) throw stepError('byproducts', 'product_id', 'Choose a by-product on every row.', i);
    if (seenBy.has(prod.id)) throw stepError('byproducts', 'product_id', `${prod.name} is listed twice. Combine the quantities on one row.`, i);
    seenBy.add(prod.id);
    const qty = num(b.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw stepError('byproducts', 'qty', `Enter a whole-number quantity for ${prod.name}.`, i);
    if (qty > 10000000) throw stepError('byproducts', 'qty', `Enter a smaller quantity for ${prod.name}.`, i);
    const followsCode = b.batch_no === null || b.batch_no === undefined || b.use_batch_code === true;
    const batchNo = followsCode ? null : cleanText(b.batch_no);
    if (!followsCode && !batchNo) throw stepError('byproducts', 'batch_no', `Enter the batch number for ${prod.name}.`, i);
    if (batchNo && batchNo.length > 100) throw stepError('byproducts', 'batch_no', `The batch number for ${prod.name} must have 100 characters or fewer.`, i);
    if (!isDate(b.exp_date)) throw stepError('byproducts', 'exp_date', `Enter the expiry date for ${prod.name}.`, i);
    if (isDate(batchDate) && b.exp_date <= batchDate) {
      throw stepError('byproducts', 'exp_date', `The expiry date of ${prod.name} must be after the batch date.`, i);
    }
    // Purchase rate (its value inside the batch, deducted from the packs' cost)
    // and sale rate (what inventory sells it at) are set per batch. Left blank,
    // each falls back to the by-product's own rate.
    const rate = blankValue(b.purchase_rate) ? (parseFloat(prod.purchase_rate) || 0) : num(b.purchase_rate);
    if (!Number.isFinite(rate) || rate < 0) throw stepError('byproducts', 'purchase_rate', `Enter a purchase rate of 0 or more for ${prod.name}.`, i);
    if (rate > MAX_MONEY || !decimalsOk(rate, 4)) throw stepError('byproducts', 'purchase_rate', `Enter the purchase rate of ${prod.name} with at most 4 decimals.`, i);
    const saleRate = blankValue(b.sale_rate) ? (parseFloat(prod.sale_rate) || 0) : num(b.sale_rate);
    if (!Number.isFinite(saleRate) || saleRate <= 0) throw stepError('byproducts', 'sale_rate', `Enter a sale rate greater than 0 for ${prod.name}.`, i);
    if (saleRate > MAX_MONEY || !decimalsOk(saleRate, 2)) throw stepError('byproducts', 'sale_rate', `Enter the sale rate of ${prod.name} with at most 2 decimals.`, i);
    return { prod, qty, rate, saleRate: round2(saleRate), batchNo, expDate: b.exp_date };
  });

  // ── Step 5: misc expense ──
  const miscExpense = body.misc_expense === '' || body.misc_expense === undefined || body.misc_expense === null
    ? 0 : num(body.misc_expense);
  if (!Number.isFinite(miscExpense) || miscExpense < 0) throw stepError('costs', 'misc_expense', 'Enter a miscellaneous expense of 0 or more.');
  if (miscExpense > MAX_MONEY || !decimalsOk(miscExpense, 2)) throw stepError('costs', 'misc_expense', 'Enter the expense with at most 2 decimals.');
  const miscNote = cleanText(body.misc_note) || null;
  if (miscNote && miscNote.length > 200) throw stepError('costs', 'misc_note', 'The note must have 200 characters or fewer.');

  // ── Step 6: batch details ──
  const today = todayPKT();
  if (!isDate(batchDate)) throw stepError('batch', 'batch_date', 'Enter the batch date.');
  if (batchDate > today) throw stepError('batch', 'batch_date', 'The batch date cannot be in the future.');
  if (!isDate(expiryDate)) throw stepError('batch', 'expiry_date', 'Enter the expiry date.');
  if (expiryDate <= batchDate) throw stepError('batch', 'expiry_date', 'The expiry date must be after the batch date.');

  // ── Costing ──
  const costing = computeBatchCosting({
    materials: materials.map(m => ({ qty: m.qty, rate: m.rate })),
    miscExpense,
    packs: packs.map(p => ({ units: p.units, packedBase: p.packedBase, packaging: p.packaging.map(x => ({ qty: x.qty, rate: x.rate })) })),
    byProducts: byProducts.map(b => ({ qty: b.qty, rate: b.rate })),
  });
  if (costing.sharedCost < 0) {
    throw stepError('byproducts', 'qty',
      `The by-products are valued at ${fmtPKR(costing.byProductValue)}, more than the raw materials and expense of ${fmtPKR(costing.rawCost + costing.miscExpense)}. Lower a quantity or the by-product's purchase rate.`);
  }
  if (costing.totalCost > MAX_MONEY) throw stepError('materials', 'qty', 'The batch cost is too large to record.');

  return {
    productName: displayName,
    categoryId,
    categoryName: group[0].category_name || null,
    outputQty,
    outUom,
    packedVolume: inOutputUnit(packedBase),
    lossVolume: Math.max(0, round4(outputQty - inOutputUnit(packedBase))),
    materials,
    packs,
    byProducts,
    miscExpense,
    miscNote,
    batchDate,
    expiryDate,
    costing,
  };
}

/** Batch numbers a by-product may not use: the batch code itself, one already
 *  in inventory for that product, or one held by another batch still waiting
 *  to be sent. */
async function assertByProductBatchNumbers(conn, byProducts, batchCode, excludeBatchId) {
  for (let i = 0; i < byProducts.length; i += 1) {
    const b = byProducts[i];
    const batchNo = byProductBatchNo(b.batchNo, batchCode);
    if (normKey(batchNo) === normKey(batchCode)) {
      throw stepError('byproducts', 'batch_no', `The batch number of ${b.prod.name} must differ from the batch code ${batchCode}.`, i);
    }
    const [inv] = await conn.query('SELECT id FROM inventory WHERE product_id=? AND batch_no=? LIMIT 1', [b.prod.id, batchNo]);
    if (inv.length) {
      throw stepError('byproducts', 'batch_no', `Batch number ${batchNo} already exists in inventory for ${b.prod.name}. Enter a different batch number.`, i);
    }
    const [held] = await conn.query(
      `SELECT mb.batch_code FROM mfg_batch_byproducts bb JOIN mfg_batches mb ON mb.id = bb.batch_id
        WHERE mb.status = 'ready' AND bb.product_id = ? AND bb.batch_no = ? AND mb.id <> ? LIMIT 1`,
      [b.prod.id, batchNo, excludeBatchId || 0]
    );
    if (held.length) {
      throw stepError('byproducts', 'batch_no', `Batch number ${batchNo} is already used for ${b.prod.name} by batch ${held[0].batch_code}. Enter a different batch number.`, i);
    }
  }
}

/** The one shape the client renders for the preview step and for a saved batch. */
function planView(plan, batchCode) {
  const c = plan.costing;
  return {
    batch_code: batchCode,
    status: 'draft',
    product_name: plan.productName,
    category_id: plan.categoryId,
    category_name: plan.categoryName,
    batch_date: plan.batchDate,
    expiry_date: plan.expiryDate,
    total_volume: plan.outputQty,
    vol_uom_symbol: plan.outUom.symbol,
    packed_volume: plan.packedVolume,
    loss_volume: plan.lossVolume,
    raw_material_cost: c.rawCost,
    packaging_cost: c.packagingCost,
    misc_expense: c.miscExpense,
    misc_note: plan.miscNote,
    byproduct_value: c.byProductValue,
    shared_cost: c.sharedCost,
    total_cost: c.totalCost,
    materials: plan.materials.map((m, i) => ({
      raw_material_id: m.rm.id, rm_name: m.rm.name, uom_symbol: m.rm.uom_symbol,
      qty: m.qty, unit_cost: m.rate, total_cost: c.materials[i].total,
    })),
    packs: plan.packs.map((p, i) => ({
      product_id: p.prod.id,
      product_name: p.prod.name,
      pack_size: p.prod.pack_size,
      sale_rate: parseFloat(p.prod.sale_rate) || 0,
      units: p.units,
      packed_volume: round4(p.packedBase / parseFloat(plan.outUom.to_base_factor)),
      shared_cost: c.packs[i].sharedCost,
      packaging_cost: c.packs[i].packagingCost,
      total_cost: c.packs[i].totalCost,
      cost_per_unit: c.packs[i].costPerUnit,
      packaging: p.packaging.map((x, j) => ({
        raw_material_id: x.rm.id, rm_name: x.rm.name, uom_symbol: x.rm.uom_symbol,
        qty: x.qty, unit_cost: x.rate, total_cost: c.packs[i].packaging[j].total,
      })),
    })),
    byproducts: plan.byProducts.map((b, i) => ({
      product_id: b.prod.id,
      product_name: b.prod.name,
      pack_size: b.prod.pack_size,
      volume: parseFloat(b.prod.volume) || 1,
      uom_symbol: b.prod.uom_symbol,
      qty: b.qty,
      unit_cost: c.byProducts[i].costPerUnit,
      total_cost: c.byProducts[i].total,
      sale_rate: b.saleRate,
      batch_no: byProductBatchNo(b.batchNo, batchCode),
      exp_date: b.expDate,
    })),
  };
}

const BATCH_SELECT = `
  SELECT b.id, b.batch_code, b.product_name, b.category_id, pc.name AS category_name,
         b.batch_date, b.expiry_date, b.total_volume, b.volume_uom_id, u.symbol AS vol_uom_symbol,
         b.packed_volume, b.loss_volume, b.raw_material_cost, b.packaging_cost, b.misc_expense,
         b.byproduct_value, b.shared_cost, b.total_cost, b.status, b.created_at, b.sent_at,
         b.misc_note, b.draft_json, b.updated_at,
         cu.full_name AS created_by_name, su.full_name AS sent_by_name,
         (SELECT COUNT(*) FROM mfg_batch_packs bp WHERE bp.batch_id = b.id) AS pack_count,
         (SELECT COALESCE(SUM(bp.units), 0) FROM mfg_batch_packs bp WHERE bp.batch_id = b.id) AS pack_units,
         (SELECT COUNT(*) FROM mfg_batch_byproducts bb WHERE bb.batch_id = b.id) AS byproduct_count
    FROM mfg_batches b
    LEFT JOIN product_categories pc ON pc.id = b.category_id
    LEFT JOIN units_of_measurement u ON u.id = b.volume_uom_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users su ON su.id = b.sent_by`;

// A draft keeps the whole form as JSON; the list derives its figures from it.
function draftOf(b) {
  if (b.status !== 'draft' || !b.draft_json) return null;
  return typeof b.draft_json === 'string' ? JSON.parse(b.draft_json) : b.draft_json;
}

function shapeBatch(b) {
  const draft = draftOf(b);
  const { draft_json: _json, ...rest } = b;
  return {
    ...rest,
    draft,
    updated_at: b.updated_at ? nowPKT(b.updated_at) : null,
    batch_date: dateOnly(b.batch_date),
    expiry_date: dateOnly(b.expiry_date),
    // PKT 'YYYY-MM-DD HH:mm:ss' strings: a Date would serialise as UTC and
    // show the previous day for anything recorded after 7 pm.
    created_at: b.created_at ? nowPKT(b.created_at) : null,
    sent_at: b.sent_at ? nowPKT(b.sent_at) : null,
    pack_count: Number(b.pack_count),
    pack_units: draft
      ? (Array.isArray(draft.packs) ? draft.packs.reduce((t, p) => t + (Number.isInteger(Number(p.units)) ? Number(p.units) : 0), 0) : 0)
      : Number(b.pack_units),
    byproduct_count: Number(b.byproduct_count),
  };
}

/** Packs (with packaging) and by-products for the given batch ids. */
async function loadBatchItems(conn, batchIds) {
  const out = new Map(batchIds.map(id => [id, { materials: [], packs: [], byproducts: [] }]));
  if (!batchIds.length) return out;
  const [materials] = await conn.query(
    `SELECT bm.batch_id, bm.raw_material_id, rm.name AS rm_name, u.symbol AS uom_symbol,
            bm.qty, bm.unit_cost, bm.total_cost
       FROM mfg_batch_materials bm
       JOIN raw_materials rm ON rm.id = bm.raw_material_id
       LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
      WHERE bm.batch_id IN (?) ORDER BY bm.id`, [batchIds]
  );
  const [packs] = await conn.query(
    `SELECT bp.id, bp.batch_id, bp.product_id, p.name AS product_name, p.pack_size, p.sale_rate,
            bp.units, bp.pack_volume, pu.symbol AS pack_uom_symbol, bp.packed_volume_base,
            bp.shared_cost, bp.packaging_cost, bp.total_cost, bp.cost_per_unit,
            bu.to_base_factor AS out_factor
       FROM mfg_batch_packs bp
       JOIN products p ON p.id = bp.product_id
       JOIN mfg_batches b ON b.id = bp.batch_id
       LEFT JOIN units_of_measurement pu ON pu.id = bp.pack_volume_uom_id
       LEFT JOIN units_of_measurement bu ON bu.id = b.volume_uom_id
      WHERE bp.batch_id IN (?) ORDER BY bp.id`, [batchIds]
  );
  const packIds = packs.map(p => p.id);
  const pkgByPack = new Map(packIds.map(id => [id, []]));
  if (packIds.length) {
    const [pkg] = await conn.query(
      `SELECT pm.pack_id, pm.raw_material_id, rm.name AS rm_name, u.symbol AS uom_symbol,
              pm.qty, pm.unit_cost, pm.total_cost
         FROM mfg_batch_pack_materials pm
         JOIN raw_materials rm ON rm.id = pm.raw_material_id
         LEFT JOIN units_of_measurement u ON u.id = rm.uom_id
        WHERE pm.pack_id IN (?) ORDER BY pm.id`, [packIds]
    );
    pkg.forEach(x => pkgByPack.get(x.pack_id).push(x));
  }
  const [byproducts] = await conn.query(
    `SELECT bb.batch_id, bb.product_id, p.name AS product_name, p.pack_size, p.volume, u.symbol AS uom_symbol,
            bb.qty, bb.unit_cost, bb.total_cost, COALESCE(bb.sale_rate, p.sale_rate) AS sale_rate,
            bb.batch_no, bb.exp_date
       FROM mfg_batch_byproducts bb JOIN products p ON p.id = bb.product_id
       LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
      WHERE bb.batch_id IN (?) ORDER BY bb.id`, [batchIds]
  );
  materials.forEach(m => out.get(m.batch_id).materials.push(m));
  packs.forEach(p => out.get(p.batch_id).packs.push({
    ...p,
    packed_volume: parseFloat(p.out_factor) > 0 ? round4(parseFloat(p.packed_volume_base) / parseFloat(p.out_factor)) : null,
    packaging: pkgByPack.get(p.id),
  }));
  byproducts.forEach(b => out.get(b.batch_id).byproducts.push({ ...b, exp_date: dateOnly(b.exp_date) }));
  return out;
}

router.get('/batches', auth, canRead, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let sql = BATCH_SELECT;
    if (['draft', 'ready', 'in_inventory'].includes(status)) { sql += ' WHERE b.status = ?'; params.push(status); }
    sql += ' ORDER BY b.created_at DESC, b.id DESC';
    const [rows] = await db.query(sql, params);
    const batches = rows.map(shapeBatch);
    if (req.query.include_items === '1' && batches.length) {
      const items = await loadBatchItems(db, batches.map(b => b.id));
      batches.forEach(b => Object.assign(b, items.get(b.id)));
    }
    res.json(batches);
  } catch (err) { sendError(res, err, 'The batches could not be loaded.'); }
});

router.get('/batches/:id', auth, canRead, async (req, res) => {
  try {
    const [rows] = await db.query(`${BATCH_SELECT} WHERE b.id = ?`, [req.params.id]);
    if (!rows.length) throw fail(404, 'The batch no longer exists.');
    const batch = shapeBatch(rows[0]);
    const items = await loadBatchItems(db, [batch.id]);
    res.json({ ...batch, ...items.get(batch.id) });
  } catch (err) { sendError(res, err, 'The batch could not be loaded.'); }
});

// ── Drafts ─────────────────────────────────────────────────────────────────
// A draft is a saved, unfinished batch form: only the product is required and
// stock is never touched. It lives on the batch row (status 'draft', no batch
// code) with the form kept as JSON; Create batch turns the same row into a
// real batch, so its id and links survive.
const MAX_DRAFT_BYTES = 200000;

async function draftColumns(conn, body) {
  const productName = cleanText(body.product_name);
  if (!productName) throw fail(400, 'Choose the product.', { step: 'batch', field: 'product' });
  const categoryId = body.category_id === '' || body.category_id == null ? null : Number(body.category_id);
  const [group] = await conn.query(
    `SELECT name FROM products WHERE is_manufactured = 1 AND is_by_product = 0
       AND ${normSql('name')} = ? AND category_id <=> ? LIMIT 1`, [normKey(productName), categoryId]
  );
  if (!group.length) throw fail(400, 'Choose a manufactured product from the list.', { step: 'batch', field: 'product' });
  const json = JSON.stringify(body);
  if (json.length > MAX_DRAFT_BYTES) throw fail(400, 'The draft is too large to save.');
  const uom = await getUom(conn, body.output_uom_id);
  const output = num(body.output_qty);
  const misc = num(body.misc_expense);
  return {
    product_name: group[0].name,
    category_id: categoryId,
    batch_date: isDate(body.batch_date) ? body.batch_date : null,
    expiry_date: isDate(body.expiry_date) ? body.expiry_date : null,
    total_volume: output > 0 && output < 99999999 ? round4(output) : null,
    volume_uom_id: uom ? uom.id : null,
    misc_expense: misc >= 0 && misc <= MAX_MONEY ? round2(misc) : 0,
    misc_note: (cleanText(body.misc_note) || '').slice(0, 200) || null,
    draft_json: json,
  };
}

router.post('/batches/drafts', auth, canEditBatches, async (req, res) => {
  try {
    const d = await draftColumns(db, req.body || {});
    const [result] = await db.query(
      `INSERT INTO mfg_batches (batch_code, product_name, category_id, batch_date, expiry_date, total_volume, volume_uom_id,
         misc_expense, misc_note, draft_json, status, created_by)
       VALUES (NULL,?,?,?,?,?,?,?,?,?,'draft',?)`,
      [d.product_name, d.category_id, d.batch_date, d.expiry_date, d.total_volume, d.volume_uom_id,
       d.misc_expense, d.misc_note, d.draft_json, req.user?.id || null]
    );
    await logAudit(req, 'CREATE', 'manufacturing/batches', result.insertId, `Saved a draft batch for ${d.product_name}`);
    res.status(201).json({ id: result.insertId, status: 'draft' });
  } catch (err) { sendError(res, err, 'The draft could not be saved. Try again.'); }
});

router.put('/batches/drafts/:id', auth, canEditBatches, async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT id, status FROM mfg_batches WHERE id = ?', [req.params.id]);
    if (!row) throw fail(404, 'The draft no longer exists.');
    if (row.status !== 'draft') throw fail(409, 'This batch has already been created and can no longer be edited.');
    const d = await draftColumns(db, req.body || {});
    await db.query(
      `UPDATE mfg_batches SET product_name=?, category_id=?, batch_date=?, expiry_date=?, total_volume=?, volume_uom_id=?,
         misc_expense=?, misc_note=?, draft_json=? WHERE id = ? AND status = 'draft'`,
      [d.product_name, d.category_id, d.batch_date, d.expiry_date, d.total_volume, d.volume_uom_id,
       d.misc_expense, d.misc_note, d.draft_json, row.id]
    );
    await logAudit(req, 'UPDATE', 'manufacturing/batches', row.id, `Updated the draft batch for ${d.product_name}`);
    res.json({ id: row.id, status: 'draft' });
  } catch (err) { sendError(res, err, 'The draft could not be saved. Try again.'); }
});

// Create batch. With draft_id, the draft row becomes the batch (same id).
router.post('/batches', auth, canEditBatches, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const draftId = req.body.draft_id ? Number(req.body.draft_id) : null;
    if (draftId) {
      const [[draft]] = await conn.query('SELECT id, status FROM mfg_batches WHERE id = ? FOR UPDATE', [draftId]);
      if (!draft) throw fail(404, 'The draft no longer exists.');
      if (draft.status !== 'draft') throw fail(409, 'This batch has already been created.');
    }
    const plan = await planBatch(conn, req.body, { lock: true });
    const batchCode = await nextBatchCode(conn, plan.batchDate, { lock: true });
    await assertByProductBatchNumbers(conn, plan.byProducts, batchCode, draftId);
    const view = planView(plan, batchCode);
    const c = plan.costing;
    const packedBaseTotal = plan.packs.reduce((s, p) => s + p.packedBase, 0);

    const columns = [batchCode, plan.productName, plan.categoryId, plan.batchDate, plan.expiryDate, plan.outputQty, plan.outUom.id,
      plan.packedVolume, plan.lossVolume, c.miscExpense, plan.miscNote, c.rawCost, c.packagingCost, c.byProductValue,
      c.sharedCost, c.totalCost, packedBaseTotal > 0 ? c.sharedCost / packedBaseTotal : 0, req.user?.id || null];
    let batchId = draftId;
    if (draftId) {
      await conn.query(
        `UPDATE mfg_batches SET batch_code=?, product_name=?, category_id=?, batch_date=?, expiry_date=?, total_volume=?,
           volume_uom_id=?, packed_volume=?, loss_volume=?, misc_expense=?, misc_note=?, raw_material_cost=?, packaging_cost=?,
           byproduct_value=?, shared_cost=?, total_cost=?, cost_per_base_unit=?, created_by=?,
           status='ready', draft_json=NULL, created_at=CURRENT_TIMESTAMP
         WHERE id = ?`,
        [...columns, draftId]
      );
    } else {
      const [result] = await conn.query(
        `INSERT INTO mfg_batches
           (batch_code, product_name, category_id, batch_date, expiry_date, total_volume, volume_uom_id,
            packed_volume, loss_volume, misc_expense, misc_note, raw_material_cost, packaging_cost, byproduct_value,
            shared_cost, total_cost, cost_per_base_unit, created_by, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready')`,
        columns
      );
      batchId = result.insertId;
    }

    // Stock out, journalled per material in rm_ledger ('mfg_batch' -> this batch).
    const deduct = async (rm, qty, rate, description) => {
      await conn.query('UPDATE raw_materials SET stock_qty = stock_qty - ? WHERE id = ?', [qty, rm.id]);
      const [[{ stock_qty: balance }]] = await conn.query('SELECT stock_qty FROM raw_materials WHERE id = ?', [rm.id]);
      await conn.query(
        `INSERT INTO rm_ledger (raw_material_id, date, reference_type, reference_id, description, qty_in, qty_out, balance_qty, unit_cost)
         VALUES (?,?,'mfg_batch',?,?,0,?,?,?)`,
        [rm.id, plan.batchDate, batchId, description, qty, balance, rate]
      );
    };

    for (let i = 0; i < plan.materials.length; i += 1) {
      const m = plan.materials[i];
      await conn.query(
        `INSERT INTO mfg_batch_materials (batch_id, raw_material_id, qty, uom_id, unit_cost, total_cost)
         VALUES (?,?,?,?,?,?)`,
        [batchId, m.rm.id, m.qty, m.rm.uom_id, m.rate, c.materials[i].total]
      );
      await deduct(m.rm, m.qty, m.rate, `Used in batch ${batchCode}`);
    }

    for (let i = 0; i < plan.packs.length; i += 1) {
      const p = plan.packs[i];
      const pc = c.packs[i];
      const [packResult] = await conn.query(
        `INSERT INTO mfg_batch_packs
           (batch_id, product_id, units, pack_volume, pack_volume_uom_id, packed_volume_base,
            shared_cost, packaging_cost, total_cost, cost_per_unit)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [batchId, p.prod.id, p.units, p.prod.volume, p.prod.volume_uom_id, round4(p.packedBase),
         pc.sharedCost, pc.packagingCost, pc.totalCost, pc.costPerUnit]
      );
      for (let j = 0; j < p.packaging.length; j += 1) {
        const x = p.packaging[j];
        await conn.query(
          `INSERT INTO mfg_batch_pack_materials (pack_id, raw_material_id, qty, unit_cost, total_cost)
           VALUES (?,?,?,?,?)`,
          [packResult.insertId, x.rm.id, x.qty, x.rate, pc.packaging[j].total]
        );
        await deduct(x.rm, x.qty, x.rate, `Packaging for batch ${batchCode} (${p.prod.pack_size})`);
      }
    }

    for (let i = 0; i < plan.byProducts.length; i += 1) {
      const b = plan.byProducts[i];
      await conn.query(
        `INSERT INTO mfg_batch_byproducts (batch_id, product_id, qty, unit_cost, total_cost, sale_rate, batch_no, exp_date)
         VALUES (?,?,?,?,?,?,?,?)`,
        [batchId, b.prod.id, b.qty, c.byProducts[i].costPerUnit, c.byProducts[i].total, b.saleRate,
         byProductBatchNo(b.batchNo, batchCode), b.expDate]
      );
    }

    await conn.commit();
    await logAudit(req, 'CREATE', 'manufacturing/batches', batchId,
      `Created batch ${batchCode}: ${plan.productName}, ${fmtQty(plan.outputQty, plan.outUom.symbol)}, cost ${fmtPKR(c.totalCost)}`);
    res.status(201).json({ ...view, id: batchId, status: 'ready' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ step: 'details', message: 'Another batch was created at the same moment. Create the batch again.' });
    }
    sendError(res, err, 'The batch could not be created. Try again.');
  } finally { conn.release(); }
});

router.delete('/batches/:id', auth, canEditBatches, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[batch]] = await conn.query('SELECT id, batch_code, product_name, status FROM mfg_batches WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!batch) throw fail(404, 'The batch no longer exists.');
    if (batch.status === 'draft') {
      await conn.query('DELETE FROM mfg_batches WHERE id = ?', [batch.id]);
      await conn.commit();
      await logAudit(req, 'DELETE', 'manufacturing/batches', batch.id, `Deleted the draft batch for ${batch.product_name}`);
      return res.json({ message: 'Draft deleted.' });
    }
    if (batch.status !== 'ready') throw fail(409, `Batch ${batch.batch_code} is in inventory and cannot be deleted.`);

    // Everything the batch took, per material: raw materials and packaging.
    const [used] = await conn.query(
      `SELECT raw_material_id, SUM(qty) AS qty FROM (
         SELECT raw_material_id, qty FROM mfg_batch_materials WHERE batch_id = ?
         UNION ALL
         SELECT pm.raw_material_id, pm.qty FROM mfg_batch_pack_materials pm
           JOIN mfg_batch_packs bp ON bp.id = pm.pack_id WHERE bp.batch_id = ?
       ) t GROUP BY raw_material_id ORDER BY raw_material_id`,
      [batch.id, batch.id]
    );
    if (used.length) {
      await conn.query('SELECT id FROM raw_materials WHERE id IN (?) ORDER BY id FOR UPDATE', [used.map(u => u.raw_material_id)]);
    }
    for (const u of used) {
      await conn.query('UPDATE raw_materials SET stock_qty = stock_qty + ? WHERE id = ?', [u.qty, u.raw_material_id]);
    }
    await conn.query(`DELETE FROM rm_ledger WHERE reference_type = 'mfg_batch' AND reference_id = ?`, [batch.id]);
    await conn.query('DELETE FROM mfg_batches WHERE id = ?', [batch.id]);
    // The stock comes back as if never taken, so the average is rebuilt from
    // the ledger without this batch (later batches keep their frozen costs).
    for (const u of used) {
      const average = await replayAverageRate(conn, u.raw_material_id);
      if (average !== null) await conn.query('UPDATE raw_materials SET cost_per_unit = ? WHERE id = ?', [average, u.raw_material_id]);
    }
    await conn.commit();
    await logAudit(req, 'DELETE', 'manufacturing/batches', batch.id, `Deleted batch ${batch.batch_code}; stock returned`);
    res.json({ message: `Batch ${batch.batch_code} deleted.` });
  } catch (err) {
    await conn.rollback().catch(() => {});
    sendError(res, err, 'The batch could not be deleted. Try again.');
  } finally { conn.release(); }
});

router.post('/batches/:id/send-to-inventory', auth, canSendToInventory, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[batch]] = await conn.query('SELECT * FROM mfg_batches WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!batch) throw fail(404, 'The batch no longer exists.');
    if (batch.status === 'draft') throw fail(409, 'Create the batch before sending it to inventory.');
    if (batch.status !== 'ready') throw fail(409, `Batch ${batch.batch_code} is already in inventory.`);
    const items = (await loadBatchItems(conn, [batch.id])).get(batch.id);
    if (!items.packs.length) throw fail(409, `Batch ${batch.batch_code} has no packs to send.`);

    const expiry = dateOnly(batch.expiry_date);
    const today = todayPKT();
    const lines = [
      ...items.packs.map(p => ({
        kind: 'pack', productId: p.product_id, name: `${p.product_name} — ${p.pack_size}`, qty: p.units,
        batchNo: batch.batch_code, expDate: expiry, rate: parseFloat(p.cost_per_unit), pack: p,
      })),
      ...items.byproducts.map(b => ({
        kind: 'byproduct', productId: b.product_id, name: b.product_name, qty: b.qty,
        batchNo: b.batch_no, expDate: b.exp_date, rate: parseFloat(b.unit_cost), saleRate: parseFloat(b.sale_rate), by: b,
      })),
    ];

    // Inventory rows are never merged: a batch number already on the shelf for the
    // same product would mix two costs and expiries.
    for (const line of lines) {
      const [inv] = await conn.query('SELECT id FROM inventory WHERE product_id = ? AND batch_no = ? FOR UPDATE', [line.productId, line.batchNo]);
      if (inv.length) {
        throw fail(409, `Batch number ${line.batchNo} already exists in inventory for ${line.name}. The batch was not sent.`);
      }
    }

    const yieldCode = await nextYieldCode(conn);
    const [yResult] = await conn.query('INSERT INTO mfg_yields (yield_code, batch_id) VALUES (?, ?)', [yieldCode, batch.id]);

    for (const line of lines) {
      const [[prod]] = await conn.query('SELECT sale_rate, retail_price FROM products WHERE id = ?', [line.productId]);
      // mfg_yield_items is what the Sale & Stock report counts as manufactured stock in.
      if (line.kind === 'pack') {
        const p = line.pack;
        await conn.query(
          `INSERT INTO mfg_yield_items
             (yield_id, product_id, units_manufactured, pack_volume, pack_volume_uom_id, total_volume_used,
              packaging_material_id, packaging_qty, packaging_cost_per_unit, batch_cost_per_unit,
              total_unit_cost, unit_cost_with_tax, added_to_inventory, batch_no, exp_date)
           SELECT ?, bp.product_id, bp.units, bp.pack_volume, bp.pack_volume_uom_id, bp.packed_volume_base,
                  ?, ?, ?, ?, bp.cost_per_unit, bp.cost_per_unit, 1, ?, ?
             FROM mfg_batch_packs bp WHERE bp.id = ?`,
          [yResult.insertId, p.packaging[0]?.raw_material_id || null, p.packaging.length || 1,
           round4(parseFloat(p.packaging_cost) / p.units), parseFloat(p.shared_cost) / p.units,
           line.batchNo, line.expDate, p.id]
        );
      } else {
        const [[uom]] = await conn.query('SELECT volume, volume_uom_id FROM products WHERE id = ?', [line.productId]);
        const packVolume = parseFloat(uom?.volume) > 0 ? parseFloat(uom.volume) : 1;
        await conn.query(
          `INSERT INTO mfg_yield_items
             (yield_id, product_id, units_manufactured, pack_volume, pack_volume_uom_id, total_volume_used,
              packaging_qty, packaging_cost_per_unit, batch_cost_per_unit, total_unit_cost, unit_cost_with_tax,
              added_to_inventory, batch_no, exp_date)
           VALUES (?,?,?,?,?,?,0,0,0,?,?,1,?,?)`,
          [yResult.insertId, line.productId, line.qty, packVolume, uom?.volume_uom_id || null, round4(line.qty * packVolume),
           line.rate, line.rate, line.batchNo, line.expDate]
        );
      }
      await conn.query(
        `INSERT INTO inventory (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date)
         VALUES (?,?,?,?,?,?,?)`,
        // A by-product sells at the rate set on its batch; packs at the product's.
        [line.productId, line.batchNo, line.qty, round4(line.rate),
         line.saleRate > 0 ? line.saleRate : parseFloat(prod?.sale_rate || 0), parseFloat(prod?.retail_price || 0), line.expDate]
      );
      await recordInventoryMovement(conn, {
        productId: line.productId, batchNo: line.batchNo, date: today, refType: 'manufacturing',
        refId: batch.id, qtyIn: line.qty, rateAtMovement: round4(line.rate),
        note: `Manufactured in batch ${batch.batch_code}`,
      });
      // A manufactured product's purchase rate is its latest batch cost.
      if (line.kind === 'pack') {
        await conn.query('UPDATE products SET purchase_rate = ? WHERE id = ?', [round4(line.rate), line.productId]);
      }
    }

    await conn.query(
      `UPDATE mfg_batches SET status = 'in_inventory', sent_at = ?, sent_by = ? WHERE id = ?`,
      [nowPKT(), req.user?.id || null, batch.id]
    );
    await conn.commit();
    const units = items.packs.reduce((s, p) => s + Number(p.units), 0);
    await logAudit(req, 'UPDATE', 'manufacturing/batches', batch.id,
      `Sent batch ${batch.batch_code} to inventory (${yieldCode}): ${fmtNumber(units, 0)} units in ${plural(items.packs.length, 'pack size', 'pack sizes')}`
      + (items.byproducts.length ? `, ${plural(items.byproducts.length, 'by-product', 'by-products')}` : ''));
    res.json({ id: batch.id, batch_code: batch.batch_code, yield_code: yieldCode, status: 'in_inventory' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'This batch was sent to inventory at the same moment by someone else. Refresh the list.' });
    }
    sendError(res, err, 'The batch could not be sent to inventory. Try again.');
  } finally { conn.release(); }
});

// ── Yield: production output record ─────────────────────────────────────────
// One row per item a batch sent to inventory (packs and by-products), read
// from mfg_yield_items, the same rows the Sale & Stock report counts. Value is
// the batch's own cost for that line, so it matches the batch record exactly.
router.get('/yields', auth, canRead, async (req, res) => {
  try {
    const today = todayPKT();
    const from = isDate(req.query.from) ? req.query.from : `${today.slice(0, 8)}01`;
    const to = isDate(req.query.to) ? req.query.to : today;
    if (from > to) throw fail(400, 'The start date must be on or before the end date.', { field: 'from' });
    const where = ['DATE(y.created_at) BETWEEN ? AND ?'];
    const params = [from, to];
    if (req.query.product_id) { where.push('yi.product_id = ?'); params.push(Number(req.query.product_id)); }
    if (req.query.type === 'pack') where.push('p.is_by_product = 0');
    if (req.query.type === 'by_product') where.push('p.is_by_product = 1');
    const q = cleanText(req.query.q);
    if (q) { where.push('b.batch_code LIKE ?'); params.push(`%${q}%`); }
    const [rows] = await db.query(
      `SELECT yi.id, y.created_at AS sent_at, b.id AS batch_id, b.batch_code,
              p.id AS product_id, p.name AS product_name, p.pack_size, p.volume, pu.symbol AS uom_symbol, p.is_by_product,
              yi.batch_no, yi.exp_date, yi.units_manufactured AS qty, yi.total_unit_cost AS cost_per_unit,
              COALESCE(bp.total_cost, bb.total_cost, ROUND(yi.units_manufactured * yi.total_unit_cost, 2)) AS value
         FROM mfg_yield_items yi
         JOIN mfg_yields y ON y.id = yi.yield_id
         JOIN mfg_batches b ON b.id = y.batch_id
         JOIN products p ON p.id = yi.product_id
         LEFT JOIN units_of_measurement pu ON pu.id = p.volume_uom_id
         LEFT JOIN mfg_batch_packs bp ON bp.batch_id = b.id AND bp.product_id = yi.product_id AND p.is_by_product = 0
         LEFT JOIN mfg_batch_byproducts bb ON bb.batch_id = b.id AND bb.product_id = yi.product_id AND p.is_by_product = 1
        WHERE ${where.join(' AND ')}
        ORDER BY y.created_at DESC, b.id DESC, p.is_by_product, yi.id`,
      params
    );
    res.json({
      from,
      to,
      rows: rows.map(r => ({
        ...r,
        sent_at: r.sent_at ? nowPKT(r.sent_at) : null,
        exp_date: dateOnly(r.exp_date),
        is_by_product: Number(r.is_by_product),
        qty: Number(r.qty),
      })),
    });
  } catch (err) { sendError(res, err, 'The production record could not be loaded.'); }
});

module.exports = router;
