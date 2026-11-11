const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT } = require('../utils/dateUtils');
const { num, cleanText, normKey, normSql, isDate, fmtPKR, plural, fail, sendError } = require('../utils/manufacturing');

// ─── Assets register ───────────────────────────────────────────────────────
// What the organization owns, who owns each item (a partner, a director, the
// company itself) and what it cost. Two managed lists (types, owners) and the
// assets themselves. Nothing here posts to Finance or any ledger: many assets
// are historical or were paid for by a partner.
//   code         AST-0001, from asset_code_counter (locked) inside the insert
//                transaction; never reused after a delete, never changed
//   total_price  what was paid (authoritative); unit_price is a display value
//                that must agree with it: |qty × unit − total| ≤ 0.005 × qty
//   lifecycle    in_use -> disposed (date + optional note) -> back to in_use.
//                Disposing part of the quantity splits the row: the disposed
//                part becomes a new row (new code, split_from_id = original,
//                same unit price); the original keeps the rest and the
//                difference of the totals, so the sum is preserved exactly
//   edits        PUT carries expected_updated_at; a save against an older
//                version is refused with 409 ASSET_CHANGED
// Every route needs perm_assets (400 PERMISSION_DENIED, never 403: the client
// logs out on any 403). Mirrored for the UX in client/src/pages/assets/Assets.jsx.
router.use(auth, requirePermission('perm_assets', 'Assets'));

const MAX_PRICE = 999999999.99;
const MAX_QTY = 99999;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-18' -> '18 Oct 2026' (audit descriptions). */
const fmtDay = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : '';
};
const label = (a) => `"${a.code} ${a.name}"`;
const stampSql = (column) => `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;
/** Money -> whole paisa, so totals compare and split without float noise. */
const paisa = (value) => Math.round(Number(value) * 100);

// ── Managed lists: asset types and owners ──────────────────────────────────
// Same rules for both: a name is required, cleaned, unique case-insensitively
// (normKey). Renaming is allowed while in use (assets refer to the id, so
// every row shows the new name); deleting one in use is refused.
const onThose = (n) => (Number(n) === 1 ? 'on that asset' : 'on those assets');
const LISTS = {
  types: {
    table: 'asset_types', column: 'asset_type_id', max: 40, module: 'assets/types',
    noun: 'asset type', aNoun: 'an asset type', what: 'type',
    inUse: (r) => `${r.name} is used by ${plural(r.asset_count, 'asset', 'assets')}. Choose another type ${onThose(r.asset_count)} first.`,
  },
  owners: {
    table: 'asset_owners', column: 'owner_id', max: 60, module: 'assets/owners',
    noun: 'asset owner', aNoun: 'an owner', what: 'owner',
    inUse: (r) => `${r.name} is the owner of ${plural(r.asset_count, 'asset', 'assets')}. Choose another owner ${onThose(r.asset_count)} first.`,
  },
};
const listSelect = (list) => `
  SELECT l.id, l.name, (SELECT COUNT(*) FROM assets a WHERE a.${list.column} = l.id) AS asset_count
    FROM ${list.table} l`;
const listRow = (r) => ({ id: r.id, name: r.name, asset_count: Number(r.asset_count) });

async function findListRow(conn, list, id) {
  const [[row]] = await conn.query(`${listSelect(list)} WHERE l.id = ?`, [id]);
  if (!row) throw fail(404, `This ${list.what} no longer exists.`);
  return listRow(row);
}

async function validateListName(conn, list, rawName, excludeId) {
  const name = cleanText(rawName);
  if (!name) throw fail(400, `Enter ${list.aNoun} name.`, { field: 'name' });
  if (name.length > list.max) throw fail(400, `The name must have ${list.max} characters or fewer.`, { field: 'name' });
  const [dups] = await conn.query(
    `SELECT id, name FROM ${list.table} WHERE ${normSql('name')} = ? AND id <> ? LIMIT 1`,
    [normKey(name), excludeId || 0]
  );
  if (dups.length) throw fail(409, `${capital(list.aNoun)} named "${dups[0].name}" already exists.`, { field: 'name' });
  return name;
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dupEntry = (list) => ({ field: 'name', message: `${capital(list.aNoun)} with this name already exists.` });

Object.entries(LISTS).forEach(([path, list]) => {
  router.get(`/${path}`, async (req, res) => {
    try {
      const [rows] = await db.query(`${listSelect(list)} ORDER BY l.name`);
      res.json(rows.map(listRow));
    } catch (err) { sendError(res, err, `The ${list.what}s could not be loaded.`); }
  });

  router.post(`/${path}`, async (req, res) => {
    try {
      const name = await validateListName(db, list, req.body?.name);
      const [result] = await db.query(`INSERT INTO ${list.table} (name) VALUES (?)`, [name]);
      await logAudit(req, 'CREATE', list.module, result.insertId, `Added ${list.noun} "${name}"`);
      res.status(201).json({ id: result.insertId, name, asset_count: 0 });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json(dupEntry(list));
      sendError(res, err, `The ${list.what} could not be added. Try again.`);
    }
  });

  router.put(`/${path}/:id`, async (req, res) => {
    try {
      const existing = await findListRow(db, list, req.params.id);
      const name = await validateListName(db, list, req.body?.name, existing.id);
      if (name === existing.name) return res.json(existing);
      await db.query(`UPDATE ${list.table} SET name = ? WHERE id = ?`, [name, existing.id]);
      await logAudit(req, 'UPDATE', list.module, existing.id, `Renamed ${list.noun} "${existing.name}" to "${name}"`);
      res.json({ ...existing, name });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json(dupEntry(list));
      sendError(res, err, `The ${list.what} could not be renamed. Try again.`);
    }
  });

  router.delete(`/${path}/:id`, async (req, res) => {
    try {
      const existing = await findListRow(db, list, req.params.id);
      if (existing.asset_count > 0) throw fail(409, list.inUse(existing), { code: 'IN_USE' });
      await db.query(`DELETE FROM ${list.table} WHERE id = ?`, [existing.id]);
      await logAudit(req, 'DELETE', list.module, existing.id, `Deleted ${list.noun} "${existing.name}"`);
      res.json({ message: `${capital(list.what)} deleted.` });
    } catch (err) {
      // An asset took it between the count and the delete (FK RESTRICT).
      if (err.code === 'ER_ROW_IS_REFERENCED_2') {
        const row = await findListRow(db, list, req.params.id).catch(() => null);
        return res.status(409).json({ code: 'IN_USE', message: row ? list.inUse(row) : `The ${list.what} is in use and cannot be deleted.` });
      }
      sendError(res, err, `The ${list.what} could not be deleted. Try again.`);
    }
  });
});

// ── Assets ─────────────────────────────────────────────────────────────────
const ASSET_SELECT = `
  SELECT a.id, a.code, a.name, a.serial_no, a.asset_type_id, t.name AS type_name, a.owner_id, o.name AS owner_name,
         a.qty, a.unit_price, a.total_price, DATE_FORMAT(a.purchase_date, '%Y-%m-%d') AS purchase_date,
         a.description, a.status, DATE_FORMAT(a.disposed_on, '%Y-%m-%d') AS disposed_on, a.disposal_note,
         a.split_from_id, a.created_by, COALESCE(cu.full_name, cu.username) AS created_by_name,
         DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         a.updated_by, COALESCE(uu.full_name, uu.username) AS updated_by_name, ${stampSql('a.updated_at')} AS updated_at
    FROM assets a
    JOIN asset_types t ON t.id = a.asset_type_id
    JOIN asset_owners o ON o.id = a.owner_id
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users uu ON uu.id = a.updated_by`;

async function loadAsset(conn, id) {
  const [[row]] = await conn.query(`${ASSET_SELECT} WHERE a.id = ?`, [id]);
  return row || null;
}

/** Locks the row for the rest of the transaction. */
async function lockAsset(conn, id) {
  const [[row]] = await conn.query(
    `SELECT id, code, name, serial_no, asset_type_id, owner_id, qty, unit_price, total_price,
            DATE_FORMAT(purchase_date, '%Y-%m-%d') AS purchase_date, description, status,
            DATE_FORMAT(disposed_on, '%Y-%m-%d') AS disposed_on, ${stampSql('updated_at')} AS updated_at
       FROM assets WHERE id = ? FOR UPDATE`, [id]
  );
  if (!row) throw fail(404, 'This asset no longer exists.');
  return row;
}

/** The next code, from the locked counter: AST-0001 … AST-9999, AST-10000 … */
async function nextCode(conn) {
  const [[counter]] = await conn.query('SELECT last_no FROM asset_code_counter WHERE id = 1 FOR UPDATE');
  if (!counter) throw new Error('asset_code_counter has no row (run server/migrations/add_assets.sql).');
  const next = Number(counter.last_no) + 1;
  await conn.query('UPDATE asset_code_counter SET last_no = ? WHERE id = 1', [next]);
  return `AST-${String(next).padStart(4, '0')}`;
}

const fieldError = (field, message, status = 400) => fail(status, message, { field });

/** A money figure: 0 to MAX_PRICE, at most 2 decimals. */
function parsePrice(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') throw fieldError(field, 'Enter the price.');
  const n = num(value);
  if (!Number.isFinite(n) || n < 0) throw fieldError(field, 'Enter a price of 0 or more.');
  if (n > MAX_PRICE) throw fieldError(field, `Enter a price of ${fmtPKR(MAX_PRICE)} or less.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw fieldError(field, 'Enter the price with no more than 2 decimals.');
  return Math.round(n * 100) / 100;
}

/** A whole number from 1 to `max`; `tooMany` is the message above it. */
function parseQty(value, max, tooMany) {
  const n = num(value);
  if (!Number.isInteger(n) || n < 1) throw fieldError('qty', 'Enter a whole number of 1 or more.');
  if (n > max) throw fieldError('qty', tooMany);
  return n;
}

/** A date, not after today (PKT). */
function parseDate(value, field, { required, future, missing }) {
  if (value === null || value === undefined || value === '') {
    if (required) throw fieldError(field, missing);
    return null;
  }
  if (!isDate(value)) throw fieldError(field, 'Enter a valid date.');
  if (value > todayPKT()) throw fieldError(field, future);
  return value;
}

async function requireListItem(conn, list, id, missing) {
  if (id === null || id === undefined || id === '') throw fieldError(list.column, missing);
  const [[row]] = await conn.query(`SELECT id FROM ${list.table} WHERE id = ?`, [id]);
  if (!row) throw fieldError(list.column, `The selected ${list.what} no longer exists. Choose another ${list.what}.`);
  return row.id;
}

/** Validates an add or edit; the first problem is returned as { field, message }. */
async function validateAsset(conn, body, current) {
  const name = cleanText(body.name);
  if (!name) throw fieldError('name', 'Enter the asset name.');
  if (name.length > 120) throw fieldError('name', 'The asset name must have 120 characters or fewer.');
  const serial = cleanText(body.serial_no) || null;
  if (serial && serial.length > 60) throw fieldError('serial_no', 'The serial or tag no. must have 60 characters or fewer.');
  const typeId = await requireListItem(conn, LISTS.types, body.asset_type_id, 'Choose a type.');
  const ownerId = await requireListItem(conn, LISTS.owners, body.owner_id, 'Choose who owns it.');
  const qty = parseQty(body.qty, MAX_QTY, `Enter a quantity of ${MAX_QTY.toLocaleString('en-US')} or less.`);
  const unit = parsePrice(body.unit_price, 'unit_price');
  const total = parsePrice(body.total_price, 'total_price');
  // The total is what was paid; the unit price must agree with it to within
  // half a paisa per item (the rounding of total ÷ qty).
  if (Math.abs(qty * paisa(unit) - paisa(total)) > 0.5 * qty + 1e-9) {
    throw fieldError('unit_price', 'The unit price does not match the total for this quantity. Check the figures.');
  }
  const purchaseDate = parseDate(body.purchase_date, 'purchase_date', { future: "The purchase date can't be in the future." });
  const description = cleanText(body.description) || null;
  if (description && description.length > 500) throw fieldError('description', 'The description must have 500 characters or fewer.');

  const out = { name, serial, typeId, ownerId, qty, unit, total, purchaseDate, description };
  if (current?.status === 'disposed') {
    out.disposedOn = parseDate(body.disposed_on, 'disposed_on', {
      required: true, missing: 'Enter the disposal date.', future: "The disposal date can't be in the future.",
    });
    if (purchaseDate && out.disposedOn < purchaseDate) {
      throw fieldError('disposed_on', "The disposal date can't be before the purchase date.");
    }
    out.note = cleanText(body.disposal_note) || null;
    if (out.note && out.note.length > 200) throw fieldError('disposal_note', 'The note must have 200 characters or fewer.');
  }
  return out;
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`${ASSET_SELECT} ORDER BY a.name, a.code`);
    res.json(rows);
  } catch (err) { sendError(res, err, 'The assets could not be loaded.'); }
});

router.post('/', async (req, res) => {
  const conn = await db.getConnection();
  let created;
  try {
    await conn.beginTransaction();
    const v = await validateAsset(conn, req.body || {});
    const code = await nextCode(conn);
    const userId = req.user?.id || null;
    const [result] = await conn.query(
      `INSERT INTO assets (code, name, serial_no, asset_type_id, owner_id, qty, unit_price, total_price, purchase_date,
                           description, status, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'in_use',?,NOW(3),?,NOW(3))`,
      [code, v.name, v.serial, v.typeId, v.ownerId, v.qty, v.unit, v.total, v.purchaseDate, v.description, userId, userId]
    );
    await conn.commit();
    created = { id: result.insertId, code, ...v };
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be added. Try again.');
  }
  conn.release();
  const price = created.qty > 1 ? `${created.qty} × ${fmtPKR(created.unit)}` : fmtPKR(created.total);
  await logAudit(req, 'CREATE', 'assets', created.id, `Added asset ${label(created)} (${price})`);
  res.status(201).json(await loadAsset(db, created.id));
});

router.put('/:id', async (req, res) => {
  const conn = await db.getConnection();
  let current;
  let v;
  let stale = false;
  try {
    await conn.beginTransaction();
    current = await lockAsset(conn, req.params.id);
    if (current.updated_at !== (req.body?.expected_updated_at || null)) {
      stale = true;
      await conn.rollback();
    } else {
      v = await validateAsset(conn, req.body || {}, current);
      await conn.query(
        `UPDATE assets SET name=?, serial_no=?, asset_type_id=?, owner_id=?, qty=?, unit_price=?, total_price=?, purchase_date=?,
                           description=?, disposed_on=?, disposal_note=?, updated_by=?, updated_at=NOW(3)
          WHERE id=?`,
        [v.name, v.serial, v.typeId, v.ownerId, v.qty, v.unit, v.total, v.purchaseDate, v.description,
          current.status === 'disposed' ? v.disposedOn : null, current.status === 'disposed' ? v.note : null,
          req.user?.id || null, current.id]
      );
      await conn.commit();
    }
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The changes could not be saved. Try again.');
  }
  conn.release();
  try {
    if (stale) {
      // Saved (edited, disposed or restored) by someone else since this
      // version was loaded: nothing is written.
      const latest = await loadAsset(db, current.id);
      return res.status(409).json({
        code: 'ASSET_CHANGED',
        message: 'Someone else changed this asset while you were editing. Reload to see the latest version.',
        updated_by_id: latest?.updated_by ?? null,
        updated_by_name: latest?.updated_by_name ?? null,
        updated_at: latest?.updated_at ?? null,
      });
    }
    await logAudit(req, 'UPDATE', 'assets', current.id, `Updated asset ${label({ code: current.code, name: v.name })}`);
    res.json(await loadAsset(db, current.id));
  } catch (err) { sendError(res, err, 'The asset could not be loaded. Refresh the page.'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await loadAsset(db, req.params.id);
    if (!existing) throw fail(404, 'This asset no longer exists.');
    // A part split off this entry keeps its own record (split_from_id SET NULL).
    await db.query('DELETE FROM assets WHERE id = ?', [existing.id]);
    await logAudit(req, 'DELETE', 'assets', existing.id, `Deleted asset ${label(existing)}`);
    res.json({ message: `${existing.code} deleted.` });
  } catch (err) { sendError(res, err, 'The asset could not be deleted. Try again.'); }
});

// Body { qty, disposed_on, note }. The whole quantity: the row moves to
// disposed. Part of it: split (see the header). Returns { asset, disposed }:
// the original row as it now stands, and the disposed row (the same row when
// the whole quantity was disposed).
router.post('/:id/dispose', async (req, res) => {
  const conn = await db.getConnection();
  let a;
  let n;
  let disposedOn;
  let splitId = null;
  let splitCode = null;
  try {
    await conn.beginTransaction();
    a = await lockAsset(conn, req.params.id);
    if (a.status !== 'in_use') throw fail(409, `${a.code} is already disposed.`);
    const body = req.body || {};
    n = body.qty === undefined || body.qty === null || body.qty === ''
      ? a.qty
      : parseQty(body.qty, a.qty, `Enter a quantity of ${a.qty.toLocaleString('en-US')} or less.`);
    disposedOn = parseDate(body.disposed_on, 'disposed_on', {
      required: true, missing: 'Enter the disposal date.', future: "The disposal date can't be in the future.",
    });
    if (a.purchase_date && disposedOn < a.purchase_date) {
      throw fieldError('disposed_on', "The disposal date can't be before the purchase date.");
    }
    const note = cleanText(body.note) || null;
    if (note && note.length > 200) throw fieldError('note', 'The note must have 200 characters or fewer.');
    const userId = req.user?.id || null;

    if (n === a.qty) {
      await conn.query(
        `UPDATE assets SET status='disposed', disposed_on=?, disposal_note=?, updated_by=?, updated_at=NOW(3) WHERE id=?`,
        [disposedOn, note, userId, a.id]
      );
    } else {
      // Same unit price on both parts. The disposed part is unit × n; the
      // original keeps the rest of the total, so the two always add up to
      // what was paid (never below zero for an unusually rounded unit price).
      // When the unit price was itself rounded (1,000.00 ÷ 3 = 333.33), the
      // part left over can differ from unit × qty by more than half a paisa
      // per item (333.34 for 1); its unit price is then re-derived from its
      // total, so every row keeps |qty × unit − total| ≤ 0.005 × qty.
      const unitP = paisa(a.unit_price);
      const totalP = paisa(a.total_price);
      const disposedP = Math.min(unitP * n, totalP);
      const keptP = totalP - disposedP;
      const unitFor = (qty, partP) => (Math.abs(qty * unitP - partP) > 0.5 * qty ? Math.round(partP / qty) : unitP) / 100;
      splitCode = await nextCode(conn);
      const [result] = await conn.query(
        `INSERT INTO assets (code, name, serial_no, asset_type_id, owner_id, qty, unit_price, total_price, purchase_date,
                             description, status, disposed_on, disposal_note, split_from_id,
                             created_by, created_at, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'disposed',?,?,?,?,NOW(3),?,NOW(3))`,
        [splitCode, a.name, a.serial_no, a.asset_type_id, a.owner_id, n, unitFor(n, disposedP), disposedP / 100, a.purchase_date,
          a.description, disposedOn, note, a.id, userId, userId]
      );
      splitId = result.insertId;
      await conn.query(
        'UPDATE assets SET qty=?, unit_price=?, total_price=?, updated_by=?, updated_at=NOW(3) WHERE id=?',
        [a.qty - n, unitFor(a.qty - n, keptP), keptP / 100, userId, a.id]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be marked as disposed. Try again.');
  }
  conn.release();
  await logAudit(req, 'UPDATE', 'assets', a.id, splitId
    ? `Disposed ${n} of ${a.qty} ${label(a)} on ${fmtDay(disposedOn)} (split to ${splitCode})`
    : `Disposed ${a.qty > 1 ? `${n} of ${a.qty} ` : ''}${label(a)} on ${fmtDay(disposedOn)}`);
  const asset = await loadAsset(db, a.id);
  res.json({ asset, disposed: splitId ? await loadAsset(db, splitId) : asset });
});

// Back to in use: the disposal date and note are cleared. A split part stays
// its own entry (it is not merged back into the row it came from).
router.post('/:id/restore', async (req, res) => {
  const conn = await db.getConnection();
  let a;
  try {
    await conn.beginTransaction();
    a = await lockAsset(conn, req.params.id);
    if (a.status !== 'disposed') throw fail(409, `${a.code} is already in use.`);
    await conn.query(
      `UPDATE assets SET status='in_use', disposed_on=NULL, disposal_note=NULL, updated_by=?, updated_at=NOW(3) WHERE id=?`,
      [req.user?.id || null, a.id]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be moved back to in use. Try again.');
  }
  conn.release();
  await logAudit(req, 'UPDATE', 'assets', a.id, `Moved ${label(a)} back to in use`);
  res.json(await loadAsset(db, a.id));
});

module.exports = router;
