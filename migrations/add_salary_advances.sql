-- ============================================================================
-- Payroll: advance salary, and the pending-loan figure on a payslip
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the code that reads it. There is no migration runner.
-- Requires add_hr_module.sql (and add_payroll_ctc.sql) to have been applied.
--
-- An ADVANCE is part of a month's salary paid early. It is not a loan: it is
-- recorded on the employee's profile against the pay period it will be taken
-- from, and that month's payslip always deducts ALL of it — the operator
-- cannot change the figure on the payslip.
--
--   Net salary  = gross earnings - deductions (tax, fines, loan repayments…)
--   Net payable = net salary - advance         (salary_slips.net_pay)
--
-- `month` is the pay period the advance is deducted from. It is the current
-- PKT month, or the next one once the current month's Pay Run is closed. It is
-- deliberately NOT a FK to payroll_runs: an advance is usually taken before
-- its month's run has been started.
--
-- Several advances may be taken in one month; the payslip deducts their sum.
-- An advance can be removed only while its month's Pay Run is not closed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `salary_advances` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `month`       VARCHAR(7) NOT NULL,
  `amount`      DECIMAL(12,2) NOT NULL,
  `date_given`  DATE NOT NULL,
  `note`        VARCHAR(200) NULL DEFAULT NULL,
  `created_by`  INT NULL DEFAULT NULL,
  `created_at`  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_advance_employee_month` (`employee_id`, `month`),
  KEY `fk_advance_created_by` (`created_by`),
  CONSTRAINT `fk_advance_employee`   FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_advance_created_by` FOREIGN KEY (`created_by`)  REFERENCES `users` (`id`)        ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- advance_amount: the month's advances as deducted on this payslip (always the
--   SUM of salary_advances for the employee + month; kept in step whenever an
--   advance is recorded or removed while the run is open). 0 on every
--   existing slip, so net_pay keeps meaning exactly what it meant before.
-- loan_balance: total loan still owed AFTER this payslip's repayments, as it
--   stood when the slip was last written. NULL on slips written before this
--   migration — the printed slip leaves the line out for them.
ALTER TABLE `salary_slips`
  ADD COLUMN `advance_amount` DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER `target_achieved`,
  ADD COLUMN `loan_balance`   DECIMAL(12,2) NULL DEFAULT NULL AFTER `advance_amount`;
