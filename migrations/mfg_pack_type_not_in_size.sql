-- ============================================================================
-- Manufacturing: the pack type leaves the pack size (owner 2026-10-15).
-- A manufactured product's pack_size was "200 ml Glass Bottle"; invoices, sales,
-- inventory and reports print pack_size beside the name, so the pack type read
-- as part of the product name. pack_size is now number + unit only ("200 ml");
-- the pack type stays on the product (pack_type_id / pack_type) for
-- Manufacturing.
--
-- Data only, no schema change. Run once, straight AFTER deploying the server
-- code of the same change (the old server would put the pack type back on the
-- next save of a product). Safe to re-run.
--
-- 1. Every manufactured product (not by-products) gets pack_size rebuilt from
--    volume + unit, exactly as the server builds it.
-- 2. A rebuilt label that would collide with another product of the same name
--    (UNIQUE uniq_products_name_pack: two pack types of one size, or a
--    distribution product) is NOT written; the product keeps its label and is
--    listed by review 1. Rename one product (or delete an unused one) on the
--    Manufactured Products screen, then run this script again.
-- 3. Review 2 lists products of one name and the same size in base units
--    (1 L and 1000 ml). They are no longer told apart by pack type, so the
--    form refuses to save either until one is renamed, resized or deleted.
-- 4. products.pack_type (the copy of the pack type's name) is re-synced with
--    mfg_pack_types, which may now be renamed while in use.
-- Invoice and purchase lines keep the pack size they were entered with.
-- ============================================================================

UPDATE products p
  JOIN mfg_pack_types t ON t.id = p.pack_type_id
   SET p.pack_type = t.name
 WHERE NOT (p.pack_type <=> t.name COLLATE utf8mb4_bin);

-- "200.0000" -> "200", "0.5000" -> "0.5", plus the unit symbol (volume is DECIMAL(12,4)).
CREATE TEMPORARY TABLE `mfg_size_labels` AS
  SELECT p.id, p.name, p.pack_size AS old_label,
         CONCAT(TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(p.volume AS CHAR))), ' ', u.symbol) AS label
    FROM products p
    JOIN units_of_measurement u ON u.id = p.volume_uom_id
   WHERE p.is_manufactured = 1 AND p.is_by_product = 0 AND p.volume > 0;

-- (A temporary table cannot be opened twice in one query, hence the counts.)
CREATE TEMPORARY TABLE `mfg_size_label_counts` AS
  SELECT LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))) AS n, LOWER(label) AS lb, COUNT(*) AS c
    FROM mfg_size_labels
   GROUP BY LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))), LOWER(label);

-- Clashes: two rebuilt products with one name + label, or a product outside
-- the rebuilt set (distribution product, by-product) already holding it.
CREATE TEMPORARY TABLE `mfg_size_clash` AS
  SELECT l.id FROM mfg_size_labels l
    JOIN mfg_size_label_counts k
      ON k.n = LOWER(TRIM(REGEXP_REPLACE(l.name, '[[:space:]]+', ' '))) AND k.lb = LOWER(l.label)
   WHERE k.c > 1
      OR EXISTS (SELECT 1 FROM products o
                  WHERE o.id <> l.id
                    AND NOT (o.is_manufactured = 1 AND o.is_by_product = 0 AND o.volume > 0
                             AND EXISTS (SELECT 1 FROM units_of_measurement u WHERE u.id = o.volume_uom_id))
                    AND LOWER(TRIM(REGEXP_REPLACE(o.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(l.name, '[[:space:]]+', ' ')))
                    AND LOWER(TRIM(o.pack_size)) = LOWER(l.label));

UPDATE products p
  JOIN mfg_size_labels l ON l.id = p.id
   SET p.pack_size = l.label
 WHERE p.pack_size <> l.label
   AND p.id NOT IN (SELECT id FROM mfg_size_clash);

-- ── Review 1: not converted, the label would clash (expect no rows) ─────────
-- clashes_with = the product(s) already holding that name and size.
SELECT l.id, l.name, l.old_label AS kept_pack_size, l.label AS new_pack_size,
       (SELECT GROUP_CONCAT(CONCAT('#', o.id, ' ', o.pack_size) ORDER BY o.id SEPARATOR ', ')
          FROM products o JOIN products me ON me.id = l.id
         WHERE o.id <> me.id
           AND LOWER(TRIM(REGEXP_REPLACE(o.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(me.name, '[[:space:]]+', ' ')))
           AND (LOWER(TRIM(o.pack_size)) = LOWER(l.label)
                OR (o.is_manufactured = 1 AND o.is_by_product = 0 AND o.volume = me.volume AND o.volume_uom_id = me.volume_uom_id))
       ) AS clashes_with,
       'Rename one of the two products (or delete an unused one), then run the script again' AS action
  FROM mfg_size_labels l
 WHERE l.id IN (SELECT id FROM mfg_size_clash)
   AND l.old_label <> l.label
 ORDER BY l.name, l.id;

-- ── Review 2: one name, the same size in base units (expect no rows) ────────
SELECT a.id, a.name, a.pack_size, b.id AS same_size_as_id, b.pack_size AS same_size_as
  FROM products a
  JOIN units_of_measurement ua ON ua.id = a.volume_uom_id
  JOIN products b ON b.id > a.id AND b.is_manufactured = 1 AND b.is_by_product = 0
                 AND LOWER(TRIM(REGEXP_REPLACE(b.name, '[[:space:]]+', ' '))) = LOWER(TRIM(REGEXP_REPLACE(a.name, '[[:space:]]+', ' ')))
  JOIN units_of_measurement ub ON ub.id = b.volume_uom_id AND ub.base_type = ua.base_type
 WHERE a.is_manufactured = 1 AND a.is_by_product = 0
   AND ABS(a.volume * ua.to_base_factor - b.volume * ub.to_base_factor) < 0.000001
 ORDER BY a.name, a.id;

DROP TEMPORARY TABLE `mfg_size_clash`;
DROP TEMPORARY TABLE `mfg_size_label_counts`;
DROP TEMPORARY TABLE `mfg_size_labels`;
