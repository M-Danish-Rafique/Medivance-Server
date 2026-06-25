-- Run once on existing databases (Railway MySQL console or mysql CLI)
ALTER TABLE `recoveries`
  ADD COLUMN `net_collectible` DECIMAL(12,2) NULL DEFAULT 0.00 AFTER `total_return_amount`,
  ADD COLUMN `pending_amount`   DECIMAL(12,2) NULL DEFAULT 0.00 AFTER `net_collected`;

UPDATE `recoveries`
SET
  `net_collectible` = COALESCE(NULLIF(`net_collectible`, 0), `net_collected` + COALESCE(`total_discount`, 0) + COALESCE(`total_return_amount`, 0)),
  `pending_amount`  = 0
WHERE `net_collectible` IS NULL OR `net_collectible` = 0;
