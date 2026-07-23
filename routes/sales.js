const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { canViewPurchaseRate } = require('../utils/purchaseRateAccess');
const { yearPKT } = require('../utils/dateUtils');

function getFiscalPrefix(dateValue) {
  const year = yearPKT(dateValue || new Date());
  if (Number.isNaN(year)) return 'S' + String(yearPKT()).slice(-2);
  return `S${String(year).slice(-2)}`;
}

async function generateInvoiceNo(dateValue) {
  const prefix = getFiscalPrefix(dateValue);
  const [rows] = await db.query('SELECT invoice_no FROM sales WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1', [`${prefix}-%`]);
  if (rows.length === 0) return `${prefix}-00001`;
  const num = parseInt(rows[0].invoice_no.split('-')[1]) + 1;
  return `${prefix}-${String(num).padStart(5, '0')}`;
}

// List all sales
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, DATE_FORMAT(s.date, '%Y-%m-%d') AS date,
             c.name as customer_name, e.name as salesman_name,
             d.name as delivery_by_name,
             ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM sales s
      JOIN customers c ON s.customer_id=c.id
      LEFT JOIN employees e ON s.salesman_id=e.id
      LEFT JOIN employees d ON s.delivery_by=d.id
      LEFT JOIN cities ci ON c.city_id=ci.id
      LEFT JOIN areas a ON c.area_id=a.id
      LEFT JOIN territories t ON c.territory_id=t.id
      ORDER BY s.date DESC, s.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// Get previous rates for a product sold to a customer
router.get('/history/rates', auth, async (req, res) => {
  try {
    const { product_id, customer_id } = req.query;
    if (!product_id || !customer_id) return res.json({ history: [], purchase_rate: null });
    const [rows] = await db.query(`
      SELECT si.sale_rate, si.discount_pct, s.date, s.invoice_no
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE si.product_id = ? AND s.customer_id = ?
      ORDER BY s.date DESC, s.id DESC
      LIMIT 3
    `, [product_id, customer_id]);
    const [inv] = await db.query(
      'SELECT purchase_rate FROM inventory WHERE product_id=? ORDER BY updated_at DESC LIMIT 1',
      [product_id]
    );
    const [[product]] = await db.query('SELECT show_purchase_rate FROM products WHERE id=?', [product_id]);
    const canView = await canViewPurchaseRate(req, db, product || { show_purchase_rate: 1 });
    res.json({ history: rows, purchase_rate: canView ? inv[0]?.purchase_rate || null : null, purchase_rate_visible: canView });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get single sale with items
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, DATE_FORMAT(s.date, '%Y-%m-%d') AS date,
             c.name as customer_name, c.address as customer_address, c.phone as customer_phone,
             c.license_no, c.license_expiry,
             e.name as salesman_name,
             d.name as delivery_by_name,
             ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM sales s
      JOIN customers c ON s.customer_id=c.id
      LEFT JOIN employees e ON s.salesman_id=e.id
      LEFT JOIN employees d ON s.delivery_by=d.id
      LEFT JOIN cities ci ON c.city_id=ci.id
      LEFT JOIN areas a ON c.area_id=a.id
      LEFT JOIN territories t ON c.territory_id=t.id
      WHERE s.id=?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const [items] = await db.query(`
      SELECT si.*, p.name as product_name, p.pack_size as product_pack_size,
             COALESCE(
               NULLIF((SELECT inv.retail_price FROM inventory inv
                WHERE inv.product_id=si.product_id AND inv.batch_no=si.batch_no LIMIT 1), 0),
               NULLIF(p.retail_price, 0), 0
             ) as retail_price,
             (SELECT inv.exp_date FROM inventory inv
              WHERE inv.product_id=si.product_id AND inv.batch_no=si.batch_no LIMIT 1) as exp_date
      FROM sale_items si
      JOIN products p ON si.product_id=p.id WHERE si.sale_id=?`, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// Create sale
router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { customer_id, salesman_id, delivery_by, date, items } = req.body;
    if (!customer_id || !date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Customer, date and items are required' });
    }

    const invoice_no = await generateInvoiceNo(date);
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);

    const [result] = await conn.query(
      'INSERT INTO sales (invoice_no, customer_id, salesman_id, delivery_by, date, total_amount, net_collectible, pending_amount, is_locked) VALUES (?,?,?,?,?,?,?,?,0)',
      [invoice_no, customer_id, salesman_id || null, delivery_by || null, date, total_amount, total_amount, total_amount]
    );

    const sId = result.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO sale_items
        (sale_id, product_id, batch_no, pack_size, sale_rate, qty, bonus, discount_pct, tax_pct, total)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [sId, item.product_id, item.batch_no, item.pack_size, item.sale_rate,
         item.qty, item.bonus || 0, item.discount_pct || 0, item.tax_pct || 0, item.total]
      );
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await conn.query(
        'UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [totalQty, item.product_id, item.batch_no]
      );
    }

    await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [total_amount, customer_id]);
    const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [customer_id]);
    const newBalance = custRows[0].balance;
    await conn.query(
      'INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [customer_id, date, invoice_no, 'Sale', total_amount, 0, newBalance, 'sale', sId]
    );

    // Tax ledger for taxable products
    for (const item of items) {
      const [prodTax] = await conn.query('SELECT tax_applicable, sale_tax_pct FROM products WHERE id=?', [item.product_id]);
      if (prodTax[0]?.tax_applicable && parseFloat(prodTax[0].sale_tax_pct) > 0) {
        const taxRate = parseFloat(prodTax[0].sale_tax_pct);
        const taxableAmt = parseFloat(item.total);
        const taxAmt = taxableAmt * taxRate / 100;
        await conn.query(
          `INSERT INTO tax_ledger (sale_id, sale_item_id, product_id, sale_date, invoice_no, taxable_amount, tax_rate, tax_amount)
           VALUES (?,?,?,?,?,?,?,?)`,
          [sId, null, item.product_id, date, invoice_no, taxableAmt, taxRate, taxAmt]
        );
      }
    }

    await conn.commit();
    await logAudit(req, 'CREATE', 'sale', sId, `Created invoice ${invoice_no} for customer ${customer_id} — PKR ${total_amount}`);
    res.status(201).json({ id: sId, invoice_no, total_amount });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Update sale (only if not locked)
router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=?', [req.params.id]);
    if (sRows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const sale = sRows[0];
    if (sale.is_locked) return res.status(403).json({ message: 'Invoice is locked after recovery. Cannot edit.' });

    const { customer_id, salesman_id, delivery_by, date, items } = req.body;

    // Restore old inventory
    const [oldItems] = await conn.query('SELECT * FROM sale_items WHERE sale_id=?', [req.params.id]);
    for (const item of oldItems) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [totalQty, item.product_id, item.batch_no]);
    }

    // Reverse old ledger
    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [sale.total_amount, sale.customer_id]);
    await conn.query('DELETE FROM customer_ledger WHERE reference_type=? AND reference_id=?', ['sale', req.params.id]);
    await conn.query('DELETE FROM sale_items WHERE sale_id=?', [req.params.id]);

    // Insert new items
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);
    await conn.query(
      'UPDATE sales SET customer_id=?, salesman_id=?, delivery_by=?, date=?, total_amount=?, net_collectible=?, pending_amount=? WHERE id=?',
      [customer_id, salesman_id || null, delivery_by || null, date, total_amount, total_amount, total_amount, req.params.id]
    );

    for (const item of items) {
      await conn.query(
        `INSERT INTO sale_items (sale_id, product_id, batch_no, pack_size, sale_rate, qty, bonus, discount_pct, tax_pct, total)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, item.product_id, item.batch_no, item.pack_size, item.sale_rate,
         item.qty, item.bonus || 0, item.discount_pct || 0, item.tax_pct || 0, item.total]
      );
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await conn.query('UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [totalQty, item.product_id, item.batch_no]);
    }

    await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [total_amount, customer_id]);
    const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [customer_id]);
    await conn.query(
      'INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [customer_id, date, sale.invoice_no, 'Sale', total_amount, 0, custRows[0].balance, 'sale', req.params.id]
    );

    await conn.commit();
    await logAudit(req, 'UPDATE', 'sale', req.params.id, `Updated invoice ${sale.invoice_no}`);
    res.json({ message: 'Sale updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Delete sale (only if not locked)
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=?', [req.params.id]);
    if (sRows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const sale = sRows[0];
    if (sale.is_locked) return res.status(403).json({ message: 'Invoice is locked after recovery. Cannot delete.' });

    const [items] = await conn.query('SELECT * FROM sale_items WHERE sale_id=?', [req.params.id]);
    for (const item of items) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [totalQty, item.product_id, item.batch_no]);
    }

    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [sale.total_amount, sale.customer_id]);
    await conn.query('DELETE FROM customer_ledger WHERE reference_type=? AND reference_id=?', ['sale', req.params.id]);
    await conn.query('DELETE FROM tax_ledger WHERE sale_id=?', [req.params.id]);
    await conn.query('DELETE FROM sales WHERE id=?', [req.params.id]);

    await conn.commit();
    await logAudit(req, 'DELETE', 'sale', req.params.id, `Deleted invoice ${sale.invoice_no}`);
    res.json({ message: 'Sale deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;