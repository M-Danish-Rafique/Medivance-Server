-- ============================================================================
-- Workforce Management (HR & Payroll) module
-- Run once on existing databases (Railway MySQL console or mysql CLI),
-- BEFORE deploying the code that needs it. There is no migration runner.
--
-- Nothing here touches `employees` -- that table stays Master Data for
-- Sales/Purchase attribution (sales.salesman_id, sales.delivery_by,
-- recoveries.salesman_id). HR profiles live in `hr_employees` and merely
-- point at it via a nullable, ON DELETE SET NULL FK.
-- ============================================================================

-- --- Lookups ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `departments` (
  `id`   INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_department_name` (`name`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `designations` (
  `id`   INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_designation_name` (`name`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --- Core HR profile --------------------------------------------------------
-- `employee_id` is system-generated once at creation (EMP-0001, EMP-0002, ...)
-- and is never editable -- the UNIQUE index is the backstop, the route
-- handler refuses to update the column.
--
-- `date_of_leaving` / `reason_for_leaving` stay NULLable because they are
-- legitimately NULL for every Active employee. The "required when Inactive"
-- rule is therefore conditional and cannot be expressed as a column
-- constraint; routes/hrEmployees.js enforces it in the handler.
CREATE TABLE IF NOT EXISTS `hr_employees` (
  `id`                   INT NOT NULL AUTO_INCREMENT,
  `employee_id`          VARCHAR(20) NOT NULL,
  `master_employee_id`   INT NULL DEFAULT NULL,
  `name`                 VARCHAR(200) NOT NULL,
  `father_name`          VARCHAR(200) NULL DEFAULT NULL,
  `cnic`                 VARCHAR(20) NULL DEFAULT NULL,
  `date_of_birth`        DATE NULL DEFAULT NULL,
  `gender`               ENUM('Male','Female','Other') NULL DEFAULT NULL,
  `email`                VARCHAR(200) NULL DEFAULT NULL,
  `mobile`               VARCHAR(50) NOT NULL,
  `alternate_mobile`     VARCHAR(50) NULL DEFAULT NULL,
  `address`              TEXT NULL DEFAULT NULL,
  `city_id`              INT NULL DEFAULT NULL,

  `date_of_joining`      DATE NOT NULL,
  `department_id`        INT NOT NULL,
  `designation_id`       INT NOT NULL,
  `status`               ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  `reporting_manager_id` INT NULL DEFAULT NULL,
  `date_of_leaving`      DATE NULL DEFAULT NULL,
  `reason_for_leaving`   TEXT NULL DEFAULT NULL,
  `is_field_employee`    TINYINT(1) NOT NULL DEFAULT 0,

  `bank_name`            VARCHAR(200) NULL DEFAULT NULL,
  `account_title`        VARCHAR(200) NULL DEFAULT NULL,
  `account_number`       VARCHAR(100) NULL DEFAULT NULL,
  `iban`                 VARCHAR(50) NULL DEFAULT NULL,

  `created_at`           TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hr_employee_id` (`employee_id`),
  KEY `idx_hr_status` (`status`),
  KEY `fk_hr_master`  (`master_employee_id`),
  KEY `fk_hr_city`    (`city_id`),
  KEY `fk_hr_dept`    (`department_id`),
  KEY `fk_hr_desig`   (`designation_id`),
  KEY `fk_hr_manager` (`reporting_manager_id`),
  CONSTRAINT `fk_hr_master`  FOREIGN KEY (`master_employee_id`)   REFERENCES `employees` (`id`)    ON DELETE SET NULL,
  CONSTRAINT `fk_hr_city`    FOREIGN KEY (`city_id`)              REFERENCES `cities` (`id`)       ON DELETE SET NULL,
  CONSTRAINT `fk_hr_dept`    FOREIGN KEY (`department_id`)        REFERENCES `departments` (`id`),
  CONSTRAINT `fk_hr_desig`   FOREIGN KEY (`designation_id`)       REFERENCES `designations` (`id`),
  CONSTRAINT `fk_hr_manager` FOREIGN KEY (`reporting_manager_id`) REFERENCES `hr_employees` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --- Compensation -----------------------------------------------------------
-- Live/default components. Editing these NEVER rewrites an already-generated
-- salary slip; a slip snapshots its own earnings/deductions into JSON.
CREATE TABLE IF NOT EXISTS `salary_components` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `type`        ENUM('Earning','Deduction') NOT NULL,
  `title`       VARCHAR(200) NOT NULL,
  `amount`      DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `fk_sc_employee` (`employee_id`),
  CONSTRAINT `fk_sc_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- One live target per field employee. Deliberately NO month dimension --
-- the month-specific figure is snapshotted onto the salary slip instead.
CREATE TABLE IF NOT EXISTS `sales_targets` (
  `employee_id`   INT NOT NULL,
  `target_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `updated_at`    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_id`),
  CONSTRAINT `fk_st_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --- Loans / advances -------------------------------------------------------
-- remaining_balance is ALWAYS derived as
--   principal_amount - COALESCE(SUM(loan_repayments.amount), 0)
-- and is never stored, so it cannot drift from the repayment journal.
CREATE TABLE IF NOT EXISTS `loans` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `employee_id`      INT NOT NULL,
  `title`            VARCHAR(200) NOT NULL,
  `principal_amount` DECIMAL(12,2) NOT NULL,
  `date_issued`      DATE NOT NULL,
  `created_at`       TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_loan_employee` (`employee_id`),
  CONSTRAINT `fk_loan_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `loan_repayments` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `loan_id`        INT NOT NULL,
  `salary_slip_id` INT NOT NULL,
  `amount`         DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_lr_loan` (`loan_id`),
  KEY `fk_lr_slip` (`salary_slip_id`),
  CONSTRAINT `fk_lr_loan` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --- Payroll ----------------------------------------------------------------
-- A payroll run is one month's session. The operator opens it, adds a slip per
-- employee, corrects whatever needs correcting, then completes it. Completion
-- is the point at which that month's slips become permanently read-only.
--
-- One run per month (uq_payroll_month), which is what lets salary_slips.month
-- carry a real FK straight to it: a slip cannot exist for a month with no run,
-- and a run holding slips cannot be dropped (no ON DELETE action = RESTRICT).
-- There is deliberately no "reopen" path.
CREATE TABLE IF NOT EXISTS `payroll_runs` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `month`        VARCHAR(7) NOT NULL,
  `status`       ENUM('Open','Completed') NOT NULL DEFAULT 'Open',
  `opened_at`    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `opened_by`    INT NULL DEFAULT NULL,
  `completed_at` DATETIME NULL DEFAULT NULL,
  `completed_by` INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payroll_month` (`month`),
  KEY `fk_run_opened_by` (`opened_by`),
  KEY `fk_run_completed_by` (`completed_by`),
  CONSTRAINT `fk_run_opened_by`    FOREIGN KEY (`opened_by`)    REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_run_completed_by` FOREIGN KEY (`completed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- A slip is editable only while its run is Open. Once the run is Completed the
-- earnings/deductions/target/net_pay figures are frozen for good, and later
-- edits to salary_components / sales_targets / loans must never change what a
-- completed slip prints. Slips are never deletable, during or after a run.
CREATE TABLE IF NOT EXISTS `salary_slips` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `employee_id`     INT NOT NULL,
  `month`           VARCHAR(7) NOT NULL,
  `earnings_json`   JSON NOT NULL,
  `deductions_json` JSON NOT NULL,
  `target_amount`   DECIMAL(12,2) NULL DEFAULT NULL,
  `target_achieved` DECIMAL(12,2) NULL DEFAULT NULL,
  `net_pay`         DECIMAL(12,2) NOT NULL,
  `generated_at`    TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employee_month` (`employee_id`, `month`),
  KEY `idx_slip_month` (`month`),
  CONSTRAINT `fk_slip_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  -- FK to a UNIQUE non-PK column: keeps slip.month and its run in lockstep
  -- without duplicating a payroll_run_id alongside the month.
  CONSTRAINT `fk_slip_run` FOREIGN KEY (`month`) REFERENCES `payroll_runs` (`month`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Deferred until salary_slips exists (loan_repayments is created first so the
-- table ordering matches the module spec).
ALTER TABLE `loan_repayments`
  ADD CONSTRAINT `fk_lr_slip` FOREIGN KEY (`salary_slip_id`) REFERENCES `salary_slips` (`id`) ON DELETE CASCADE;

-- --- Attendance -------------------------------------------------------------
-- uq_employee_date is the real duplicate guard; the route catches
-- ER_DUP_ENTRY and translates it into a 409 with a readable message.
CREATE TABLE IF NOT EXISTS `attendance_records` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `date`        DATE NOT NULL,
  `status`      ENUM('P','A') NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employee_date` (`employee_id`, `date`),
  KEY `idx_attendance_date` (`date`),
  CONSTRAINT `fk_att_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Area tagging reuses the existing geography tables; only field employees
-- ever get rows here.
CREATE TABLE IF NOT EXISTS `attendance_areas` (
  `attendance_id` INT NOT NULL,
  `area_id`       INT NOT NULL,
  PRIMARY KEY (`attendance_id`, `area_id`),
  KEY `fk_aa_area` (`area_id`),
  CONSTRAINT `fk_aa_attendance` FOREIGN KEY (`attendance_id`) REFERENCES `attendance_records` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_aa_area`       FOREIGN KEY (`area_id`)       REFERENCES `areas` (`id`)              ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- --- Permissions ------------------------------------------------------------
-- Three new module flags, wired into routes/admin.js (GET/POST/PUT column
-- lists), the Profile.jsx permission grid, Sidebar.jsx nav gating and the
-- new requirePermission middleware.
ALTER TABLE `user_permissions`
  ADD COLUMN `perm_hr_employees`  TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `perm_hr_attendance` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `perm_hr_payroll`    TINYINT(1) NOT NULL DEFAULT 0;

-- --- Seed data --------------------------------------------------------------
-- A brand-new install has no departments/designations, and hr_employees
-- requires both as NOT NULL -- so creating the very first employee would be
-- impossible without these. Safe to re-run.
INSERT IGNORE INTO `departments` (`name`) VALUES
  ('Sales'), ('Distribution'), ('Warehouse'), ('Accounts'), ('Administration');

INSERT IGNORE INTO `designations` (`name`) VALUES
  ('Sales Officer'), ('Order Booker'), ('Delivery Rider'), ('Warehouse Assistant'), ('Accountant');
