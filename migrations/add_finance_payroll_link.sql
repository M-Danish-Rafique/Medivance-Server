-- ============================================================================
-- Finance: the Salary Expense posted when a Pay Run is closed
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the code that reads it. There is no migration runner.
-- Requires add_hr_module.sql, add_payroll_ctc.sql and add_salary_advances.sql
-- to have been applied first.
--
-- Closing a Pay Run (PUT /hr/payroll-runs/:id/complete) inserts ONE finance
-- row in the same transaction that closes the run:
--   category 'Expense', expense type 'Salaries and Wages',
--   amount = payroll_runs.cost_to_company (the operator's figure if edited),
--   date = the PKT day the run was closed,
--   description "Salary Expense — October 2026".
-- No row is written when the cost to company is 0.
--
-- payroll_run_id links that row to its run. UNIQUE, so a run can never post
-- twice. NULL on every other finance row (manual entries). Rows carrying it
-- cannot be deleted (DELETE /finance/:id answers 409): runs cannot be
-- reopened, so a correction is recorded as a separate entry.
--
-- ON DELETE RESTRICT: a run that has posted to Finance can never be dropped.
-- (A run holding payslips already cannot be, via fk_slip_run.)
-- ============================================================================

ALTER TABLE `finance`
  ADD COLUMN `payroll_run_id` INT NULL DEFAULT NULL AFTER `payment_type`,
  ADD UNIQUE KEY `uq_finance_payroll_run` (`payroll_run_id`),
  ADD CONSTRAINT `fk_finance_payroll_run` FOREIGN KEY (`payroll_run_id`)
    REFERENCES `payroll_runs` (`id`) ON DELETE RESTRICT;

-- The expense head the Salary Expense is filed under. The close handler also
-- creates it on demand (INSERT … ON DUPLICATE KEY), so this only makes it
-- available in the Finance screen straight away. Matching is by the unique,
-- case-insensitive name: an existing "Salaries and Wages" is reused.
INSERT IGNORE INTO `expense_types` (`name`) VALUES ('Salaries and Wages');
