-- ============================================================================
-- Payroll: monthly Cost to Company on the Pay Run
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the code that reads it. There is no migration runner.
-- Requires add_hr_module.sql to have been applied first.
--
-- One Cost to Company figure per MONTH, recorded on that month's Pay Run when
-- it is closed. The close dialog pre-fills it with the calculated figure — the
-- total gross earnings of the run's payslips — and the operator may edit it.
-- Like the payslips, it is fixed once the run is Completed.
--
-- NULL = not recorded: every run still Open, and runs closed before this
-- column existed (the UI shows their calculated figure instead).
--
-- Deductions never reduce it: tax withheld is still the company's money (paid
-- to FBR), and a loan/advance recovery settles money already lent.
-- ============================================================================

ALTER TABLE `payroll_runs`
  ADD COLUMN `cost_to_company` DECIMAL(14,2) NULL DEFAULT NULL AFTER `completed_by`;
