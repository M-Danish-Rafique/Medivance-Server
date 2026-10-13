-- ============================================================================
-- Manufacturing: pack types become a managed list (like product categories).
-- Run once, AFTER mfg_byproduct_unit_only.sql and BEFORE deploying the server
-- code, then deploy the server and the client straight away. There is no
-- migration runner. Not safe to re-run (ALTER TABLE).
--
-- 1. New table mfg_pack_types (id, name). Names are unique, case and extra
--    spaces ignored, at most 40 characters.
-- 2. products.pack_type_id references it. products.pack_type keeps the name
--    as text, because pack_size is still generated from it ("200 ml Pouch")
--    and a pack type in use can never be renamed.
-- 3. One pack type per distinct pack_type text of the manufactured products
--    (case and extra spaces ignored), and each product linked to it.
--    By-products have no pack type.
-- 4. The SELECT at the end lists any product whose pack type was not linked
--    (expect no rows). Fix each one on the Manufactured Products screen.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `mfg_pack_types` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(40) NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mfg_pack_types_name` (`name`)
);

ALTER TABLE `products`
  ADD COLUMN `pack_type_id` INT NULL DEFAULT NULL AFTER `pack_type`,
  ADD KEY `idx_products_pack_type` (`pack_type_id`),
  ADD CONSTRAINT `fk_products_pack_type` FOREIGN KEY (`pack_type_id`) REFERENCES `mfg_pack_types` (`id`);

-- One pack type per distinct text; the first spelling (by product id) wins.
INSERT IGNORE INTO `mfg_pack_types` (`name`)
SELECT TRIM(REGEXP_REPLACE(p.pack_type, '[[:space:]]+', ' '))
  FROM products p
  JOIN (
    SELECT MIN(id) AS id
      FROM products
     WHERE is_manufactured = 1 AND is_by_product = 0
       AND pack_type IS NOT NULL AND TRIM(pack_type) <> ''
       AND CHAR_LENGTH(TRIM(REGEXP_REPLACE(pack_type, '[[:space:]]+', ' '))) <= 40
     GROUP BY LOWER(TRIM(REGEXP_REPLACE(pack_type, '[[:space:]]+', ' ')))
  ) firsts ON firsts.id = p.id
 ORDER BY p.id;

UPDATE products p
  JOIN mfg_pack_types t
    ON LOWER(TRIM(REGEXP_REPLACE(t.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(p.pack_type, '[[:space:]]+', ' ')))
   SET p.pack_type_id = t.id
 WHERE p.is_manufactured = 1 AND p.is_by_product = 0;

-- ── Review: products whose pack type was not linked (expect no rows) ──
SELECT p.id, p.name, p.pack_size, p.pack_type, p.is_by_product,
       'Pack type not linked: choose it again on the Manufactured Products screen' AS action
  FROM products p
 WHERE p.is_manufactured = 1
   AND p.pack_type IS NOT NULL AND TRIM(p.pack_type) <> ''
   AND p.pack_type_id IS NULL;
