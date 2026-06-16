const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// ── Units of Measurement ──────────────────────────────────
router.get('/uom', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM units_of_measurement ORDER BY base_type, name');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/uom', auth, async (req, res) => {
  try {
    const { name, symbol, base_type, to_base_factor } = req.body;
    if (!name || !symbol || !base_type) return res.status(400).json({ message: 'Name, symbol and type required' });
    const [result] = await db.query(
      'INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor) VALUES (?,?,?,?)',
      [name, symbol, base_type, to_base_factor || 1]
    );
    res.status(201).json({ id: result.insertId, name, symbol, base_type, to_base_factor: to_base_factor || 1 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'UOM name already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/uom/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM units_of_measurement WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Raw Materials ──────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { type } = req.query;
    let sql = `
      SELECT rm.*, u.name as uom_name, u.symbol as uom_symbol, u.base_type,
             vu.name as vol_uom_name, vu.symbol as vol_uom_symbol
      FROM raw_materials rm
      LEFT JOIN units_of_measurement u ON rm.uom_id = u.id
      LEFT JOIN units_of_measurement vu ON rm.volume_uom_id = vu.id
    `;
    const params = [];
    if (type) { sql += ' WHERE rm.material_type = ?'; params.push(type); }
    sql += ' ORDER BY rm.material_type, rm.name';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});


router.post('/', auth, async (req, res) => {
  try {
    const { name, material_type, uom_id } = req.body;
    if (!name || !material_type) return res.status(400).json({ message: 'Name and type required' });
    const [result] = await db.query(
      'INSERT INTO raw_materials (name, material_type, uom_id, volume, volume_uom_id) VALUES (?,?,?,?,?)',
      [
        name,
        material_type,
        material_type === 'raw_material' ? (uom_id || null) : null,
        null,
        null,
      ]
    );
    res.status(201).json({ id: result.insertId, name, material_type });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A raw material with this name already exists' });
    res.status(500).json({ message: err.message });
  }
});

// ── RM Purchases ───────────────────────────────────────────
router.get('/purchases/all', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT rp.*, rm.name as rm_name, rm.material_type,
             u.symbol as uom_symbol, s.name as supplier_name
      FROM rm_purchases rp
      JOIN raw_materials rm ON rp.raw_material_id = rm.id
      LEFT JOIN units_of_measurement u ON rm.uom_id = u.id
      LEFT JOIN suppliers s ON rp.supplier_id = s.id
      ORDER BY rp.date DESC, rp.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/purchases', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { raw_material_id, supplier_id, date, invoice_no, qty, amount } = req.body;
    if (!raw_material_id || !date || !qty || !amount) {
      return res.status(400).json({ message: 'Raw material, date, qty and amount required' });
    }
    const unit_cost = parseFloat(amount) / parseFloat(qty);

    // Insert purchase
    const [result] = await conn.query(
      'INSERT INTO rm_purchases (raw_material_id, supplier_id, date, invoice_no, qty, amount, unit_cost) VALUES (?,?,?,?,?,?,?)',
      [raw_material_id, supplier_id || null, date, invoice_no || null, qty, amount, unit_cost]
    );

    // Update RM stock and cost
    await conn.query(
      'UPDATE raw_materials SET stock_qty=stock_qty+?, cost_per_unit=?, updated_at=NOW() WHERE id=?',
      [qty, unit_cost, raw_material_id]
    );

    
// RM Ledger entry
    const [rmRows] = await conn.query('SELECT stock_qty FROM raw_materials WHERE id=?', [raw_material_id]);
    await conn.query(
      `INSERT INTO rm_ledger (raw_material_id, date, reference_type, reference_id, description, qty_in, qty_out, balance_qty, unit_cost)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [raw_material_id, date, 'purchase', result.insertId,
       `Purchase - Invoice: ${invoice_no || 'N/A'}`,
       qty, 0, rmRows[0].stock_qty, unit_cost]
    );

    // If supplier provided, add to supplier ledger
    if (supplier_id) {
      await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?', [amount, supplier_id]);
      const [supRows] = await conn.query('SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
      await conn.query(
        `INSERT INTO supplier_ledger (supplier_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [supplier_id, date, invoice_no || null, 'Raw Material Purchase', amount, 0, supRows[0].balance, 'purchase', result.insertId]
      );
    }

    await conn.commit();
    res.status(201).json({ id: result.insertId, unit_cost });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

router.delete('/purchases/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [rows] = await conn.query('SELECT * FROM rm_purchases WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    const p = rows[0];

    await conn.query('UPDATE raw_materials SET stock_qty=stock_qty-? WHERE id=?', [p.qty, p.raw_material_id]);
    if (p.supplier_id) {
      await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?', [p.amount, p.supplier_id]);
      await conn.query('DELETE FROM supplier_ledger WHERE reference_type=? AND reference_id=?', ['purchase', p.id]);
    }
    await conn.query('DELETE FROM rm_ledger WHERE reference_type=? AND reference_id=?', ['purchase', p.id]);
    await conn.query('DELETE FROM rm_purchases WHERE id=?', [p.id]);

    await conn.commit();
    res.json({ message: 'Deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// RM Usage History — works for both raw_material (batch usage) and packaging_material (yield usage)
router.get('/:id/usage-history', auth, async (req, res) => {
  try {
    const [rmRows] = await db.query('SELECT material_type FROM raw_materials WHERE id=?', [req.params.id]);
    if (!rmRows.length) return res.status(404).json({ message: 'Not found' });
    const materialType = rmRows[0].material_type;

    if (materialType === 'raw_material') {
      // Usage recorded when a batch is created
      const [rows] = await db.query(`
        SELECT b.id as batch_id, b.batch_code, b.batch_date, b.status,
               bm.qty as quantity_used
        FROM mfg_batches b
        JOIN mfg_batch_materials bm ON b.id = bm.batch_id
        WHERE bm.raw_material_id = ?
        ORDER BY b.batch_date DESC, b.id DESC
      `, [req.params.id]);
      res.json(rows);
    } else {
      // Packaging material — usage recorded when used in yielding (stored in mfg_yield_items.packaging_material_id)
      const [rows] = await db.query(`
        SELECT b.id as batch_id, b.batch_code, b.batch_date, b.status,
               yi.units_manufactured as quantity_used,
               y.yield_code, p.name as product_name
        FROM mfg_yield_items yi
        JOIN mfg_yields y ON yi.yield_id = y.id
        JOIN mfg_batches b ON y.batch_id = b.id
        JOIN products p ON yi.product_id = p.id
        WHERE yi.packaging_material_id = ?
        ORDER BY b.batch_date DESC, y.id DESC
      `, [req.params.id]);
      res.json(rows);
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// RM Ledger
router.get('/:id/ledger', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM rm_ledger WHERE raw_material_id=? ORDER BY date ASC, id ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT rm.*, u.name as uom_name, u.symbol as uom_symbol
      FROM raw_materials rm LEFT JOIN units_of_measurement u ON rm.uom_id=u.id
      WHERE rm.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, material_type, uom_id } = req.body;
    await db.query(
      'UPDATE raw_materials SET name=?, material_type=?, uom_id=?, volume=?, volume_uom_id=? WHERE id=?',
      [
        name,
        material_type,
        material_type === 'raw_material' ? (uom_id || null) : null,
        null,
        null,
        req.params.id,
      ]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A raw material with this name already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM raw_materials WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


module.exports = router;
