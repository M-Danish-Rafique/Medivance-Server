-- ============================================================================
-- Manufacturing: draft batches, pack size = number + unit (+ pack type).
-- Run once, AFTER rework_manufacturing.sql and BEFORE deploying the server
-- code that reads it, then deploy the server and the client straight away.
-- There is no migration runner.
--
-- 1. products.pack_type (optional: Bottle, Pouch, Jar…). A manufactured
--    product's pack size is now entered as number + unit (volume,
--    volume_uom_id) and pack_size is generated from them: "200 ml",
--    "200 ml Pouch". Invoices, inventory and reports keep reading pack_size.
-- 2. Existing manufactured products get pack_size rebuilt from volume + unit.
--    Products that cannot be converted keep their old pack_size and are listed
--    by the two SELECTs at the end: fix each one on the Manufactured Products
--    screen (saving it regenerates the label).
-- 3. Batches gain a Draft status: no batch code, no stock movement, the form
--    kept as JSON until Create batch turns the same row into a real batch.
-- ============================================================================

ALTER TABLE `products`
  ADD COLUMN `pack_type` VARCHAR(40) NULL DEFAULT NULL AFTER `pack_size`;

ALTER TABLE `mfg_batches`
  MODIFY COLUMN `status` ENUM('draft', 'ready', 'in_inventory') NOT NULL DEFAULT 'ready',
  MODIFY COLUMN `batch_code` VARCHAR(50) NULL DEFAULT NULL,
  MODIFY COLUMN `batch_date` DATE NULL DEFAULT NULL,
  MODIFY COLUMN `expiry_date` DATE NULL DEFAULT NULL,
  MODIFY COLUMN `total_volume` DECIMAL(14,4) NULL DEFAULT NULL,
  ADD COLUMN `misc_note` VARCHAR(200) NULL DEFAULT NULL AFTER `misc_expense`,
  ADD COLUMN `draft_json` JSON NULL DEFAULT NULL,
  ADD COLUMN `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ── Rebuild pack_size for manufactured products ─────────────────────────────
-- "200.0000" -> "200", "0.5000" -> "0.5", plus the unit symbol.
CREATE TEMPORARY TABLE `mfg_pack_labels` AS
  SELECT p.id, p.name,
         CONCAT(TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(p.volume AS CHAR))), ' ', u.symbol) AS label
    FROM products p
    JOIN units_of_measurement u ON u.id = p.volume_uom_id AND u.base_type IN ('weight', 'volume')
   WHERE p.is_manufactured = 1 AND p.is_by_product = 0 AND p.volume > 0;

-- A rebuilt label must not land on another product's name + pack_size
-- (UNIQUE uniq_products_name_pack); such rows are left for manual review.
-- (A temporary table cannot be opened twice in one query, hence the counts.)
CREATE TEMPORARY TABLE `mfg_pack_label_counts` AS
  SELECT LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))) AS n, LOWER(label) AS lb, COUNT(*) AS c FROM mfg_pack_labels GROUP BY LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))), LOWER(label);
CREATE TEMPORARY TABLE `mfg_pack_clash` AS
  SELECT l.id FROM mfg_pack_labels l
    JOIN mfg_pack_label_counts k ON k.n = LOWER(TRIM(REGEXP_REPLACE(l.name, '[[:space:]]+', ' '))) AND k.lb = LOWER(l.label)
   WHERE k.c > 1
      OR EXISTS (SELECT 1 FROM products o
                  WHERE o.id <> l.id AND LOWER(TRIM(REGEXP_REPLACE(o.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(l.name, '[[:space:]]+', ' '))) AND LOWER(o.pack_size) = LOWER(l.label));

UPDATE products p
  JOIN mfg_pack_labels l ON l.id = p.id
   SET p.pack_size = l.label
 WHERE p.id NOT IN (SELECT id FROM mfg_pack_clash);

-- ── Review lists (expect 0 rows each) ───────────────────────────────────────
-- No usable size: missing volume or a weight/volume unit.
SELECT p.id, p.name, p.pack_size, p.volume, p.volume_uom_id
  FROM products p
  LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
 WHERE p.is_manufactured = 1 AND p.is_by_product = 0
   AND (p.volume IS NULL OR p.volume <= 0 OR u.id IS NULL OR u.base_type = 'count');

-- Same name and the same rebuilt size as another product: merge or rename.
SELECT p.id, p.name, p.pack_size AS kept_pack_size, l.label AS rebuilt_label
  FROM products p JOIN mfg_pack_labels l ON l.id = p.id
 WHERE p.id IN (SELECT id FROM mfg_pack_clash);

-- Converted, but the same size in base units as another product of the same
-- name (1 L and 1000 ml): the form will refuse to save either until one is
-- renamed, resized or deleted.
SELECT a.id, a.name, a.pack_size, b.id AS same_size_as_id, b.pack_size AS same_size_as
  FROM products a
  JOIN units_of_measurement ua ON ua.id = a.volume_uom_id
  JOIN products b ON b.id > a.id AND b.is_manufactured = 1 AND b.is_by_product = 0
                 AND LOWER(TRIM(REGEXP_REPLACE(b.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(a.name, '[[:space:]]+', ' '))) AND COALESCE(b.pack_type, '') = COALESCE(a.pack_type, '')
  JOIN units_of_measurement ub ON ub.id = b.volume_uom_id AND ub.base_type = ua.base_type
 WHERE a.is_manufactured = 1 AND a.is_by_product = 0
   AND ABS(a.volume * ua.to_base_factor - b.volume * ub.to_base_factor) < 0.000001;

DROP TEMPORARY TABLE `mfg_pack_clash`;
DROP TEMPORARY TABLE `mfg_pack_label_counts`;
DROP TEMPORARY TABLE `mfg_pack_labels`;
