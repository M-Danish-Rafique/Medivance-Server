-- ============================================================================
-- Master Data employees: Active / Inactive status
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the code that reads it. There is no migration runner.
-- Independent of the HR migrations; safe to apply in any order after them.
--
-- An Inactive Salesman or Supplier no longer appears in any picker (invoice
-- form, recovery form, list filters, report filters). History is untouched:
-- invoices, recoveries, prints and report results still show the person and
-- include their figures, because every historical query joins `employees`
-- without filtering on status. GET /employees returns Active rows only
-- unless ?include_inactive=1, so a picker that was missed fails safe.
--
-- deactivated_at / deactivated_by record the latest deactivation and are
-- cleared on reactivation. They are set by PUT /employees/:id/status, or by
-- PUT /hr/employees/:id with sync_master when HR changes the linked person's
-- status in the same transaction.
--
-- Every existing row becomes Active through the column default.
-- ============================================================================

ALTER TABLE `employees`
  ADD COLUMN `status` ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active' AFTER `role`,
  ADD COLUMN `deactivated_at` DATETIME NULL DEFAULT NULL AFTER `status`,
  ADD COLUMN `deactivated_by` INT NULL DEFAULT NULL AFTER `deactivated_at`,
  ADD KEY `idx_employees_status` (`status`),
  ADD KEY `fk_employees_deactivated_by` (`deactivated_by`),
  ADD CONSTRAINT `fk_employees_deactivated_by` FOREIGN KEY (`deactivated_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL;
