SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- Schema medivance
-- ----------------------------------------------------------------------------
DROP SCHEMA IF EXISTS `medivance` ;
CREATE SCHEMA IF NOT EXISTS `medivance` ;

-- ----------------------------------------------------------------------------
-- Table medivance.areas
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`areas` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `city_id` INT NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_area_city` (`city_id` ASC) VISIBLE,
  CONSTRAINT `fk_area_city`
    FOREIGN KEY (`city_id`)
    REFERENCES `medivance`.`cities` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 26
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.audit_logs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NULL DEFAULT NULL,
  `username` VARCHAR(100) NULL DEFAULT NULL,
  `action` VARCHAR(100) NOT NULL,
  `module` VARCHAR(100) NOT NULL,
  `record_id` VARCHAR(100) NULL DEFAULT NULL,
  `description` TEXT NULL DEFAULT NULL,
  `ip_address` VARCHAR(50) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_al_user` (`user_id` ASC) VISIBLE,
  INDEX `idx_al_module` (`module` ASC) VISIBLE,
  INDEX `idx_al_created` (`created_at` ASC) VISIBLE)
ENGINE = InnoDB
AUTO_INCREMENT = 2867
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.cities
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`cities` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_city_name` (`name` ASC) VISIBLE)
ENGINE = InnoDB
AUTO_INCREMENT = 6
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.companies
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`companies` (
  `id` VARCHAR(20) NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `address` TEXT NULL DEFAULT NULL,
  `phone` VARCHAR(50) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`))
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.company_settings
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`company_settings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(300) NOT NULL DEFAULT 'NUVE Care',
  `address` TEXT NULL DEFAULT NULL,
  `phone` VARCHAR(100) NULL DEFAULT NULL,
  `email` VARCHAR(200) NULL DEFAULT NULL,
  `logo_url` VARCHAR(500) NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 2
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.customer_ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`customer_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `customer_id` INT NOT NULL,
  `date` DATE NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `description` VARCHAR(500) NULL DEFAULT NULL,
  `dr` DECIMAL(12,2) NULL DEFAULT '0.00',
  `cr` DECIMAL(12,2) NULL DEFAULT '0.00',
  `balance` DECIMAL(12,2) NULL DEFAULT '0.00',
  `reference_type` ENUM('sale', 'payment', 'adjustment') NULL DEFAULT 'sale',
  `reference_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_cl_customer` (`customer_id` ASC) VISIBLE,
  CONSTRAINT `fk_cl_customer`
    FOREIGN KEY (`customer_id`)
    REFERENCES `medivance`.`customers` (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 1387
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.customers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`customers` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `address` TEXT NULL DEFAULT NULL,
  `phone` VARCHAR(50) NULL DEFAULT NULL,
  `license_no` VARCHAR(100) NULL DEFAULT NULL,
  `license_expiry` DATE NULL DEFAULT NULL,
  `is_licensed` TINYINT(1) NOT NULL DEFAULT '0' COMMENT '1 = Licensed (Pharmacy / Medical Store), 0 = Non-Licensed (Mart / General Store / Grocery Store)',
  `city_id` INT NULL DEFAULT NULL,
  `area_id` INT NULL DEFAULT NULL,
  `territory_id` INT NULL DEFAULT NULL,
  `balance` DECIMAL(12,2) NULL DEFAULT '0.00',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uniq_customer_name_location` (`name` ASC, `city_id` ASC, `area_id` ASC, `territory_id` ASC) VISIBLE,
  INDEX `fk_cust_city` (`city_id` ASC) VISIBLE,
  INDEX `fk_cust_area` (`area_id` ASC) VISIBLE,
  INDEX `fk_cust_territory` (`territory_id` ASC) VISIBLE,
  CONSTRAINT `fk_cust_area`
    FOREIGN KEY (`area_id`)
    REFERENCES `medivance`.`areas` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cust_city`
    FOREIGN KEY (`city_id`)
    REFERENCES `medivance`.`cities` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cust_territory`
    FOREIGN KEY (`territory_id`)
    REFERENCES `medivance`.`territories` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
AUTO_INCREMENT = 369
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.employees
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`employees` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `cnic` VARCHAR(20) NULL DEFAULT NULL,
  `phone` VARCHAR(50) NULL DEFAULT NULL,
  `role` ENUM('Salesman', 'Supplier') NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 10
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.expense_types
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`expense_types` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_expense_type_name` (`name` ASC) VISIBLE)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.finance
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`finance` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `date` DATE NOT NULL,
  `category` ENUM('Expense', 'Payment to Supplier', 'Payment from Customer') NOT NULL,
  `description` TEXT NULL DEFAULT NULL,
  `expense_type_id` INT NULL DEFAULT NULL,
  `supplier_id` INT NULL DEFAULT NULL,
  `customer_id` INT NULL DEFAULT NULL,
  `amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `payment_type` VARCHAR(50) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_fin_expense_type` (`expense_type_id` ASC) VISIBLE,
  INDEX `fk_fin_supplier` (`supplier_id` ASC) VISIBLE,
  INDEX `fk_fin_customer` (`customer_id` ASC) VISIBLE,
  CONSTRAINT `fk_fin_customer`
    FOREIGN KEY (`customer_id`)
    REFERENCES `medivance`.`customers` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_fin_expense_type`
    FOREIGN KEY (`expense_type_id`)
    REFERENCES `medivance`.`expense_types` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_fin_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
AUTO_INCREMENT = 6
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.inventory
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`inventory` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `qty` INT NULL DEFAULT '0',
  `purchase_rate` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `sale_rate` DECIMAL(12,2) NULL DEFAULT '0.00',
  `retail_price` DECIMAL(12,2) NULL DEFAULT '0.00',
  `exp_date` DATE NULL DEFAULT NULL,
  `low_stock_threshold` INT NULL DEFAULT '10',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_product_batch` (`product_id` ASC, `batch_no` ASC) VISIBLE,
  CONSTRAINT `fk_inv_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 137
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.inventory_movements
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`inventory_movements` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NOT NULL,
  `movement_date` DATE NOT NULL,
  `ref_type` ENUM('purchase', 'sale', 'return', 'inventory_manual', 'manufacturing', 'adjustment') NOT NULL,
  `ref_id` INT NULL DEFAULT NULL,
  `qty_in` INT NOT NULL DEFAULT '0',
  `qty_out` INT NOT NULL DEFAULT '0',
  `rate_at_movement` DECIMAL(12,4) NULL DEFAULT NULL,
  `note` VARCHAR(300) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_im_product_batch_date` (`product_id` ASC, `batch_no` ASC, `movement_date` ASC) VISIBLE,
  INDEX `idx_im_ref` (`ref_type` ASC, `ref_id` ASC) VISIBLE,
  CONSTRAINT `fk_im_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 2366
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.log_rotation_policy
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`log_rotation_policy` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `logging_enabled` TINYINT(1) NOT NULL DEFAULT '1',
  `retention_days` INT NOT NULL DEFAULT '90',
  `auto_rotate_enabled` TINYINT(1) NOT NULL DEFAULT '1',
  `last_rotated_at` TIMESTAMP NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`))
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.mfg_batch_materials
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`mfg_batch_materials` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `batch_id` INT NOT NULL,
  `raw_material_id` INT NOT NULL,
  `qty` DECIMAL(14,4) NOT NULL,
  `uom_id` INT NULL DEFAULT NULL,
  `unit_cost` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `total_cost` DECIMAL(12,2) NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  INDEX `fk_mbm_batch` (`batch_id` ASC) VISIBLE,
  INDEX `fk_mbm_rm` (`raw_material_id` ASC) VISIBLE,
  INDEX `fk_mbm_uom` (`uom_id` ASC) VISIBLE,
  CONSTRAINT `fk_mbm_batch`
    FOREIGN KEY (`batch_id`)
    REFERENCES `medivance`.`mfg_batches` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_mbm_rm`
    FOREIGN KEY (`raw_material_id`)
    REFERENCES `medivance`.`raw_materials` (`id`),
  CONSTRAINT `fk_mbm_uom`
    FOREIGN KEY (`uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.mfg_batches
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`mfg_batches` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `batch_code` VARCHAR(50) NOT NULL,
  `category_id` INT NULL DEFAULT NULL,
  `batch_date` DATE NOT NULL,
  `expiry_date` DATE NOT NULL,
  `total_volume` DECIMAL(14,4) NOT NULL,
  `volume_uom_id` INT NULL DEFAULT NULL,
  `misc_expense` DECIMAL(12,2) NULL DEFAULT '0.00',
  `raw_material_cost` DECIMAL(12,2) NULL DEFAULT '0.00',
  `total_cost` DECIMAL(12,2) NULL DEFAULT '0.00',
  `cost_per_base_unit` DECIMAL(14,8) NULL DEFAULT '0.00000000',
  `status` ENUM('open', 'yielded') NULL DEFAULT 'open',
  `notes` TEXT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_batch_code` (`batch_code` ASC) VISIBLE,
  INDEX `fk_mb_category` (`category_id` ASC) VISIBLE,
  INDEX `fk_mb_vol_uom` (`volume_uom_id` ASC) VISIBLE,
  CONSTRAINT `fk_mb_category`
    FOREIGN KEY (`category_id`)
    REFERENCES `medivance`.`product_categories` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_mb_vol_uom`
    FOREIGN KEY (`volume_uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.mfg_yield_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`mfg_yield_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `yield_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `units_manufactured` INT NOT NULL,
  `pack_volume` DECIMAL(12,4) NOT NULL,
  `pack_volume_uom_id` INT NULL DEFAULT NULL,
  `total_volume_used` DECIMAL(14,4) NOT NULL,
  `packaging_material_id` INT NULL DEFAULT NULL,
  `packaging_qty` INT NULL DEFAULT '1',
  `packaging_cost_per_unit` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `batch_cost_per_unit` DECIMAL(14,8) NULL DEFAULT '0.00000000',
  `total_unit_cost` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `unit_cost_with_tax` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `added_to_inventory` TINYINT(1) NULL DEFAULT '0',
  `batch_no` VARCHAR(100) NULL DEFAULT NULL,
  `exp_date` DATE NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_myi_yield` (`yield_id` ASC) VISIBLE,
  INDEX `fk_myi_product` (`product_id` ASC) VISIBLE,
  INDEX `fk_myi_pv_uom` (`pack_volume_uom_id` ASC) VISIBLE,
  INDEX `fk_myi_pkg_mat` (`packaging_material_id` ASC) VISIBLE,
  CONSTRAINT `fk_myi_pkg_mat`
    FOREIGN KEY (`packaging_material_id`)
    REFERENCES `medivance`.`raw_materials` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_myi_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`),
  CONSTRAINT `fk_myi_pv_uom`
    FOREIGN KEY (`pack_volume_uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_myi_yield`
    FOREIGN KEY (`yield_id`)
    REFERENCES `medivance`.`mfg_yields` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.mfg_yields
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`mfg_yields` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `yield_code` VARCHAR(50) NOT NULL,
  `batch_id` INT NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_yield_code` (`yield_code` ASC) VISIBLE,
  INDEX `fk_my_batch` (`batch_id` ASC) VISIBLE,
  CONSTRAINT `fk_my_batch`
    FOREIGN KEY (`batch_id`)
    REFERENCES `medivance`.`mfg_batches` (`id`))
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.product_categories
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`product_categories` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cat_name` (`name` ASC) VISIBLE)
ENGINE = InnoDB
AUTO_INCREMENT = 3
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.products
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`products` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `pack_size` VARCHAR(100) NOT NULL DEFAULT '',
  `volume` DECIMAL(12,4) NULL DEFAULT NULL,
  `volume_uom_id` INT NULL DEFAULT NULL,
  `purchase_rate` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `show_purchase_rate` TINYINT(1) NOT NULL DEFAULT '1',
  `sale_rate` DECIMAL(12,2) NULL DEFAULT '0.00',
  `retail_price` DECIMAL(12,2) NULL DEFAULT '0.00',
  `company_id` VARCHAR(20) NULL DEFAULT NULL,
  `category_id` INT NULL DEFAULT NULL,
  `is_manufactured` TINYINT(1) NULL DEFAULT '0',
  `tax_applicable` TINYINT(1) NULL DEFAULT '0',
  `sale_tax_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uniq_products_name_pack` (`name` ASC, `pack_size` ASC) VISIBLE,
  INDEX `fk_prod_company` (`company_id` ASC) VISIBLE,
  INDEX `fk_prod_category` (`category_id` ASC) VISIBLE,
  INDEX `fk_prod_vol_uom` (`volume_uom_id` ASC) VISIBLE,
  CONSTRAINT `fk_prod_category`
    FOREIGN KEY (`category_id`)
    REFERENCES `medivance`.`product_categories` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_prod_company`
    FOREIGN KEY (`company_id`)
    REFERENCES `medivance`.`companies` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_prod_vol_uom`
    FOREIGN KEY (`volume_uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
AUTO_INCREMENT = 110
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.purchase_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`purchase_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `purchase_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NULL DEFAULT NULL,
  `pack_size` VARCHAR(100) NULL DEFAULT NULL,
  `purchase_rate` DECIMAL(12,2) NULL DEFAULT '0.00',
  `qty` INT NULL DEFAULT '0',
  `bonus` INT NULL DEFAULT '0',
  `discount_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `tax_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `sale_tax_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `exp_date` DATE NULL DEFAULT NULL,
  `retail_price` DECIMAL(12,2) NULL DEFAULT '0.00',
  `total` DECIMAL(12,2) NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  INDEX `fk_pi_purchase` (`purchase_id` ASC) VISIBLE,
  INDEX `fk_pi_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_pi_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`),
  CONSTRAINT `fk_pi_purchase`
    FOREIGN KEY (`purchase_id`)
    REFERENCES `medivance`.`purchases` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 74
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.purchases
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`purchases` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `purchase_id` VARCHAR(30) NOT NULL,
  `supplier_id` INT NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `date` DATE NOT NULL,
  `total_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_purchase_id` (`purchase_id` ASC) VISIBLE,
  INDEX `fk_pur_supplier` (`supplier_id` ASC) VISIBLE,
  CONSTRAINT `fk_pur_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 7
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.raw_materials
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`raw_materials` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `material_type` ENUM('raw_material', 'packaging_material') NOT NULL,
  `uom_id` INT NULL DEFAULT NULL,
  `volume` DECIMAL(12,4) NULL DEFAULT NULL,
  `volume_uom_id` INT NULL DEFAULT NULL,
  `cost_per_unit` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `stock_qty` DECIMAL(14,4) NULL DEFAULT '0.0000',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rm_name` (`name` ASC) VISIBLE,
  INDEX `fk_rm_uom` (`uom_id` ASC) VISIBLE,
  INDEX `fk_rm_vol_uom` (`volume_uom_id` ASC) VISIBLE,
  CONSTRAINT `fk_rm_uom`
    FOREIGN KEY (`uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_rm_vol_uom`
    FOREIGN KEY (`volume_uom_id`)
    REFERENCES `medivance`.`units_of_measurement` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.recoveries
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`recoveries` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sale_id` INT NOT NULL,
  `salesman_id` INT NULL DEFAULT NULL,
  `date` DATE NOT NULL,
  `notes` TEXT NULL DEFAULT NULL,
  `total_discount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `total_return_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `net_collectible` DECIMAL(12,2) NULL DEFAULT '0.00',
  `net_collected` DECIMAL(12,2) NULL DEFAULT '0.00',
  `pending_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_rec_sale` (`sale_id` ASC) VISIBLE,
  INDEX `fk_rec_salesman` (`salesman_id` ASC) VISIBLE,
  CONSTRAINT `fk_rec_sale`
    FOREIGN KEY (`sale_id`)
    REFERENCES `medivance`.`sales` (`id`),
  CONSTRAINT `fk_rec_salesman`
    FOREIGN KEY (`salesman_id`)
    REFERENCES `medivance`.`employees` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
AUTO_INCREMENT = 660
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.recovery_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`recovery_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `recovery_id` INT NOT NULL,
  `sale_item_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NULL DEFAULT NULL,
  `original_total` DECIMAL(12,2) NULL DEFAULT '0.00',
  `discount_given` DECIMAL(12,2) NULL DEFAULT '0.00',
  `final_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  INDEX `fk_ri_recovery` (`recovery_id` ASC) VISIBLE,
  INDEX `fk_ri_sale_item` (`sale_item_id` ASC) VISIBLE,
  INDEX `fk_ri_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_ri_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`),
  CONSTRAINT `fk_ri_recovery`
    FOREIGN KEY (`recovery_id`)
    REFERENCES `medivance`.`recoveries` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_ri_sale_item`
    FOREIGN KEY (`sale_item_id`)
    REFERENCES `medivance`.`sale_items` (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 36
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.return_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`return_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `recovery_id` INT NOT NULL,
  `sale_id` INT NOT NULL,
  `sale_item_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NULL DEFAULT NULL,
  `qty_returned` INT NULL DEFAULT '0',
  `return_rate` DECIMAL(12,2) NULL DEFAULT '0.00',
  `return_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  INDEX `fk_ret_recovery` (`recovery_id` ASC) VISIBLE,
  INDEX `fk_ret_sale` (`sale_id` ASC) VISIBLE,
  INDEX `fk_ret_sale_item` (`sale_item_id` ASC) VISIBLE,
  INDEX `fk_ret_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_ret_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`),
  CONSTRAINT `fk_ret_recovery`
    FOREIGN KEY (`recovery_id`)
    REFERENCES `medivance`.`recoveries` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_ret_sale`
    FOREIGN KEY (`sale_id`)
    REFERENCES `medivance`.`sales` (`id`),
  CONSTRAINT `fk_ret_sale_item`
    FOREIGN KEY (`sale_item_id`)
    REFERENCES `medivance`.`sale_items` (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 208
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.rm_ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`rm_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `raw_material_id` INT NOT NULL,
  `date` DATE NOT NULL,
  `reference_type` ENUM('purchase', 'batch_usage', 'adjustment') NOT NULL,
  `reference_id` INT NULL DEFAULT NULL,
  `description` VARCHAR(300) NULL DEFAULT NULL,
  `qty_in` DECIMAL(14,4) NULL DEFAULT '0.0000',
  `qty_out` DECIMAL(14,4) NULL DEFAULT '0.0000',
  `balance_qty` DECIMAL(14,4) NULL DEFAULT '0.0000',
  `unit_cost` DECIMAL(12,4) NULL DEFAULT '0.0000',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_rml_rm` (`raw_material_id` ASC) VISIBLE,
  CONSTRAINT `fk_rml_rm`
    FOREIGN KEY (`raw_material_id`)
    REFERENCES `medivance`.`raw_materials` (`id`))
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.rm_purchases
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`rm_purchases` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `raw_material_id` INT NOT NULL,
  `supplier_id` INT NULL DEFAULT NULL,
  `date` DATE NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `qty` DECIMAL(14,4) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `unit_cost` DECIMAL(12,4) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_rmp_rm` (`raw_material_id` ASC) VISIBLE,
  INDEX `fk_rmp_supplier` (`supplier_id` ASC) VISIBLE,
  CONSTRAINT `fk_rmp_rm`
    FOREIGN KEY (`raw_material_id`)
    REFERENCES `medivance`.`raw_materials` (`id`),
  CONSTRAINT `fk_rmp_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.sale_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`sale_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sale_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  `batch_no` VARCHAR(100) NULL DEFAULT NULL,
  `pack_size` VARCHAR(100) NULL DEFAULT NULL,
  `sale_rate` DECIMAL(12,2) NULL DEFAULT '0.00',
  `purchase_rate_snapshot` DECIMAL(12,4) NULL DEFAULT NULL,
  `qty` INT NULL DEFAULT '0',
  `bonus` INT NULL DEFAULT '0',
  `discount_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `tax_pct` DECIMAL(5,2) NULL DEFAULT '0.00',
  `total` DECIMAL(12,2) NULL DEFAULT '0.00',
  `returned_qty` INT NOT NULL DEFAULT '0',
  `recovery_discount` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `recovered_amount` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  INDEX `fk_si_sale` (`sale_id` ASC) VISIBLE,
  INDEX `fk_si_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_si_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`),
  CONSTRAINT `fk_si_sale`
    FOREIGN KEY (`sale_id`)
    REFERENCES `medivance`.`sales` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 1462
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.sales
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`sales` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `invoice_no` VARCHAR(30) NOT NULL,
  `customer_id` INT NOT NULL,
  `salesman_id` INT NULL DEFAULT NULL,
  `delivery_by` INT NULL DEFAULT NULL,
  `date` DATE NOT NULL,
  `total_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `is_locked` TINYINT(1) NULL DEFAULT '0',
  `total_discount` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `total_return_amount` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `net_collectible` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `total_recovered` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `pending_amount` DECIMAL(12,2) NOT NULL DEFAULT '0.00',
  `recovery_status` ENUM('pending', 'completed') NOT NULL DEFAULT 'pending',
  `printed_at` DATETIME NULL DEFAULT NULL,
  `last_printed_type` ENUM('warranty', 'warranty10', 'non-warranty') NULL DEFAULT NULL,
  `last_printed_by` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_invoice_no` (`invoice_no` ASC) VISIBLE,
  INDEX `fk_sale_customer` (`customer_id` ASC) VISIBLE,
  INDEX `fk_sale_salesman` (`salesman_id` ASC) VISIBLE,
  INDEX `fk_sale_delivery` (`delivery_by` ASC) VISIBLE,
  INDEX `idx_sales_printed_at` (`printed_at` ASC) VISIBLE,
  CONSTRAINT `fk_sale_customer`
    FOREIGN KEY (`customer_id`)
    REFERENCES `medivance`.`customers` (`id`),
  CONSTRAINT `fk_sale_delivery`
    FOREIGN KEY (`delivery_by`)
    REFERENCES `medivance`.`employees` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_sale_salesman`
    FOREIGN KEY (`salesman_id`)
    REFERENCES `medivance`.`employees` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
AUTO_INCREMENT = 685
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.supplier_companies
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`supplier_companies` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `supplier_id` INT NOT NULL,
  `company_id` VARCHAR(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_supplier_company` (`supplier_id` ASC, `company_id` ASC) VISIBLE,
  INDEX `fk_sc_company` (`company_id` ASC) VISIBLE,
  CONSTRAINT `fk_sc_company`
    FOREIGN KEY (`company_id`)
    REFERENCES `medivance`.`companies` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_sc_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.supplier_ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`supplier_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `supplier_id` INT NOT NULL,
  `date` DATE NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `description` VARCHAR(500) NULL DEFAULT NULL,
  `dr` DECIMAL(12,2) NULL DEFAULT '0.00',
  `cr` DECIMAL(12,2) NULL DEFAULT '0.00',
  `balance` DECIMAL(12,2) NULL DEFAULT '0.00',
  `reference_type` ENUM('purchase', 'payment', 'adjustment') NULL DEFAULT 'purchase',
  `reference_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_sl_supplier` (`supplier_id` ASC) VISIBLE,
  CONSTRAINT `fk_sl_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 17
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.supplier_products
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`supplier_products` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `supplier_id` INT NOT NULL,
  `product_id` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_supplier_product` (`supplier_id` ASC, `product_id` ASC) VISIBLE,
  INDEX `fk_sp_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_sp_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_sp_supplier`
    FOREIGN KEY (`supplier_id`)
    REFERENCES `medivance`.`suppliers` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.suppliers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`suppliers` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `address` TEXT NULL DEFAULT NULL,
  `phone` VARCHAR(50) NULL DEFAULT NULL,
  `supplier_type` ENUM('product', 'raw_material', 'both') NULL DEFAULT 'product',
  `balance` DECIMAL(12,2) NULL DEFAULT '0.00',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`))
ENGINE = InnoDB
AUTO_INCREMENT = 6
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.tax_ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`tax_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `sale_id` INT NULL DEFAULT NULL,
  `sale_item_id` INT NULL DEFAULT NULL,
  `product_id` INT NULL DEFAULT NULL,
  `sale_date` DATE NOT NULL,
  `invoice_no` VARCHAR(100) NULL DEFAULT NULL,
  `taxable_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `tax_rate` DECIMAL(5,2) NULL DEFAULT '0.00',
  `tax_amount` DECIMAL(12,2) NULL DEFAULT '0.00',
  `submitted_to_fbr` TINYINT(1) NULL DEFAULT '0',
  `fbr_submission_date` DATE NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_tl_sale` (`sale_id` ASC) VISIBLE,
  INDEX `fk_tl_product` (`product_id` ASC) VISIBLE,
  CONSTRAINT `fk_tl_product`
    FOREIGN KEY (`product_id`)
    REFERENCES `medivance`.`products` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_tl_sale`
    FOREIGN KEY (`sale_id`)
    REFERENCES `medivance`.`sales` (`id`)
    ON DELETE SET NULL)
ENGINE = InnoDB
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.territories
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`territories` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `area_id` INT NOT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_terr_area` (`area_id` ASC) VISIBLE,
  CONSTRAINT `fk_terr_area`
    FOREIGN KEY (`area_id`)
    REFERENCES `medivance`.`areas` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 117
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.units_of_measurement
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`units_of_measurement` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `symbol` VARCHAR(20) NOT NULL,
  `base_type` ENUM('count', 'weight', 'volume') NOT NULL,
  `to_base_factor` DECIMAL(18,8) NOT NULL DEFAULT '1.00000000',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_uom_name` (`name` ASC) VISIBLE)
ENGINE = InnoDB
AUTO_INCREMENT = 4
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.user_permissions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`user_permissions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `perm_companies` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_products` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_employees` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_geography` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_customers` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_suppliers` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_purchase` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_view_purchase_rate` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_sale` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_inventory` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_recovery` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_mfg_products` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_mfg_raw_materials` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_mfg_batches` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_mfg_yields` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_finance` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_reports` TINYINT(1) NOT NULL DEFAULT '0',
  `perm_tax_ledger` TINYINT(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_user_permissions` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_up_user`
    FOREIGN KEY (`user_id`)
    REFERENCES `medivance`.`users` (`id`)
    ON DELETE CASCADE)
ENGINE = InnoDB
AUTO_INCREMENT = 4
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- Table medivance.users
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medivance`.`users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(100) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `full_name` VARCHAR(200) NOT NULL,
  `role` ENUM('admin', 'user') NULL DEFAULT 'admin',
  `is_active` TINYINT(1) NULL DEFAULT '1',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_username` (`username` ASC) VISIBLE)
ENGINE = InnoDB
AUTO_INCREMENT = 5
DEFAULT CHARACTER SET = utf8mb4
COLLATE = utf8mb4_0900_ai_ci;
SET FOREIGN_KEY_CHECKS = 1;
