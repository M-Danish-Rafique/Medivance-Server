-- ============================================================================
-- Assets rework: Active / Retired with a reason, and current value.
-- Run once, AFTER add_assets.sql and BEFORE deploying the server code that
-- uses these columns (routes/assets.js). There is no migration runner. Not
-- safe to re-run: a second run stops at the first statement.
--
-- MySQL commits every ALTER TABLE on its own, so this file cannot run as one
-- transaction. Take a dump first; rollback = restore the dump, never
-- hand-reverse.
--
-- What changes and why:
-- 1. asset_reasons: a managed list (like asset_types / asset_owners) of why an
--    asset was retired: Sold, Disposed, Scrapped, Lost … The users add their
--    own. Seeded with common reasons.
-- 2. assets.status becomes 'active' / 'retired' (was 'in_use' / 'disposed'),
--    with reason_id on a retired asset. Existing disposed rows are retired
--    with the reason "Disposed", so nothing is lost. disposed_on /
--    disposal_note are renamed retired_on / retirement_note.
-- 3. The register now records what each asset is worth today, not what was
--    paid: unit_price / total_price are renamed unit_value / total_value, and
--    value_as_of says which date that value applies to. Existing rows were
--    entered at the purchase price, so their value_as_of is the purchase date
--    (or the day they were added when there is no purchase date).
-- 4. asset_value_log: every value change (added, edited, revalued, split),
--    shown as the value history on the asset's detail view. One opening line
--    per existing asset.
--
-- Order: drop the CHECKs that name the renamed columns (MySQL refuses to
-- rename a column a CHECK depends on) -> widen the enum -> backfill -> narrow
-- the enum and rename -> add the new CHECKs.
-- ============================================================================

-- ── Pre-flight (optional): what will be converted ──
-- SELECT status, COUNT(*) FROM assets GROUP BY status;

-- ── 1. Reasons list ──
CREATE TABLE `asset_reasons` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(40) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_asset_reasons_name` (`name`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

INSERT INTO `asset_reasons` (`name`) VALUES
  ('Sold'), ('Disposed'), ('Scrapped'), ('Damaged'), ('Lost'), ('Stolen'), ('Donated'), ('Written off');

-- ── 2. Drop the CHECKs that reference columns renamed below ──
ALTER TABLE `assets`
  DROP CHECK `chk_assets_disposal`,
  DROP CHECK `chk_assets_prices`;

-- ── 3. Status: active / retired with a reason ──
ALTER TABLE `assets`
  MODIFY COLUMN `status` ENUM('in_use','disposed','active','retired') NOT NULL DEFAULT 'active',
  ADD COLUMN `reason_id` INT NULL DEFAULT NULL AFTER `status`;

UPDATE `assets` SET `status` = 'active' WHERE `status` = 'in_use';
UPDATE `assets`
   SET `status` = 'retired',
       `reason_id` = (SELECT `id` FROM `asset_reasons` WHERE `name` = 'Disposed')
 WHERE `status` = 'disposed';

ALTER TABLE `assets`
  MODIFY COLUMN `status` ENUM('active','retired') NOT NULL DEFAULT 'active',
  RENAME COLUMN `disposed_on` TO `retired_on`,
  RENAME COLUMN `disposal_note` TO `retirement_note`;

ALTER TABLE `assets`
  ADD KEY `idx_assets_reason` (`reason_id`),
  ADD CONSTRAINT `fk_assets_reason` FOREIGN KEY (`reason_id`) REFERENCES `asset_reasons` (`id`) ON DELETE RESTRICT;

-- ── 4. Current value ──
ALTER TABLE `assets`
  RENAME COLUMN `unit_price` TO `unit_value`,
  RENAME COLUMN `total_price` TO `total_value`;

ALTER TABLE `assets`
  ADD COLUMN `value_as_of` DATE NULL DEFAULT NULL AFTER `total_value`;

UPDATE `assets` SET `value_as_of` = COALESCE(`purchase_date`, DATE(`created_at`));

ALTER TABLE `assets`
  MODIFY COLUMN `value_as_of` DATE NOT NULL;

-- ── 5. New CHECKs (after the backfill) ──
ALTER TABLE `assets`
  ADD CONSTRAINT `chk_assets_values` CHECK (`unit_value` >= 0 AND `total_value` >= 0),
  ADD CONSTRAINT `chk_assets_retired` CHECK (
    (`status` = 'retired') = (`retired_on` IS NOT NULL)
    AND (`status` = 'retired') = (`reason_id` IS NOT NULL)
  );

-- ── 6. Value history ──
CREATE TABLE `asset_value_log` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `asset_id` INT NOT NULL,
  `kind` ENUM('added','edited','revalued','split') NOT NULL,
  `valued_on` DATE NOT NULL,
  `qty` INT NOT NULL,
  `total_value` DECIMAL(14,2) NOT NULL,
  `previous_total` DECIMAL(14,2) NULL DEFAULT NULL,
  `note` VARCHAR(200) NULL DEFAULT NULL,
  `created_by` INT NULL DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_asset_value_log_asset` (`asset_id`, `valued_on`, `id`),
  CONSTRAINT `fk_asset_value_log_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_value_log_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

INSERT INTO `asset_value_log` (`asset_id`, `kind`, `valued_on`, `qty`, `total_value`, `note`, `created_by`, `created_at`)
SELECT `id`, 'added', `value_as_of`, `qty`, `total_value`, 'Entered at purchase price', `created_by`, `created_at`
  FROM `assets`;

-- ── Verification (run by hand; each should return 0 rows) ──
-- Rows whose status, reason and date disagree:
-- SELECT id, code, status, reason_id, retired_on FROM assets
--  WHERE (status = 'retired') <> (reason_id IS NOT NULL) OR (status = 'retired') <> (retired_on IS NOT NULL);
-- Assets with no history line:
-- SELECT a.id, a.code FROM assets a LEFT JOIN asset_value_log h ON h.asset_id = a.id WHERE h.id IS NULL;
-- Former disposed rows are retired with the reason "Disposed":
-- SELECT a.code, a.status, r.name FROM assets a LEFT JOIN asset_reasons r ON r.id = a.reason_id WHERE a.status = 'retired';