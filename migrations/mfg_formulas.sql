-- ============================================================================
-- Manufacturing: product formulas (default raw materials and packaging that
-- pre-fill new batches). Run once, AFTER mfg_pack_types.sql and BEFORE
-- deploying the server code. There is no migration runner. Adds tables only;
-- no existing row changes. Not safe to re-run (CREATE TABLE without IF NOT
-- EXISTS is intended: a second run stops at the first statement).
--
-- 1. mfg_formulas: one per product group (the products with the same name and
--    category; there is no parent product row). product_key = the name in
--    lower case with extra spaces removed, written by the server with the
--    same rule as normKey. category_key makes two NULL categories one value
--    for the unique key. ref_qty + ref_uom_id = the output the quantities are
--    for ("for 100 L").
-- 2. mfg_formula_materials: the raw materials of a formula, per ref_qty.
-- 3. mfg_pack_packaging: the packaging of one pack size (products.id):
--    qty pcs for every per_units units ("1 carton for every 24").
--    updated_at / updated_by let a save that only changes packaging still
--    detect a concurrent edit.
-- Batches never read these tables: the batch editor copies the values into
-- the form, so existing batches and drafts are unaffected by any change here.
-- ============================================================================

CREATE TABLE `mfg_formulas` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `product_name` VARCHAR(200) NOT NULL,
  `product_key` VARCHAR(200) NOT NULL,
  `category_id` INT NULL DEFAULT NULL,
  `category_key` INT AS (COALESCE(`category_id`, 0)) STORED,
  `ref_qty` DECIMAL(14,4) NOT NULL,
  `ref_uom_id` INT NOT NULL,
  `created_by` INT NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by` INT NULL DEFAULT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mfg_formulas_group` (`product_key`, `category_key`),
  KEY `fk_mfg_formulas_category` (`category_id`),
  KEY `fk_mfg_formulas_uom` (`ref_uom_id`),
  CONSTRAINT `fk_mfg_formulas_category` FOREIGN KEY (`category_id`) REFERENCES `product_categories` (`id`),
  CONSTRAINT `fk_mfg_formulas_uom` FOREIGN KEY (`ref_uom_id`) REFERENCES `units_of_measurement` (`id`),
  CONSTRAINT `fk_mfg_formulas_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_mfg_formulas_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_mfg_formulas_ref_qty` CHECK (`ref_qty` > 0)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE `mfg_formula_materials` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `formula_id` INT NOT NULL,
  `raw_material_id` INT NOT NULL,
  `qty` DECIMAL(14,4) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mfm_formula_material` (`formula_id`, `raw_material_id`),
  KEY `fk_mfm_rm` (`raw_material_id`),
  CONSTRAINT `fk_mfm_formula` FOREIGN KEY (`formula_id`) REFERENCES `mfg_formulas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mfm_rm` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials` (`id`),
  CONSTRAINT `chk_mfm_qty` CHECK (`qty` > 0)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE `mfg_pack_packaging` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `product_id` INT NOT NULL,
  `raw_material_id` INT NOT NULL,
  `qty` INT NOT NULL,
  `per_units` INT NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_by` INT NULL DEFAULT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mpp_product_material` (`product_id`, `raw_material_id`),
  KEY `fk_mpp_rm` (`raw_material_id`),
  CONSTRAINT `fk_mpp_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mpp_rm` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials` (`id`),
  CONSTRAINT `fk_mpp_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_mpp_qty` CHECK (`qty` >= 1),
  CONSTRAINT `chk_mpp_per_units` CHECK (`per_units` >= 1)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
