-- ============================================================================
-- Manufacturing: a by-product's pack size is its unit only ("kg"), with no
-- number and no pack type. Run once, AFTER mfg_byproduct_sale_rate.sql and
-- BEFORE deploying the server code, then deploy the server and the client
-- straight away. There is no migration runner. Safe to re-run.
--
-- Replaces mfg_byproduct_pack_size.sql (number + unit), which is withdrawn:
-- do not run it. On a database where it already ran, this script turns
-- "1 kg" back into "kg".
--
-- 1. Every by-product with a unit, a volume of 1 (or none) and no pack type
--    gets pack_size = the unit symbol, volume = 1 and no pack type. Stock,
--    batch and invoice quantities do not change: 60 kg stays 60 kg. Past
--    invoices keep the pack size they printed.
-- 2. By-products that cannot be converted are left as they are and listed by
--    the SELECTs at the end:
--      * no unit;
--      * a pack of more or less than 1 unit, or a pack type ("25 kg Bag"):
--        its stock counts packs, so relabelling it "kg" would change what the
--        quantities mean;
--      * another product of the same name already uses the unit as its pack
--        size.
--    Fix each one on the Manufactured Products screen, By-products tab, or
--    replace it with a new by-product.
-- ============================================================================

DROP TEMPORARY TABLE IF EXISTS tmp_by_unit;
CREATE TEMPORARY TABLE tmp_by_unit AS
SELECT p.id, u.symbol AS new_label
  FROM products p
  JOIN units_of_measurement u ON u.id = p.volume_uom_id
 WHERE p.is_by_product = 1
   AND (p.volume IS NULL OR p.volume = 0 OR p.volume = 1)
   AND (p.pack_type IS NULL OR TRIM(p.pack_type) = '');

-- Leave out any whose new label clashes with another product of the same name.
DELETE t FROM tmp_by_unit t
  JOIN products p ON p.id = t.id
  JOIN products o ON o.id <> p.id
                 AND LOWER(TRIM(o.name)) = LOWER(TRIM(p.name))
                 AND LOWER(TRIM(o.pack_size)) = LOWER(t.new_label);

UPDATE products p
  JOIN tmp_by_unit t ON t.id = p.id
   SET p.volume = 1,
       p.pack_type = NULL,
       p.pack_size = t.new_label
 WHERE p.is_by_product = 1;

-- ── Review: by-products NOT converted (expect no rows) ──
SELECT p.id, p.name, p.pack_size, p.volume, p.pack_type,
       CASE
         WHEN u.id IS NULL THEN 'No unit: choose the unit on the By-products tab'
         WHEN p.pack_type IS NOT NULL AND TRIM(p.pack_type) <> '' THEN 'Has a pack type: replace it with a by-product sold by the unit'
         WHEN p.volume IS NOT NULL AND p.volume NOT IN (0, 1) THEN 'Pack of more than one unit: replace it with a by-product sold by the unit'
         ELSE 'Name and unit clash with another product: rename it on the By-products tab'
       END AS action
  FROM products p
  LEFT JOIN units_of_measurement u ON u.id = p.volume_uom_id
 WHERE p.is_by_product = 1
   AND p.id NOT IN (SELECT id FROM tmp_by_unit);

-- By-products sharing a name (one name per by-product from now on). Saving
-- either one asks for a different name.
SELECT LOWER(TRIM(name)) AS name, COUNT(*) AS by_products, GROUP_CONCAT(CONCAT(id, ': ', pack_size) SEPARATOR ', ') AS ids
  FROM products
 WHERE is_by_product = 1
 GROUP BY LOWER(TRIM(name))
HAVING COUNT(*) > 1;

DROP TEMPORARY TABLE IF EXISTS tmp_by_unit;
