-- ============================================================================
-- Manufacturing rework: guided batches, by-products, multi-line raw material
-- purchases with landed rates, symbol-only units of measure.
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the server code that reads it, then deploy the server and
-- the client straight away: the old manufacturing screens do not work against
-- the new schema. There is no migration runner.
--
-- CLEARS MANUFACTURING TEST DATA (owner decision 2026-10-12): batches, yields,
-- raw materials, raw material purchases and their ledgers. Manufactured
-- products, product categories and every distribution record are kept.
--
-- Pre-check (read only). Stock that an old yield put into inventory stays in
-- inventory, but its yield rows are deleted below, so the Sale & Stock report
-- would no longer explain it. Expect 0 rows; if rows come back, stop and ask
-- before running the rest of this file.
--   SELECT yi.product_id, yi.batch_no, yi.units_manufactured
--     FROM mfg_yield_items yi WHERE yi.added_to_inventory = 1;
-- ============================================================================

-- ── 1. Clear manufacturing test data ─────────────────────────────────────────
-- Raw material purchases posted their amount to the supplier with
-- reference_type 'purchase', the same type distribution purchases use
-- (production-readiness P0-2), so the rows are matched on the description and
-- amount as well as the id.
UPDATE suppliers s
  JOIN (SELECT supplier_id, SUM(amount) AS amount
          FROM rm_purchases WHERE supplier_id IS NOT NULL GROUP BY supplier_id) x
    ON x.supplier_id = s.id
   SET s.balance = s.balance - x.amount;

DELETE sl FROM supplier_ledger sl
  JOIN rm_purchases rp
    ON sl.reference_type = 'purchase' AND sl.reference_id = rp.id
   AND sl.supplier_id = rp.supplier_id AND sl.description = 'Raw Material Purchase'
   AND ABS(sl.dr - rp.amount) < 0.005;

DELETE FROM mfg_yield_items;
DELETE FROM mfg_yields;
DELETE FROM mfg_batch_materials;
DELETE FROM mfg_batches;
DELETE FROM rm_ledger;
DELETE FROM rm_purchases;
DELETE FROM raw_materials;

-- ── 2. Products: by-products ─────────────────────────────────────────────────
-- A by-product is an ordinary product row (is_manufactured = 1 and
-- is_by_product = 1), so Sale, Inventory and Reports handle it unchanged. Its
-- pack_size is its unit symbol and volume = 1 of that unit.
ALTER TABLE `products`
  ADD COLUMN `is_by_product` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_manufactured`;

-- ── 3. Batches ───────────────────────────────────────────────────────────────
-- status: 'ready' = created, stock deducted, waiting on the Yield page;
-- 'in_inventory' = sent to inventory, read-only.
-- total_cost = raw_material_cost + packaging_cost + misc_expense
--            = SUM(pack total_cost) + byproduct_value.
ALTER TABLE `mfg_batches`
  MODIFY COLUMN `status` ENUM('ready', 'in_inventory') NOT NULL DEFAULT 'ready',
  ADD COLUMN `product_name` VARCHAR(200) NOT NULL DEFAULT '' AFTER `batch_code`,
  ADD COLUMN `packed_volume` DECIMAL(14,4) NOT NULL DEFAULT 0 AFTER `volume_uom_id`,
  ADD COLUMN `loss_volume` DECIMAL(14,4) NOT NULL DEFAULT 0 AFTER `packed_volume`,
  ADD COLUMN `packaging_cost` DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER `raw_material_cost`,
  ADD COLUMN `byproduct_value` DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER `packaging_cost`,
  ADD COLUMN `shared_cost` DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER `byproduct_value`,
  ADD COLUMN `created_by` INT NULL DEFAULT NULL,
  ADD COLUMN `sent_at` DATETIME NULL DEFAULT NULL,
  ADD COLUMN `sent_by` INT NULL DEFAULT NULL,
  ADD KEY `idx_mb_status` (`status`),
  ADD CONSTRAINT `fk_mb_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_mb_sent_by` FOREIGN KEY (`sent_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

-- One row per pack size the batch was filled into.
CREATE TABLE `mfg_batch_packs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `batch_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `units` INT NOT NULL,
  `pack_volume` DECIMAL(12,4) NOT NULL,
  `pack_volume_uom_id` INT NULL DEFAULT NULL,
  `packed_volume_base` DECIMAL(18,4) NOT NULL,
  `shared_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `packaging_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `total_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `cost_per_unit` DECIMAL(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mbp_batch_product` (`batch_id`, `product_id`),
  KEY `fk_mbp_product` (`product_id`),
  KEY `fk_mbp_uom` (`pack_volume_uom_id`),
  CONSTRAINT `fk_mbp_batch` FOREIGN KEY (`batch_id`) REFERENCES `mfg_batches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mbp_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_mbp_uom` FOREIGN KEY (`pack_volume_uom_id`) REFERENCES `units_of_measurement` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Packaging used by one pack row (bottle, cap, label…).
CREATE TABLE `mfg_batch_pack_materials` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pack_id` INT NOT NULL,
  `raw_material_id` INT NOT NULL,
  `qty` DECIMAL(14,4) NOT NULL,
  `unit_cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `total_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mbpm_pack_material` (`pack_id`, `raw_material_id`),
  KEY `fk_mbpm_rm` (`raw_material_id`),
  CONSTRAINT `fk_mbpm_pack` FOREIGN KEY (`pack_id`) REFERENCES `mfg_batch_packs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mbpm_rm` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials` (`id`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- By-products of a batch, each with its own inventory batch number and expiry.
CREATE TABLE `mfg_batch_byproducts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `batch_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `qty` INT NOT NULL,
  `unit_cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `total_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `batch_no` VARCHAR(100) NOT NULL,
  `exp_date` DATE NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mbb_batch_product` (`batch_id`, `product_id`),
  KEY `fk_mbb_product` (`product_id`),
  CONSTRAINT `fk_mbb_batch` FOREIGN KEY (`batch_id`) REFERENCES `mfg_batches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mbb_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- ── 4. Raw material purchases: one document, many lines ─────────────────────
-- rm_purchases (one material per row) is no longer written; it is kept only
-- so code deployed before this migration keeps starting. Drop it later.
CREATE TABLE `rm_purchase_headers` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `purchase_no` VARCHAR(20) NOT NULL,
  `supplier_id` INT NOT NULL,
  `date` DATE NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `items_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `other_charges` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `charges_note` VARCHAR(150) NULL DEFAULT NULL,
  `created_by` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rmph_purchase_no` (`purchase_no`),
  KEY `fk_rmph_supplier` (`supplier_id`),
  CONSTRAINT `fk_rmph_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_rmph_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- landed_rate = (line_total + charges_share) / qty; charges_share is the
-- purchase's other charges split in proportion to line_total.
CREATE TABLE `rm_purchase_lines` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `header_id` INT NOT NULL,
  `raw_material_id` INT NOT NULL,
  `qty` DECIMAL(14,4) NOT NULL,
  `rate` DECIMAL(12,4) NOT NULL,
  `line_total` DECIMAL(14,2) NOT NULL,
  `charges_share` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `landed_rate` DECIMAL(12,4) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rmpl_header_material` (`header_id`, `raw_material_id`),
  KEY `fk_rmpl_rm` (`raw_material_id`),
  CONSTRAINT `fk_rmpl_header` FOREIGN KEY (`header_id`) REFERENCES `rm_purchase_headers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rmpl_rm` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials` (`id`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Distinct ledger types per source table, so a delete can never touch another
-- module's rows (production-readiness P0-2, P0-3):
--   rm_ledger 'rm_purchase' -> rm_purchase_headers.id, 'mfg_batch' -> mfg_batches.id
--   supplier_ledger 'rm_purchase' -> rm_purchase_headers.id
ALTER TABLE `rm_ledger`
  MODIFY COLUMN `reference_type`
    ENUM('purchase', 'batch_usage', 'adjustment', 'rm_purchase', 'mfg_batch') NOT NULL;
ALTER TABLE `supplier_ledger`
  MODIFY COLUMN `reference_type`
    ENUM('purchase', 'payment', 'adjustment', 'rm_purchase') NULL DEFAULT 'purchase';

-- ── 5. Units of measure: symbol only, three categories ──────────────────────
-- Weight (base g: g, kg, ton), Volume (base ml: ml, L), Count (pcs only).
-- `name` stays because code deployed before this migration selects it; it
-- now always mirrors `symbol`.
DELETE FROM units_of_measurement WHERE base_type = 'count' AND LOWER(TRIM(symbol)) NOT IN ('pcs', 'pc');

UPDATE units_of_measurement SET symbol = 'g'   WHERE LOWER(TRIM(symbol)) IN ('g', 'gm', 'gms', 'gram', 'grams');
UPDATE units_of_measurement SET symbol = 'kg'  WHERE LOWER(TRIM(symbol)) IN ('kg', 'kgs', 'kilogram', 'kilograms');
UPDATE units_of_measurement SET symbol = 'ton' WHERE LOWER(TRIM(symbol)) IN ('ton', 'tons', 'tonne', 'tonnes');
UPDATE units_of_measurement SET symbol = 'ml'  WHERE LOWER(TRIM(symbol)) IN ('ml', 'mls', 'millilitre', 'milliliter');
UPDATE units_of_measurement SET symbol = 'L'   WHERE LOWER(TRIM(symbol)) IN ('l', 'ltr', 'ltrs', 'lit', 'litre', 'liter', 'litres', 'liters');
UPDATE units_of_measurement SET symbol = 'pcs' WHERE LOWER(TRIM(symbol)) IN ('pcs', 'pc');

-- One row per symbol: re-point products at the oldest row, drop the rest.
CREATE TEMPORARY TABLE `uom_keep` AS
  SELECT LOWER(TRIM(symbol)) AS sym, MIN(id) AS keep_id FROM units_of_measurement GROUP BY LOWER(TRIM(symbol));
UPDATE products p
  JOIN units_of_measurement u ON u.id = p.volume_uom_id
  JOIN uom_keep k ON k.sym = LOWER(TRIM(u.symbol))
   SET p.volume_uom_id = k.keep_id
 WHERE p.volume_uom_id <> k.keep_id;
DELETE u FROM units_of_measurement u
  JOIN uom_keep k ON k.sym = LOWER(TRIM(u.symbol))
 WHERE u.id <> k.keep_id;
DROP TEMPORARY TABLE `uom_keep`;

UPDATE units_of_measurement SET base_type = 'weight', to_base_factor = 1       WHERE symbol = 'g';
UPDATE units_of_measurement SET base_type = 'weight', to_base_factor = 1000    WHERE symbol = 'kg';
UPDATE units_of_measurement SET base_type = 'weight', to_base_factor = 1000000 WHERE symbol = 'ton';
UPDATE units_of_measurement SET base_type = 'volume', to_base_factor = 1       WHERE symbol = 'ml';
UPDATE units_of_measurement SET base_type = 'volume', to_base_factor = 1000    WHERE symbol = 'L';
UPDATE units_of_measurement SET base_type = 'count',  to_base_factor = 1       WHERE symbol = 'pcs';

-- Two passes, so no row ever collides with another row's old name.
UPDATE units_of_measurement SET symbol = TRIM(symbol), name = CONCAT('~', id);
UPDATE units_of_measurement SET name = symbol;

INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'g', 'g', 'weight', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'g');
INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'kg', 'kg', 'weight', 1000 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'kg');
INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'ton', 'ton', 'weight', 1000000 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'ton');
INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'ml', 'ml', 'volume', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'ml');
INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'L', 'L', 'volume', 1000 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'L');
INSERT INTO units_of_measurement (name, symbol, base_type, to_base_factor)
  SELECT 'pcs', 'pcs', 'count', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM units_of_measurement WHERE symbol = 'pcs');

ALTER TABLE `units_of_measurement` ADD UNIQUE INDEX `uq_uom_symbol` (`symbol`);
