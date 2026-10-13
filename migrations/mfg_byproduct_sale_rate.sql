-- ============================================================================
-- Manufacturing: a by-product's sale rate is entered on the batch.
-- Run once, AFTER mfg_drafts_pack_sizes.sql and BEFORE deploying the server
-- code that reads it, then deploy the server and the client straight away.
-- There is no migration runner.
--
-- Each by-product line of a batch now carries its own purchase rate (already
-- stored in unit_cost: its value inside the batch) and sale rate (new). The
-- sale rate goes to inventory when the batch is sent. Existing lines keep NULL
-- and read the product's sale rate, as they did before.
-- ============================================================================

ALTER TABLE `mfg_batch_byproducts`
  ADD COLUMN `sale_rate` DECIMAL(12,2) NULL DEFAULT NULL AFTER `total_cost`;
