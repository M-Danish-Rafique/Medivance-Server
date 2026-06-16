const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// ── Helpers ──────────────────────────────────────────────
async function generateBatchCode(batchDate) {
  const date = batchDate ? new Date(batchDate) : new Date();
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;
  
  // Find the last batch created on this same date
  const [rows] = await db.query(
    "SELECT batch_code FROM mfg_batches WHERE batch_code LIKE ? ORDER BY id DESC LIMIT 1",
    [`B-${datePrefix}-%`]
  );
  
  if (!rows.length) return `B-${datePrefix}-01`;
  const seq = parseInt(rows[0].batch_code.split('-')[2]) + 1;
  return `B-${datePrefix}-${String(seq).padStart(2, '0')}`;
}

async function generateYieldCode() {
  const [rows] = await db.query("SELECT yield_code FROM mfg_yields ORDER BY id DESC LIMIT 1");
  if (!rows.length) return 'YLD-00001';
  const num = parseInt(rows[0].yield_code.split('-')[1]) + 1;
  return `YLD-${String(num).padStart(5, '0')}`;
}

// Convert qty to base unit using UOM factor
function toBase(qty, factor) {
  return parseFloat(qty) * parseFloat(factor || 1);
}

// ── Product Categories ─────────────────────────────────────
router.get('/categories', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM product_categories ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/categories', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Category name required' });
    const [result] = await db.query('INSERT INTO product_categories (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Category already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/categories/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM product_categories WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Batches ────────────────────────────────────────────────
router.get('/batches', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT b.*, pc.name as category_name, u.symbol as vol_uom_symbol, u.name as vol_uom_name,
             (SELECT COUNT(*) FROM mfg_yields y WHERE y.batch_id=b.id) as yield_count
      FROM mfg_batches b
      LEFT JOIN product_categories pc ON b.category_id=pc.id
      LEFT JOIN units_of_measurement u ON b.volume_uom_id=u.id
      ORDER BY b.batch_date DESC, b.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/batches/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT b.*, pc.name as category_name, u.name as vol_uom_name, u.symbol as vol_uom_symbol,
             u.to_base_factor as vol_uom_factor
      FROM mfg_batches b
      LEFT JOIN product_categories pc ON b.category_id=pc.id
      LEFT JOIN units_of_measurement u ON b.volume_uom_id=u.id
      WHERE b.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Batch not found' });

    const [materials] = await db.query(`
      SELECT bm.*, rm.name as rm_name, rm.material_type,
             u.name as uom_name, u.symbol as uom_symbol, u.to_base_factor
      FROM mfg_batch_materials bm
      JOIN raw_materials rm ON bm.raw_material_id=rm.id
      LEFT JOIN units_of_measurement u ON bm.uom_id=u.id
      WHERE bm.batch_id=?`, [req.params.id]);

    res.json({ ...rows[0], materials });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/batches', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { category_id, batch_date, expiry_date, total_volume, volume_uom_id, misc_expense, notes, materials } = req.body;
    if (!batch_date || !expiry_date || !total_volume || !volume_uom_id) {
      return res.status(400).json({ message: 'Batch date, expiry date, volume and UOM are required' });
    }
    if (!materials || !materials.length) return res.status(400).json({ message: 'At least one raw material required' });

    const batch_code = await generateBatchCode(batch_date);

    // Get volume UOM factor to convert to base
    const [uomRows] = await conn.query('SELECT to_base_factor FROM units_of_measurement WHERE id=?', [volume_uom_id]);
    const volFactor = uomRows[0]?.to_base_factor || 1;
    const totalVolumeBase = toBase(total_volume, volFactor); // in base unit (ml or g)

    // Validate RM stock availability BEFORE making any changes
    for (const mat of materials) {
      const [rmRows] = await conn.query('SELECT name, stock_qty, cost_per_unit FROM raw_materials WHERE id=?', [mat.raw_material_id]);
      if (!rmRows.length) return res.status(400).json({ message: `Raw material ID ${mat.raw_material_id} not found` });
      const rm = rmRows[0];
      if (parseFloat(mat.qty) > parseFloat(rm.stock_qty)) {
        return res.status(400).json({
          message: `Insufficient stock for "${rm.name}": required ${parseFloat(mat.qty).toFixed(2)}, available ${parseFloat(rm.stock_qty).toFixed(2)}`
        });
      }
      mat._unit_cost = parseFloat(rm.cost_per_unit || 0);
      mat._total_cost = mat._unit_cost * parseFloat(mat.qty);
    }

    // Sum up raw material cost
    let rawMaterialCost = materials.reduce((s, m) => s + m._total_cost, 0);

    const totalCost = rawMaterialCost + parseFloat(misc_expense || 0);
    const costPerBaseUnit = totalVolumeBase > 0 ? totalCost / totalVolumeBase : 0;

    const [result] = await conn.query(
      `INSERT INTO mfg_batches (batch_code, category_id, batch_date, expiry_date, total_volume, volume_uom_id,
         misc_expense, raw_material_cost, total_cost, cost_per_base_unit, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [batch_code, category_id || null, batch_date, expiry_date, total_volume, volume_uom_id,
       misc_expense || 0, rawMaterialCost, totalCost, costPerBaseUnit, notes || null]
    );
    const batchId = result.insertId;

    // Insert materials + deduct from RM stock
    for (const mat of materials) {
      await conn.query(
        `INSERT INTO mfg_batch_materials (batch_id, raw_material_id, qty, uom_id, unit_cost, total_cost)
         VALUES (?,?,?,?,?,?)`,
        [batchId, mat.raw_material_id, mat.qty, mat.uom_id || null, mat._unit_cost, mat._total_cost]
      );

      // Deduct stock
      await conn.query('UPDATE raw_materials SET stock_qty=stock_qty-? WHERE id=?', [mat.qty, mat.raw_material_id]);

      // RM Ledger
      const [rmStock] = await conn.query('SELECT stock_qty FROM raw_materials WHERE id=?', [mat.raw_material_id]);
      await conn.query(
        `INSERT INTO rm_ledger (raw_material_id, date, reference_type, reference_id, description, qty_in, qty_out, balance_qty, unit_cost)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [mat.raw_material_id, batch_date, 'batch_usage', batchId,
         `Used in batch ${batch_code}`, 0, mat.qty, rmStock[0].stock_qty, mat._unit_cost]
      );
    }

    await conn.commit();
    res.status(201).json({ id: batchId, batch_code, total_cost: totalCost, cost_per_base_unit: costPerBaseUnit });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

router.delete('/batches/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [bRows] = await conn.query('SELECT * FROM mfg_batches WHERE id=?', [req.params.id]);
    if (!bRows.length) return res.status(404).json({ message: 'Not found' });
    if (bRows[0].status === 'yielded') return res.status(400).json({ message: 'Cannot delete batch with yields' });

    const [mats] = await conn.query('SELECT * FROM mfg_batch_materials WHERE batch_id=?', [req.params.id]);
    for (const m of mats) {
      await conn.query('UPDATE raw_materials SET stock_qty=stock_qty+? WHERE id=?', [m.qty, m.raw_material_id]);
      await conn.query('DELETE FROM rm_ledger WHERE reference_type=? AND reference_id=?', ['batch_usage', req.params.id]);
    }
    await conn.query('DELETE FROM mfg_batches WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ message: 'Batch deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── Raw Material Usage History ──────────────────────────────
router.get('/raw-materials/:rm_id/usage-history', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT b.id as batch_id, b.batch_code, b.batch_date, b.status,
             bm.qty as quantity_used
      FROM mfg_batches b
      JOIN mfg_batch_materials bm ON b.id=bm.batch_id
      WHERE bm.raw_material_id=?
      ORDER BY b.batch_date DESC`, [req.params.rm_id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Yields ─────────────────────────────────────────────────
router.get('/yields', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT y.*, b.batch_code, b.total_volume, b.total_cost, b.cost_per_base_unit,
             b.batch_date, b.expiry_date,
             (SELECT COUNT(*) FROM mfg_yield_items yi WHERE yi.yield_id=y.id) as item_count
      FROM mfg_yields y
      JOIN mfg_batches b ON y.batch_id=b.id
      ORDER BY y.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/yields/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT y.*, b.batch_code, b.total_volume, b.total_cost, b.cost_per_base_unit,
             b.expiry_date, bu.symbol as batch_vol_uom
      FROM mfg_yields y
      JOIN mfg_batches b ON y.batch_id=b.id
      LEFT JOIN units_of_measurement bu ON b.volume_uom_id=bu.id
      WHERE y.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });

    const [items] = await db.query(`
      SELECT yi.*, p.name as product_name, p.sale_rate, p.retail_price,
             p.tax_applicable, p.sale_tax_pct,
             pu.name as pack_uom_name, pu.symbol as pack_uom_symbol, pu.to_base_factor as pack_uom_factor,
             rm.name as pkg_material_name
      FROM mfg_yield_items yi
      JOIN products p ON yi.product_id=p.id
      LEFT JOIN units_of_measurement pu ON yi.pack_volume_uom_id=pu.id
      LEFT JOIN raw_materials rm ON yi.packaging_material_id=rm.id
      WHERE yi.yield_id=?`, [req.params.id]);

    items.forEach(item => {
      item.pkg_material_names = item.pkg_material_name || '—';
    });

    res.json({ ...rows[0], items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/yields', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { batch_id, items } = req.body;
    if (!batch_id || !items || !items.length) return res.status(400).json({ message: 'Batch and items required' });

    // Fetch batch
    const [bRows] = await conn.query(`
      SELECT b.*, u.to_base_factor as vol_factor
      FROM mfg_batches b
      LEFT JOIN units_of_measurement u ON b.volume_uom_id=u.id
      WHERE b.id=?`, [batch_id]);
    if (!bRows.length) return res.status(404).json({ message: 'Batch not found' });
    const batch = bRows[0];

    // Validate total packaged volume equals batch volume
    const batchVolumeBase = toBase(batch.total_volume, batch.vol_factor);
    let totalPackagedBase = 0;

    for (const item of items) {
      const [puom] = await conn.query('SELECT to_base_factor FROM units_of_measurement WHERE id=?', [item.pack_volume_uom_id]);
      const packFactor = puom[0]?.to_base_factor || 1;
      const packVolumeBase = toBase(item.pack_volume, packFactor);
      item._pack_volume_base = packVolumeBase;
      item._pack_factor = packFactor;
      totalPackagedBase += packVolumeBase * parseInt(item.units_manufactured);
    }

    // Allow ±1% tolerance for rounding
    const diff = Math.abs(totalPackagedBase - batchVolumeBase);
    if (diff > batchVolumeBase * 0.01 + 1) {
      return res.status(400).json({
        message: `Volume mismatch: batch has ${batchVolumeBase.toFixed(2)} base units, yield uses ${totalPackagedBase.toFixed(2)}. Difference: ${diff.toFixed(2)}`
      });
    }

    // Validate packaging material stock before committing anything
    for (const item of items) {
      const units = parseInt(item.units_manufactured);
      // packaging_material_ids is an array from the UI; use the first one as primary (stored in mfg_yield_items)
      const packagingIds = Array.isArray(item.packaging_material_ids)
        ? item.packaging_material_ids.filter(id => id !== '' && id != null)
        : [];
      for (const pkgId of packagingIds) {
        const [pkgRM] = await conn.query('SELECT name, stock_qty FROM raw_materials WHERE id=?', [pkgId]);
        if (!pkgRM.length) continue;
        if (parseFloat(pkgRM[0].stock_qty) < units) {
          return res.status(400).json({
            message: `Packaging material "${pkgRM[0].name}" has only ${parseFloat(pkgRM[0].stock_qty).toFixed(2)} units available, but ${units} are required.`
          });
        }
      }
    }

    const yield_code = await generateYieldCode();
    const [yResult] = await conn.query('INSERT INTO mfg_yields (yield_code, batch_id) VALUES (?,?)', [yield_code, batch_id]);
    const yieldId = yResult.insertId;

    for (const item of items) {
      const units = parseInt(item.units_manufactured);
      const packVolumeBase = item._pack_volume_base;

      // Batch cost contribution per unit
      const batchCostPerUnit = parseFloat(batch.cost_per_base_unit) * packVolumeBase;

      // Packaging material ids (may be multiple from UI multi-select)
      const packagingIds = Array.isArray(item.packaging_material_ids)
        ? item.packaging_material_ids.filter(id => id !== '' && id != null)
        : [];

      // Sum packaging cost per unit across all selected packaging materials
      let packCostPerUnit = 0;
      if (packagingIds.length) {
        for (const pkgId of packagingIds) {
          const [pkgRM] = await conn.query('SELECT cost_per_unit FROM raw_materials WHERE id=?', [pkgId]);
          packCostPerUnit += parseFloat(pkgRM[0]?.cost_per_unit || 0);
        }
      }

      const totalUnitCost = batchCostPerUnit + packCostPerUnit;

      // Tax
      const [prodRows] = await conn.query('SELECT tax_applicable, sale_tax_pct, sale_rate, retail_price FROM products WHERE id=?', [item.product_id]);
      const prod = prodRows[0];
      const unitCostWithTax = prod?.tax_applicable
        ? totalUnitCost * (1 + parseFloat(prod.sale_tax_pct || 0) / 100)
        : totalUnitCost;

      const saleRate = parseFloat(prod?.sale_rate || 0);

      // Use first packaging material as the primary one stored in mfg_yield_items.packaging_material_id
      const primaryPkgId = packagingIds.length > 0 ? packagingIds[0] : null;

      const [yiResult] = await conn.query(
        `INSERT INTO mfg_yield_items
         (yield_id, product_id, units_manufactured, pack_volume, pack_volume_uom_id,
          total_volume_used, packaging_material_id, packaging_qty, packaging_cost_per_unit,
          batch_cost_per_unit, total_unit_cost, unit_cost_with_tax, batch_no, exp_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [yieldId, item.product_id, units, item.pack_volume, item.pack_volume_uom_id,
         packVolumeBase * units, primaryPkgId, packagingIds.length || 1, packCostPerUnit,
         batchCostPerUnit, totalUnitCost, unitCostWithTax,
         batch.batch_code, batch.expiry_date]
      );

      // Deduct ALL selected packaging materials from stock and record RM ledger
      for (const pkgId of packagingIds) {
        const [pkgRM] = await conn.query('SELECT cost_per_unit FROM raw_materials WHERE id=?', [pkgId]);
        const materialCost = parseFloat(pkgRM[0]?.cost_per_unit || 0);
        const pkgQtyUsed = units;
        await conn.query('UPDATE raw_materials SET stock_qty=stock_qty-? WHERE id=?', [pkgQtyUsed, pkgId]);
        const [pkgStock] = await conn.query('SELECT stock_qty FROM raw_materials WHERE id=?', [pkgId]);
        await conn.query(
          `INSERT INTO rm_ledger (raw_material_id, date, reference_type, reference_id, description, qty_in, qty_out, balance_qty, unit_cost)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [pkgId, batch.batch_date, 'batch_usage', yiResult.insertId,
           `Packaging for yield ${yield_code}`, 0, pkgQtyUsed, pkgStock[0].stock_qty, materialCost]
        );
      }

      // Add to inventory with yield-calculated purchase_rate
      await conn.query(
        `INSERT INTO inventory (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           qty=qty+VALUES(qty),
           purchase_rate=VALUES(purchase_rate),
           sale_rate=VALUES(sale_rate),
           retail_price=VALUES(retail_price),
           exp_date=VALUES(exp_date)`,
        [item.product_id, batch.batch_code, units, unitCostWithTax,
         saleRate, parseFloat(prod?.retail_price || 0), batch.expiry_date]
      );

      // Backfill retail_price on any batch rows that still have 0
      if (parseFloat(prod?.retail_price || 0) > 0) {
        await conn.query(
          `UPDATE inventory SET retail_price=? WHERE product_id=? AND (retail_price IS NULL OR retail_price=0)`,
          [parseFloat(prod.retail_price), item.product_id]
        );
      }

      // Update product purchase_rate to reflect new manufacturing cost
      await conn.query('UPDATE products SET purchase_rate=? WHERE id=?', [unitCostWithTax, item.product_id]);

      // Mark yield item as added to inventory
      await conn.query('UPDATE mfg_yield_items SET added_to_inventory=1 WHERE id=?', [yiResult.insertId]);

      // Profit alert data returned to client — not a server error
      item._unit_cost_with_tax = unitCostWithTax;
      item._sale_rate = saleRate;
      item._profit_pct = saleRate > 0 ? ((saleRate - unitCostWithTax) / saleRate * 100) : 0;
    }

    // Mark batch yielded
    await conn.query("UPDATE mfg_batches SET status='yielded' WHERE id=?", [batch_id]);

    await conn.commit();

    // Collect profit alerts
    const alerts = items
      .filter(i => i._sale_rate > 0 && i._profit_pct < 15)
      .map(i => ({ product_id: i.product_id, profit_pct: i._profit_pct.toFixed(1), cost: i._unit_cost_with_tax, sale_rate: i._sale_rate }));

    res.status(201).json({ id: yieldId, yield_code, profit_alerts: alerts });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;
