const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT } = require('../utils/dateUtils');
const { num, cleanText, normKey, normSql, isDate, fmtPKR, plural, fail, sendError } = require('../utils/manufacturing');

// ─── Assets register ───────────────────────────────────────────────────────
// What the organization has today, who owns each item and what it is worth
// now (its current value, not what was paid for it). Three managed lists
// (types, owners, reasons) and the assets themselves. Nothing here posts to
// Finance or any ledger: many assets are historical or were paid for by a
// partner.
//   code         AST-0001, from asset_code_counter (locked) inside the insert
//                transaction; never reused after a delete, never changed
//   total_value  the current value of the whole entry (authoritative);
//                unit_value is a display value that must agree with it:
//                |qty × unit − total| ≤ 0.005 × qty
//   value_as_of  the date that value applies to: today on add and on an edit
//                that changes the value; the chosen date on POST /:id/value.
//                Every change is kept in asset_value_log (the detail view's
//                value history)
//   lifecycle    active -> retired (a reason such as Sold, Scrapped or Lost,
//                a retirement date and an optional note) -> reinstated to
//                active. Retiring part of the quantity splits the row: that
//                part becomes a new row (new code, split_from_id = original,
//                same unit value); the original keeps the rest and the
//                difference of the totals, so the sum is preserved exactly
//   edits        PUT carries expected_updated_at; a save against an older
//                version is refused with 409 ASSET_CHANGED
// Every route needs perm_assets (400 PERMISSION_DENIED, never 403: the client
// logs out on any 403). Mirrored for the UX in client/src/pages/assets/Assets.jsx.
router.use(auth, requirePermission('perm_assets', 'Assets'));

const MAX_VALUE = 999999999.99;
const MAX_QTY = 99999;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-18' -> '18 Oct 2026' (audit descriptions and messages). */
const fmtDay = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : '';
};
const label = (a) => `"${a.code} ${a.name}"`;
const stampSql = (column) => `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;
/** Money -> whole paisa, so totals compare and split without float noise. */
const paisa = (value) => Math.round(Number(value) * 100);
/** The later of two 'YYYY-MM-DD' dates (either may be null). */
const laterDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// ── Managed lists: asset types, owners and reasons ─────────────────────────
// Same rules for all three: a name is required, cleaned, unique
// case-insensitively (normKey). Renaming is allowed while in use (assets refer
// to the id, so every row shows the new name); deleting one in use is refused.
// Reasons say why an asset was retired (Sold, Scrapped, Lost …); the users
// keep that list themselves.
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
  reasons: {
    table: 'asset_reasons', column: 'reason_id', max: 40, module: 'assets/reasons',
    noun: 'reason', aNoun: 'a reason', what: 'reason',
    inUse: (r) => `${r.name} is the reason on ${plural(r.asset_count, 'asset', 'assets')}. Choose another reason ${onThose(r.asset_count)} first.`,
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
         a.qty, a.unit_value, a.total_value, DATE_FORMAT(a.value_as_of, '%Y-%m-%d') AS value_as_of,
         DATE_FORMAT(a.purchase_date, '%Y-%m-%d') AS purchase_date, a.description,
         a.status, a.reason_id, r.name AS reason_name,
         DATE_FORMAT(a.retired_on, '%Y-%m-%d') AS retired_on, a.retirement_note,
         a.split_from_id, sf.code AS split_from_code,
         a.created_by, COALESCE(cu.full_name, cu.username) AS created_by_name,
         DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         a.updated_by, COALESCE(uu.full_name, uu.username) AS updated_by_name, ${stampSql('a.updated_at')} AS updated_at
    FROM assets a
    JOIN asset_types t ON t.id = a.asset_type_id
    JOIN asset_owners o ON o.id = a.owner_id
    LEFT JOIN asset_reasons r ON r.id = a.reason_id
    LEFT JOIN assets sf ON sf.id = a.split_from_id
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users uu ON uu.id = a.updated_by`;

async function loadAsset(conn, id) {
  const [[row]] = await conn.query(`${ASSET_SELECT} WHERE a.id = ?`, [id]);
  return row || null;
}

/** Locks the row for the rest of the transaction. */
async function lockAsset(conn, id) {
  const [[row]] = await conn.query(
    `SELECT id, code, name, serial_no, asset_type_id, owner_id, qty, unit_value, total_value,
            DATE_FORMAT(value_as_of, '%Y-%m-%d') AS value_as_of,
            DATE_FORMAT(purchase_date, '%Y-%m-%d') AS purchase_date, description, status, reason_id,
            DATE_FORMAT(retired_on, '%Y-%m-%d') AS retired_on, ${stampSql('updated_at')} AS updated_at
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

/** One line of the value history (asset_value_log). `kind`: added | edited
 *  | revalued | split. `previous` is the total before the change (null on add). */
async function logValue(conn, { assetId, kind, valuedOn, qty, total, previous = null, note = null, userId }) {
  await conn.query(
    `INSERT INTO asset_value_log (asset_id, kind, valued_on, qty, total_value, previous_total, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,NOW(3))`,
    [assetId, kind, valuedOn, qty, total, previous, note, userId]
  );
}

const fieldError = (field, message, status = 400) => fail(status, message, { field });

/** A money figure: 0 to MAX_VALUE, at most 2 decimals. */
function parseValue(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') throw fieldError(field, 'Enter the value.');
  const n = num(value);
  if (!Number.isFinite(n) || n < 0) throw fieldError(field, 'Enter a value of 0 or more.');
  if (n > MAX_VALUE) throw fieldError(field, `Enter a value of ${fmtPKR(MAX_VALUE)} or less.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw fieldError(field, 'Enter the value with no more than 2 decimals.');
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

/** Reason, date and note of a retirement (the edit form of a retired asset
 *  and POST /:id/retire share these rules). */
async function validateRetirement(conn, { reasonId, date, note, noteField }, purchaseDate) {
  const out = {};
  out.reasonId = await requireListItem(conn, LISTS.reasons, reasonId, 'Choose why it is being retired.');
  out.date = parseDate(date, 'retired_on', {
    required: true, missing: 'Enter the retirement date.', future: "The retirement date can't be in the future.",
  });
  if (purchaseDate && out.date < purchaseDate) {
    throw fieldError('retired_on', "The retirement date can't be before the purchase date.");
  }
  out.note = cleanText(note) || null;
  if (out.note && out.note.length > 200) throw fieldError(noteField, 'The note must have 200 characters or fewer.');
  return out;
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
  const unit = parseValue(body.unit_value, 'unit_value');
  const total = parseValue(body.total_value, 'total_value');
  // The total is the current value; the unit value must agree with it to
  // within half a paisa per item (the rounding of total ÷ qty).
  if (Math.abs(qty * paisa(unit) - paisa(total)) > 0.5 * qty + 1e-9) {
    throw fieldError('unit_value', 'The unit value does not match the total for this quantity. Check the figures.');
  }
  const purchaseDate = parseDate(body.purchase_date, 'purchase_date', { future: "The purchase date can't be in the future." });
  const description = cleanText(body.description) || null;
  if (description && description.length > 500) throw fieldError('description', 'The description must have 500 characters or fewer.');

  const out = { name, serial, typeId, ownerId, qty, unit, total, purchaseDate, description };
  if (current?.status === 'retired') {
    out.retirement = await validateRetirement(conn, {
      reasonId: body.reason_id, date: body.retired_on, note: body.retirement_note, noteField: 'retirement_note',
    }, purchaseDate);
  }
  return out;
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`${ASSET_SELECT} ORDER BY a.name, a.code`);
    res.json(rows);
  } catch (err) { sendError(res, err, 'The assets could not be loaded.'); }
});

// One asset with its value history (newest first) and the entries split off
// it. Registered after the list routes, so /types, /owners and /reasons never
// reach it.
router.get('/:id', async (req, res) => {
  try {
    const asset = await loadAsset(db, req.params.id);
    if (!asset) throw fail(404, 'This asset no longer exists.');
    const [history] = await db.query(
      `SELECT h.id, h.kind, DATE_FORMAT(h.valued_on, '%Y-%m-%d') AS valued_on, h.qty, h.total_value, h.previous_total,
              h.note, COALESCE(u.full_name, u.username) AS by_name, DATE_FORMAT(h.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM asset_value_log h
         LEFT JOIN users u ON u.id = h.created_by
        WHERE h.asset_id = ?
        ORDER BY h.valued_on DESC, h.id DESC`, [asset.id]
    );
    const [parts] = await db.query(
      `SELECT a.id, a.code, a.qty, a.status, r.name AS reason_name
         FROM assets a LEFT JOIN asset_reasons r ON r.id = a.reason_id
        WHERE a.split_from_id = ? ORDER BY a.id`, [asset.id]
    );
    res.json({ ...asset, history, parts });
  } catch (err) { sendError(res, err, 'The asset could not be loaded.'); }
});

router.post('/', async (req, res) => {
  const conn = await db.getConnection();
  let created;
  try {
    await conn.beginTransaction();
    const v = await validateAsset(conn, req.body || {});
    const code = await nextCode(conn);
    const userId = req.user?.id || null;
    const today = todayPKT();
    const [result] = await conn.query(
      `INSERT INTO assets (code, name, serial_no, asset_type_id, owner_id, qty, unit_value, total_value, value_as_of,
                           purchase_date, description, status, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,NOW(3),?,NOW(3))`,
      [code, v.name, v.serial, v.typeId, v.ownerId, v.qty, v.unit, v.total, today, v.purchaseDate, v.description, userId, userId]
    );
    await logValue(conn, { assetId: result.insertId, kind: 'added', valuedOn: today, qty: v.qty, total: v.total, userId });
    await conn.commit();
    created = { id: result.insertId, code, ...v };
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be added. Try again.');
  }
  conn.release();
  const value = created.qty > 1 ? `${created.qty} × ${fmtPKR(created.unit)}` : fmtPKR(created.total);
  await logAudit(req, 'CREATE', 'assets', created.id, `Added asset ${label(created)} (${value})`);
  res.status(201).json(await loadAsset(db, created.id));
});

router.put('/:id', async (req, res) => {
  const conn = await db.getConnection();
  let current;
  let v;
  let valueChanged = false;
  let stale = false;
  try {
    await conn.beginTransaction();
    current = await lockAsset(conn, req.params.id);
    if (current.updated_at !== (req.body?.expected_updated_at || null)) {
      stale = true;
      await conn.rollback();
    } else {
      v = await validateAsset(conn, req.body || {}, current);
      const userId = req.user?.id || null;
      const today = todayPKT();
      // A new figure (or quantity) is the value as of today; otherwise the
      // date stays, moved up to the purchase date if that is now later.
      valueChanged = paisa(v.total) !== paisa(current.total_value) || v.qty !== Number(current.qty);
      const valueAsOf = valueChanged ? today : laterDate(current.value_as_of, v.purchaseDate);
      const out = v.retirement || { reasonId: null, date: null, note: null };
      await conn.query(
        `UPDATE assets SET name=?, serial_no=?, asset_type_id=?, owner_id=?, qty=?, unit_value=?, total_value=?, value_as_of=?,
                           purchase_date=?, description=?, reason_id=?, retired_on=?, retirement_note=?,
                           updated_by=?, updated_at=NOW(3)
          WHERE id=?`,
        [v.name, v.serial, v.typeId, v.ownerId, v.qty, v.unit, v.total, valueAsOf, v.purchaseDate, v.description,
          out.reasonId, out.date, out.note, userId, current.id]
      );
      if (valueChanged) {
        await logValue(conn, {
          assetId: current.id, kind: 'edited', valuedOn: today, qty: v.qty, total: v.total,
          previous: current.total_value, userId,
        });
      }
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
      // Saved (edited, revalued, retired or reinstated) by someone
      // else since this version was loaded: nothing is written.
      const latest = await loadAsset(db, current.id);
      return res.status(409).json({
        code: 'ASSET_CHANGED',
        message: 'Someone else changed this asset while you were editing. Reload to see the latest version.',
        updated_by_id: latest?.updated_by ?? null,
        updated_by_name: latest?.updated_by_name ?? null,
        updated_at: latest?.updated_at ?? null,
      });
    }
    const valueText = valueChanged ? ` (value ${fmtPKR(current.total_value)} -> ${fmtPKR(v.total)})` : '';
    await logAudit(req, 'UPDATE', 'assets', current.id, `Updated asset ${label({ code: current.code, name: v.name })}${valueText}`);
    res.json(await loadAsset(db, current.id));
  } catch (err) { sendError(res, err, 'The asset could not be loaded. Refresh the page.'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await loadAsset(db, req.params.id);
    if (!existing) throw fail(404, 'This asset no longer exists.');
    // A part split off this entry keeps its own record (split_from_id SET
    // NULL); the value history goes with the entry (ON DELETE CASCADE).
    await db.query('DELETE FROM assets WHERE id = ?', [existing.id]);
    await logAudit(req, 'DELETE', 'assets', existing.id, `Deleted asset ${label(existing)}`);
    res.json({ message: `${existing.code} deleted.` });
  } catch (err) { sendError(res, err, 'The asset could not be deleted. Try again.'); }
});

// Body { total_value, valued_on, note }: what the whole entry is worth on
// that date. The unit value is derived (total ÷ qty, to the paisa). The date
// can't be in the future, before the purchase date, or before the date the
// current value already applies to. The same figure on a later date is
// allowed: it records that the value was checked and still holds.
router.post('/:id/value', async (req, res) => {
  const conn = await db.getConnection();
  let a;
  let total;
  let valuedOn;
  try {
    await conn.beginTransaction();
    a = await lockAsset(conn, req.params.id);
    if (a.status !== 'active') throw fail(409, `${a.code} is retired. Reinstate it to update its value.`);
    const body = req.body || {};
    total = parseValue(body.total_value, 'total_value');
    valuedOn = parseDate(body.valued_on, 'valued_on', {
      required: true, missing: 'Enter the date of this value.', future: "The date can't be in the future.",
    });
    if (a.purchase_date && valuedOn < a.purchase_date) {
      throw fieldError('valued_on', "The date can't be before the purchase date.");
    }
    if (a.value_as_of && valuedOn < a.value_as_of) {
      throw fieldError('valued_on', `The value is already recorded as of ${fmtDay(a.value_as_of)}. Choose that date or later.`);
    }
    if (paisa(total) === paisa(a.total_value) && valuedOn === a.value_as_of) {
      throw fieldError('total_value', 'This is already the value on that date. Enter a new value or a later date.');
    }
    const note = cleanText(body.note) || null;
    if (note && note.length > 200) throw fieldError('note', 'The note must have 200 characters or fewer.');
    const unit = Math.round(paisa(total) / Number(a.qty)) / 100;
    const userId = req.user?.id || null;
    await conn.query(
      'UPDATE assets SET unit_value=?, total_value=?, value_as_of=?, updated_by=?, updated_at=NOW(3) WHERE id=?',
      [unit, total, valuedOn, userId, a.id]
    );
    await logValue(conn, {
      assetId: a.id, kind: 'revalued', valuedOn, qty: a.qty, total, previous: a.total_value, note, userId,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The value could not be updated. Try again.');
  }
  conn.release();
  await logAudit(req, 'UPDATE', 'assets', a.id,
    `Updated the value of ${label(a)} from ${fmtPKR(a.total_value)} to ${fmtPKR(total)} as of ${fmtDay(valuedOn)}`);
  res.json(await loadAsset(db, a.id));
});

// Body { qty, reason_id, retired_on, note }. The whole quantity: the row is
// retired. Part of it: split (see the header). Returns { asset, retired }:
// the original row as it now stands, and the retired row (the same row when
// the whole quantity was retired).
router.post('/:id/retire', async (req, res) => {
  const conn = await db.getConnection();
  let a;
  let n;
  let out;
  let reasonName = null;
  let splitId = null;
  let splitCode = null;
  try {
    await conn.beginTransaction();
    a = await lockAsset(conn, req.params.id);
    if (a.status !== 'active') throw fail(409, `${a.code} is already retired.`);
    const body = req.body || {};
    n = body.qty === undefined || body.qty === null || body.qty === ''
      ? a.qty
      : parseQty(body.qty, a.qty, `Enter a quantity of ${a.qty.toLocaleString('en-US')} or less.`);
    out = await validateRetirement(conn, {
      reasonId: body.reason_id, date: body.retired_on, note: body.note, noteField: 'note',
    }, a.purchase_date);
    const [[reason]] = await conn.query('SELECT name FROM asset_reasons WHERE id = ?', [out.reasonId]);
    reasonName = reason?.name || null;
    const userId = req.user?.id || null;

    if (n === a.qty) {
      await conn.query(
        `UPDATE assets SET status='retired', reason_id=?, retired_on=?, retirement_note=?, updated_by=?, updated_at=NOW(3)
          WHERE id=?`,
        [out.reasonId, out.date, out.note, userId, a.id]
      );
    } else {
      // Same unit value on both parts. The retired part is unit × n; the
      // original keeps the rest of the total, so the two always add up to
      // the value before the split (never below zero for an unusually
      // rounded unit value). When the unit value was itself rounded
      // (1,000.00 ÷ 3 = 333.33), the part left over can differ from
      // unit × qty by more than half a paisa per item (333.34 for 1); its
      // unit value is then re-derived from its total, so every row keeps
      // |qty × unit − total| ≤ 0.005 × qty. Both parts keep value_as_of.
      const unitP = paisa(a.unit_value);
      const totalP = paisa(a.total_value);
      const movedP = Math.min(unitP * n, totalP);
      const keptP = totalP - movedP;
      const unitFor = (qty, partP) => (Math.abs(qty * unitP - partP) > 0.5 * qty ? Math.round(partP / qty) : unitP) / 100;
      splitCode = await nextCode(conn);
      const [result] = await conn.query(
        `INSERT INTO assets (code, name, serial_no, asset_type_id, owner_id, qty, unit_value, total_value, value_as_of,
                             purchase_date, description, status, reason_id, retired_on, retirement_note, split_from_id,
                             created_by, created_at, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'retired',?,?,?,?,?,NOW(3),?,NOW(3))`,
        [splitCode, a.name, a.serial_no, a.asset_type_id, a.owner_id, n, unitFor(n, movedP), movedP / 100, a.value_as_of,
          a.purchase_date, a.description, out.reasonId, out.date, out.note, a.id, userId, userId]
      );
      splitId = result.insertId;
      await conn.query(
        'UPDATE assets SET qty=?, unit_value=?, total_value=?, updated_by=?, updated_at=NOW(3) WHERE id=?',
        [a.qty - n, unitFor(a.qty - n, keptP), keptP / 100, userId, a.id]
      );
      await logValue(conn, {
        assetId: a.id, kind: 'split', valuedOn: out.date, qty: a.qty - n, total: keptP / 100,
        previous: a.total_value, note: `${n} retired as ${splitCode}`, userId,
      });
      await logValue(conn, {
        assetId: splitId, kind: 'split', valuedOn: out.date, qty: n, total: movedP / 100,
        note: `Split from ${a.code}`, userId,
      });
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be retired. Try again.');
  }
  conn.release();
  const why = reasonName ? ` (${reasonName})` : '';
  await logAudit(req, 'UPDATE', 'assets', a.id, splitId
    ? `Retired ${n} of ${a.qty} ${label(a)} on ${fmtDay(out.date)}${why} (split to ${splitCode})`
    : `Retired ${a.qty > 1 ? `${n} of ${a.qty} ` : ''}${label(a)} on ${fmtDay(out.date)}${why}`);
  const asset = await loadAsset(db, a.id);
  res.json({ asset, retired: splitId ? await loadAsset(db, splitId) : asset });
});

// Reinstate: back to active; the reason, retirement date and note are
// cleared. A split part stays its own entry (it is not merged back into the
// row it came from).
router.post('/:id/reinstate', async (req, res) => {
  const conn = await db.getConnection();
  let a;
  try {
    await conn.beginTransaction();
    a = await lockAsset(conn, req.params.id);
    if (a.status !== 'retired') throw fail(409, `${a.code} is already active.`);
    await conn.query(
      `UPDATE assets SET status='active', reason_id=NULL, retired_on=NULL, retirement_note=NULL, updated_by=?, updated_at=NOW(3)
        WHERE id=?`,
      [req.user?.id || null, a.id]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    return sendError(res, err, 'The asset could not be reinstated. Try again.');
  }
  conn.release();
  await logAudit(req, 'UPDATE', 'assets', a.id, `Reinstated ${label(a)}`);
  res.json(await loadAsset(db, a.id));
});

module.exports = router;