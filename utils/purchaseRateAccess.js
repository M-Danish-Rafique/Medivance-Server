function normalizeBoolean(value) {
  return value === 1 || value === true || value === '1' || value === 'true';
}

async function canViewPurchaseRate(req, db, productRow = null) {
  if (!req?.user?.id) return false;
  if (req.user.role === 'admin') return true;

  const [[perms]] = await db.query(
    'SELECT perm_view_purchase_rate FROM user_permissions WHERE user_id = ?',
    [req.user.id]
  );

  const userAllowed = normalizeBoolean(perms?.perm_view_purchase_rate);
  if (!userAllowed) return false;

  if (!productRow) return true;
  return normalizeBoolean(productRow.show_purchase_rate ?? 1);
}

async function sanitizeProductRow(req, db, row) {
  const canView = await canViewPurchaseRate(req, db, row);
  if (canView) return row;
  return {
    ...row,
    purchase_rate: null,
    show_purchase_rate: normalizeBoolean(row.show_purchase_rate ?? 1),
  };
}

async function sanitizeProductRows(req, db, rows = []) {
  return Promise.all(rows.map((row) => sanitizeProductRow(req, db, row)));
}

async function sanitizeInventoryRows(req, db, rows = []) {
  return Promise.all(rows.map(async (row) => {
    const canView = await canViewPurchaseRate(req, db, row);
    if (canView) return row;
    return {
      ...row,
      purchase_rate: null,
    };
  }));
}

module.exports = {
  normalizeBoolean,
  canViewPurchaseRate,
  sanitizeProductRow,
  sanitizeProductRows,
  sanitizeInventoryRows,
};
