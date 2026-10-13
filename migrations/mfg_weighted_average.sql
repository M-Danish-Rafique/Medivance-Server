-- ============================================================================
-- Manufacturing: material rates become weighted averages.
-- Run AFTER mfg_pack_types.sql and BEFORE deploying the server code. There
-- is no migration runner. Safe to re-run (it only recalculates).
--
-- Until now every purchase overwrote a material's rate with its own landed
-- rate, so stock bought earlier was revalued at the newest price. From now on
--   new rate = (max(stock before, 0) × rate + qty × landed rate) ÷ (stock before + qty)
-- on each purchase line, and using stock in a batch does not change it.
--
-- 1. Every material that has purchases gets the average rebuilt from its
--    stock ledger (rm_ledger) in date order, then the order the rows were
--    written: purchases move the average, batch deductions only reduce stock.
--    This mirrors replayAverageRate() in server/utils/manufacturing.js.
--    Materials with no purchases keep the rate typed for them.
-- 2. Review 1 lists each material whose rate changed (old and new).
-- 3. Review 2 lists batches that are still "Ready for inventory" and took a
--    material at a rate other than its average at that point. Batches keep
--    the cost they froze; to re-cost one, delete it and create it again
--    before it is sent to inventory. Batches already in inventory stay as
--    they are.
-- ============================================================================

SET SESSION cte_max_recursion_depth = 1000000;

DROP TEMPORARY TABLE IF EXISTS `tmp_rm_replay`;
DROP TEMPORARY TABLE IF EXISTS `tmp_rm_last`;
CREATE TEMPORARY TABLE `tmp_rm_replay` (
  `raw_material_id` INT NOT NULL,
  `n` INT NOT NULL,
  `ledger_id` INT NOT NULL,
  `reference_type` VARCHAR(20) NOT NULL,
  `reference_id` INT NULL,
  `unit_cost` DECIMAL(12,4) NULL,
  `stock_after` DECIMAL(20,4) NULL,
  `rate_before` DECIMAL(20,4) NULL,
  `rate_after` DECIMAL(20,4) NULL,
  PRIMARY KEY (`raw_material_id`, `n`)
);

INSERT INTO `tmp_rm_replay`
WITH RECURSIVE seq AS (
  SELECT l.id, l.raw_material_id, l.reference_type, l.reference_id,
         COALESCE(l.qty_in, 0) AS qty_in, COALESCE(l.qty_out, 0) AS qty_out, COALESCE(l.unit_cost, 0) AS unit_cost,
         ROW_NUMBER() OVER (PARTITION BY l.raw_material_id ORDER BY l.date, l.created_at, l.id) AS n
    FROM rm_ledger l
),
run AS (
  SELECT s.raw_material_id, s.n, s.id AS ledger_id, CAST(s.reference_type AS CHAR(20)) AS reference_type, s.reference_id, s.unit_cost,
         CAST(s.qty_in - s.qty_out AS DECIMAL(20,4)) AS stock_after,
         CAST(NULL AS DECIMAL(20,4)) AS rate_before,
         CAST(CASE WHEN s.qty_in > 0 THEN s.unit_cost END AS DECIMAL(20,4)) AS rate_after
    FROM seq s WHERE s.n = 1
  UNION ALL
  SELECT s.raw_material_id, s.n, s.id, s.reference_type, s.reference_id, s.unit_cost,
         r.stock_after + s.qty_in - s.qty_out,
         r.rate_after,
         CASE
           WHEN s.qty_in <= 0 THEN r.rate_after
           WHEN r.rate_after IS NULL OR GREATEST(r.stock_after, 0) <= 0 THEN s.unit_cost
           ELSE ROUND((GREATEST(r.stock_after, 0) * r.rate_after + s.qty_in * s.unit_cost) / (GREATEST(r.stock_after, 0) + s.qty_in), 4)
         END
    FROM run r
    JOIN seq s ON s.raw_material_id = r.raw_material_id AND s.n = r.n + 1
)
SELECT raw_material_id, n, ledger_id, reference_type, reference_id, unit_cost, stock_after, rate_before, rate_after FROM run;

-- The last ledger row of each material carries its average now.
DROP TEMPORARY TABLE IF EXISTS `tmp_rm_last`;
CREATE TEMPORARY TABLE `tmp_rm_last` (`raw_material_id` INT NOT NULL PRIMARY KEY, `n` INT NOT NULL);
INSERT INTO `tmp_rm_last` SELECT raw_material_id, MAX(n) FROM tmp_rm_replay GROUP BY raw_material_id;

-- ── Review 1: materials whose rate changes (run before the UPDATE below) ──
SELECT rm.id, rm.name, rm.cost_per_unit AS old_rate, f.rate_after AS average_rate, rm.stock_qty,
       'Rate recalculated as the weighted average of purchases' AS action
  FROM raw_materials rm
  JOIN tmp_rm_last last ON last.raw_material_id = rm.id
  JOIN tmp_rm_replay f ON f.raw_material_id = rm.id AND f.n = last.n
 WHERE f.rate_after IS NOT NULL AND ABS(rm.cost_per_unit - f.rate_after) > 0.00005
 ORDER BY rm.name;

UPDATE raw_materials rm
  JOIN tmp_rm_last last ON last.raw_material_id = rm.id
  JOIN tmp_rm_replay f ON f.raw_material_id = rm.id AND f.n = last.n
   SET rm.cost_per_unit = f.rate_after
 WHERE f.rate_after IS NOT NULL;

-- ── Review 2: ready batches costed at a rate other than the average then ──
SELECT DISTINCT b.id AS batch_id, b.batch_code, b.product_name, rm.name AS material,
       t.unit_cost AS costed_at, t.rate_before AS average_then,
       'Delete the batch and create it again to cost it at the average' AS action
  FROM tmp_rm_replay t
  JOIN mfg_batches b ON b.id = t.reference_id AND b.status = 'ready'
  JOIN raw_materials rm ON rm.id = t.raw_material_id
 WHERE t.reference_type = 'mfg_batch'
   AND t.rate_before IS NOT NULL AND ABS(t.unit_cost - t.rate_before) > 0.00005
 ORDER BY b.batch_code, rm.name;

DROP TEMPORARY TABLE IF EXISTS `tmp_rm_replay`;
DROP TEMPORARY TABLE IF EXISTS `tmp_rm_last`;
