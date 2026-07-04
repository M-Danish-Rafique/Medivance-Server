-- =============================================================================
--  MEDIVANCE ERP — Database Schema
--  Engine  : MySQL 8.0
--  Charset : utf8mb4_unicode_ci
-- =============================================================================

SET FOREIGN_KEY_CHECKS = 0;


-- =============================================================================
--  1. REFERENCE & LOOKUP TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
--  cities
--  Top-level geographic unit. Customers and areas are linked here.
-- -----------------------------------------------------------------------------
CREATE TABLE `cities` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)  NOT NULL,
  `created_at` TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_city_name` (`name`)
);


-- -----------------------------------------------------------------------------
--  areas
--  Sub-division of a city. Cascade-deleted when parent city is removed.
-- -----------------------------------------------------------------------------
CREATE TABLE `areas` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)  NOT NULL,
  `city_id`    INT           NOT NULL,
  `created_at` TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_area_city` FOREIGN KEY (`city_id`) REFERENCES `cities` (`id`) ON DELETE CASCADE
);


-- -----------------------------------------------------------------------------
--  territories
--  Finest geographic unit. Belongs to one area (cascade delete).
-- -----------------------------------------------------------------------------
CREATE TABLE `territories` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)  NOT NULL,
  `area_id`    INT           NOT NULL,
  `created_at` TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_terr_area` FOREIGN KEY (`area_id`) REFERENCES `areas` (`id`) ON DELETE CASCADE
);


-- -----------------------------------------------------------------------------
--  units_of_measurement
--  UOM master used across inventory, manufacturing, and raw materials.
--  to_base_factor: multiplier to convert to base SI unit (ml, g, pcs).
-- -----------------------------------------------------------------------------
CREATE TABLE `units_of_measurement` (
  `id`             INT                              NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(100)                     NOT NULL,
  `symbol`         VARCHAR(20)                      NOT NULL,
  `base_type`      ENUM('count', 'weight', 'volume') NOT NULL,
  `to_base_factor` DECIMAL(18, 8)                   NOT NULL DEFAULT 1.00000000,
  `created_at`     TIMESTAMP                        NULL     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_uom_name` (`name`)
);


-- -----------------------------------------------------------------------------
--  product_categories
--  Categories for manufactured products (e.g. Hair Oil, Serum).
-- -----------------------------------------------------------------------------
CREATE TABLE `product_categories` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200) NOT NULL,
  `created_at` TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cat_name` (`name`)
);


-- -----------------------------------------------------------------------------
--  expense_types
--  Lookup for expense categories used in the finance module.
-- -----------------------------------------------------------------------------
CREATE TABLE `expense_types` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200) NOT NULL,
  `created_at` TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_expense_type_name` (`name`)
);


-- =============================================================================
--  2. MASTER DATA
-- =============================================================================

-- -----------------------------------------------------------------------------
--  companies
--  Pharmaceutical brands/manufacturers whose products are sold or distributed.
-- -----------------------------------------------------------------------------
CREATE TABLE `companies` (
  `id`         VARCHAR(20)  NOT NULL,   -- manual format e.g. MVC-0001
  `name`       VARCHAR(200) NOT NULL,
  `address`    TEXT         NULL,
  `phone`      VARCHAR(50)  NULL,
  `created_at` TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


-- -----------------------------------------------------------------------------
--  users
--  Application login accounts. Passwords stored as bcrypt hashes.
-- -----------------------------------------------------------------------------
CREATE TABLE `users` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `username`   VARCHAR(100) NOT NULL,
  `password`   VARCHAR(255) NOT NULL,   -- bcrypt hash
  `full_name`  VARCHAR(200) NOT NULL,
  `role`       ENUM('admin', 'user') NULL DEFAULT 'admin',
  `is_active`  TINYINT(1)   NULL DEFAULT 1,
  `created_at` TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_username` (`username`)
);


-- -----------------------------------------------------------------------------
--  employees
--  Sales reps and delivery staff. Referenced by sales and recoveries.
-- -----------------------------------------------------------------------------
CREATE TABLE `employees` (
  `id`         INT                          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)                 NOT NULL,
  `cnic`       VARCHAR(20)                  NULL,   -- Pakistani NID number
  `phone`      VARCHAR(50)                  NULL,
  `role`       ENUM('Salesman', 'Supplier') NOT NULL,
  `created_at` TIMESTAMP                   NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP                   NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


-- -----------------------------------------------------------------------------
--  customers
--  Pharmacy / retailer customers. Linked to the city → area → territory chain.
--  balance: running outstanding receivable.
-- -----------------------------------------------------------------------------
CREATE TABLE `customers` (
  `id`             INT           NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(200)  NOT NULL,
  `address`        TEXT          NULL,
  `phone`          VARCHAR(50)   NULL,
  `license_no`     VARCHAR(100)  NULL,   -- drug license number
  `license_expiry` DATE          NULL,
  `city_id`        INT           NULL,
  `area_id`        INT           NULL,
  `territory_id`   INT           NULL,
  `balance`        DECIMAL(12,2) NULL DEFAULT 0.00,
  `created_at`     TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_cust_city`      FOREIGN KEY (`city_id`)      REFERENCES `cities`      (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cust_area`      FOREIGN KEY (`area_id`)      REFERENCES `areas`       (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cust_territory` FOREIGN KEY (`territory_id`) REFERENCES `territories` (`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  suppliers
--  Vendors for finished products, raw materials, or both.
--  balance: total outstanding payable to this supplier.
-- -----------------------------------------------------------------------------
CREATE TABLE `suppliers` (
  `id`            INT                                     NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(200)                            NOT NULL,
  `address`       TEXT                                    NULL,
  `phone`         VARCHAR(50)                             NULL,
  `supplier_type` ENUM('product', 'raw_material', 'both') NULL DEFAULT 'product',
  `balance`       DECIMAL(12,2)                           NULL DEFAULT 0.00,
  `created_at`    TIMESTAMP                              NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP                              NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


-- -----------------------------------------------------------------------------
--  supplier_companies
--  M:N — which pharmaceutical companies a supplier distributes for.
-- -----------------------------------------------------------------------------
CREATE TABLE `supplier_companies` (
  `id`          INT         NOT NULL AUTO_INCREMENT,
  `supplier_id` INT         NOT NULL,
  `company_id`  VARCHAR(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_company` (`supplier_id`, `company_id`),
  CONSTRAINT `fk_sc_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`  (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sc_company`  FOREIGN KEY (`company_id`)  REFERENCES `companies`  (`id`) ON DELETE CASCADE
);


-- -----------------------------------------------------------------------------
--  supplier_products
--  M:N — which finished products a supplier can supply.
-- -----------------------------------------------------------------------------
CREATE TABLE `supplier_products` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `supplier_id` INT NOT NULL,
  `product_id`  INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_supplier_product` (`supplier_id`, `product_id`),
  CONSTRAINT `fk_sp_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sp_product`  FOREIGN KEY (`product_id`)  REFERENCES `products`  (`id`) ON DELETE CASCADE
);


-- -----------------------------------------------------------------------------
--  products
--  Finished goods catalogue — both traded and in-house manufactured.
--  is_manufactured = 1 means produced via mfg module.
--  sale_tax_pct: sales tax % reported to FBR.
-- -----------------------------------------------------------------------------
CREATE TABLE `products` (
  `id`              INT           NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(200)  NOT NULL,
  `pack_size`       VARCHAR(100)  NULL,
  `volume`          DECIMAL(12,4) NULL,
  `volume_uom_id`   INT           NULL,
  `purchase_rate`   DECIMAL(12,4) NULL DEFAULT 0.0000,
  `show_purchase_rate` TINYINT(1) NOT NULL DEFAULT 1,
  `sale_rate`       DECIMAL(12,2) NULL DEFAULT 0.00,
  `retail_price`    DECIMAL(12,2) NULL DEFAULT 0.00,   -- MRP printed on pack
  `company_id`      VARCHAR(20)   NULL,
  `category_id`     INT           NULL,
  `is_manufactured` TINYINT(1)    NULL DEFAULT 0,
  `tax_applicable`  TINYINT(1)    NULL DEFAULT 0,
  `sale_tax_pct`    DECIMAL(5,2)  NULL DEFAULT 0.00,
  `created_at`      TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_prod_company`  FOREIGN KEY (`company_id`)    REFERENCES `companies`           (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_prod_category` FOREIGN KEY (`category_id`)   REFERENCES `product_categories`  (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_prod_vol_uom`  FOREIGN KEY (`volume_uom_id`) REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  raw_materials
--  Ingredients and packaging materials consumed in manufacturing.
--  stock_qty: running balance (can go negative on over-usage).
-- -----------------------------------------------------------------------------
CREATE TABLE `raw_materials` (
  `id`            INT                                         NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(200)                                NOT NULL,
  `material_type` ENUM('raw_material', 'packaging_material') NOT NULL,
  `uom_id`        INT           NULL,
  `volume`        DECIMAL(12,4) NULL,
  `volume_uom_id` INT           NULL,
  `cost_per_unit` DECIMAL(12,4) NULL DEFAULT 0.0000,
  `stock_qty`     DECIMAL(14,4) NULL DEFAULT 0.0000,
  `created_at`    TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rm_name` (`name`),
  CONSTRAINT `fk_rm_uom`     FOREIGN KEY (`uom_id`)        REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_rm_vol_uom` FOREIGN KEY (`volume_uom_id`) REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL
);


-- =============================================================================
--  3. PURCHASING
-- =============================================================================

-- -----------------------------------------------------------------------------
--  purchases
--  Purchase order header for finished goods from suppliers.
-- -----------------------------------------------------------------------------
CREATE TABLE `purchases` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `purchase_id`  VARCHAR(30)   NOT NULL,   -- e.g. PUR-00001
  `supplier_id`  INT           NOT NULL,
  `invoice_no`   VARCHAR(100)  NULL,
  `date`         DATE          NOT NULL,
  `total_amount` DECIMAL(12,2) NULL DEFAULT 0.00,
  `created_at`   TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_id` (`purchase_id`),
  CONSTRAINT `fk_pur_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`)
);


-- -----------------------------------------------------------------------------
--  purchase_items
--  Line items per purchase. Drives inventory receipt on save.
-- -----------------------------------------------------------------------------
CREATE TABLE `purchase_items` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `purchase_id`   INT           NOT NULL,
  `product_id`    INT           NOT NULL,
  `batch_no`      VARCHAR(100)  NULL,
  `pack_size`     VARCHAR(100)  NULL,
  `purchase_rate` DECIMAL(12,2) NULL DEFAULT 0.00,
  `qty`           INT           NULL DEFAULT 0,
  `bonus`         INT           NULL DEFAULT 0,    -- free units
  `discount_pct`  DECIMAL(5,2)  NULL DEFAULT 0.00,
  `tax_pct`       DECIMAL(5,2)  NULL DEFAULT 0.00, -- WHT %
  `sale_tax_pct`  DECIMAL(5,2)  NULL DEFAULT 0.00,
  `exp_date`      DATE          NULL,
  `retail_price`  DECIMAL(12,2) NULL DEFAULT 0.00, -- MRP at time of purchase
  `total`         DECIMAL(12,2) NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_pi_purchase` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pi_product`  FOREIGN KEY (`product_id`)  REFERENCES `products` (`id`)
);


-- -----------------------------------------------------------------------------
--  rm_purchases
--  Raw material purchase records, separate from finished-goods purchasing.
-- -----------------------------------------------------------------------------
CREATE TABLE `rm_purchases` (
  `id`              INT           NOT NULL AUTO_INCREMENT,
  `raw_material_id` INT           NOT NULL,
  `supplier_id`     INT           NULL,
  `date`            DATE          NOT NULL,
  `invoice_no`      VARCHAR(100)  NULL,
  `qty`             DECIMAL(14,4) NOT NULL,
  `amount`          DECIMAL(12,2) NOT NULL,
  `unit_cost`       DECIMAL(12,4) NULL,
  `created_at`      TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_rmp_rm`       FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials`(`id`),
  CONSTRAINT `fk_rmp_supplier` FOREIGN KEY (`supplier_id`)     REFERENCES `suppliers`    (`id`) ON DELETE SET NULL
);


-- =============================================================================
--  4. INVENTORY
-- =============================================================================

-- -----------------------------------------------------------------------------
--  inventory
--  Stock ledger per product per batch.
--  Updated by: purchases (in), sales (out), mfg yields (in), returns (in).
--  Unique constraint prevents duplicate batch entries for the same product.
-- -----------------------------------------------------------------------------
CREATE TABLE `inventory` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `product_id`          INT           NOT NULL,
  `batch_no`            VARCHAR(100)  NOT NULL,
  `qty`                 INT           NULL DEFAULT 0,
  `purchase_rate`       DECIMAL(12,4) NULL DEFAULT 0.0000,
  `sale_rate`           DECIMAL(12,2) NULL DEFAULT 0.00,
  `retail_price`        DECIMAL(12,2) NULL DEFAULT 0.00,   -- MRP
  `exp_date`            DATE          NULL,
  `low_stock_threshold` INT           NULL DEFAULT 10,      -- alert trigger
  `created_at`          TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_batch` (`product_id`, `batch_no`),
  CONSTRAINT `fk_inv_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);


-- =============================================================================
--  5. SALES
-- =============================================================================

-- -----------------------------------------------------------------------------
--  sales
--  Invoice header. is_locked = 1 prevents edits after recovery is processed.
-- -----------------------------------------------------------------------------
CREATE TABLE `sales` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `invoice_no`   VARCHAR(30)   NOT NULL,   -- e.g. INV-00001
  `customer_id`  INT           NOT NULL,
  `salesman_id`  INT           NULL,
  `delivery_by`  INT           NULL,
  `date`         DATE          NOT NULL,
  `total_amount` DECIMAL(12,2) NULL DEFAULT 0.00,
  `is_locked`    TINYINT(1)    NULL DEFAULT 0,
  `created_at`   TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_no` (`invoice_no`),
  CONSTRAINT `fk_sale_customer`  FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `fk_sale_salesman`  FOREIGN KEY (`salesman_id`) REFERENCES `employees` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sale_delivery`  FOREIGN KEY (`delivery_by`) REFERENCES `employees` (`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  sale_items
--  Line items per invoice. Deducts qty from inventory on save.
-- -----------------------------------------------------------------------------
CREATE TABLE `sale_items` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `sale_id`      INT           NOT NULL,
  `product_id`   INT           NOT NULL,
  `batch_no`     VARCHAR(100)  NULL,
  `pack_size`    VARCHAR(100)  NULL,
  `sale_rate`    DECIMAL(12,2) NULL DEFAULT 0.00,
  `qty`          INT           NULL DEFAULT 0,
  `bonus`        INT           NULL DEFAULT 0,    -- free units
  `discount_pct` DECIMAL(5,2)  NULL DEFAULT 0.00,
  `tax_pct`      DECIMAL(5,2)  NULL DEFAULT 0.00,
  `sale_tax_pct` DECIMAL(5,2)  NULL DEFAULT 0.00,
  `total`        DECIMAL(12,2) NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_si_sale`    FOREIGN KEY (`sale_id`)    REFERENCES `sales`   (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_si_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`)
);


-- =============================================================================
--  6. RECOVERIES (Collections)
-- =============================================================================

-- -----------------------------------------------------------------------------
--  recoveries
--  Collection record per invoice — captures discounts, returns, and cash collected.
-- -----------------------------------------------------------------------------
CREATE TABLE `recoveries` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `sale_id`             INT           NOT NULL,
  `salesman_id`         INT           NULL,
  `date`                DATE          NOT NULL,
  `notes`               TEXT          NULL,
  `total_discount`      DECIMAL(12,2) NULL DEFAULT 0.00,
  `total_return_amount` DECIMAL(12,2) NULL DEFAULT 0.00,
  `net_collectible`     DECIMAL(12,2) NULL DEFAULT 0.00,   -- due after discount & returns
  `net_collected`       DECIMAL(12,2) NULL DEFAULT 0.00,   -- cash actually recovered
  `pending_amount`      DECIMAL(12,2) NULL DEFAULT 0.00,   -- net_collectible - net_collected
  `created_at`          TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_rec_sale`     FOREIGN KEY (`sale_id`)     REFERENCES `sales`    (`id`),
  CONSTRAINT `fk_rec_salesman` FOREIGN KEY (`salesman_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  recovery_items
--  Per-line discount detail for each recovery.
-- -----------------------------------------------------------------------------
CREATE TABLE `recovery_items` (
  `id`             INT           NOT NULL AUTO_INCREMENT,
  `recovery_id`    INT           NOT NULL,
  `sale_item_id`   INT           NOT NULL,
  `product_id`     INT           NOT NULL,
  `batch_no`       VARCHAR(100)  NULL,
  `original_total` DECIMAL(12,2) NULL DEFAULT 0.00,
  `discount_given` DECIMAL(12,2) NULL DEFAULT 0.00,
  `final_amount`   DECIMAL(12,2) NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_ri_recovery`  FOREIGN KEY (`recovery_id`)  REFERENCES `recoveries` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ri_sale_item` FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items` (`id`),
  CONSTRAINT `fk_ri_product`   FOREIGN KEY (`product_id`)   REFERENCES `products`   (`id`)
);


-- -----------------------------------------------------------------------------
--  return_items
--  Physical goods returned to stock as part of a recovery.
-- -----------------------------------------------------------------------------
CREATE TABLE `return_items` (
  `id`            INT           NOT NULL AUTO_INCREMENT,
  `recovery_id`   INT           NOT NULL,
  `sale_id`       INT           NOT NULL,
  `sale_item_id`  INT           NOT NULL,
  `product_id`    INT           NOT NULL,
  `batch_no`      VARCHAR(100)  NULL,
  `qty_returned`  INT           NULL DEFAULT 0,
  `return_rate`   DECIMAL(12,2) NULL DEFAULT 0.00,
  `return_amount` DECIMAL(12,2) NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_ret_recovery`  FOREIGN KEY (`recovery_id`)  REFERENCES `recoveries` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ret_sale`      FOREIGN KEY (`sale_id`)      REFERENCES `sales`      (`id`),
  CONSTRAINT `fk_ret_sale_item` FOREIGN KEY (`sale_item_id`) REFERENCES `sale_items` (`id`),
  CONSTRAINT `fk_ret_product`   FOREIGN KEY (`product_id`)   REFERENCES `products`   (`id`)
);


-- =============================================================================
--  7. MANUFACTURING
-- =============================================================================

-- -----------------------------------------------------------------------------
--  mfg_batches
--  A production run. status: open → yielded once finished goods are recorded.
--  cost_per_base_unit: total_cost / total_volume (e.g. cost per ml).
-- -----------------------------------------------------------------------------
CREATE TABLE `mfg_batches` (
  `id`                INT                      NOT NULL AUTO_INCREMENT,
  `batch_code`        VARCHAR(50)              NOT NULL,   -- e.g. MFG-00001
  `category_id`       INT                      NULL,
  `batch_date`        DATE                     NOT NULL,
  `expiry_date`       DATE                     NOT NULL,
  `total_volume`      DECIMAL(14,4)            NOT NULL,
  `volume_uom_id`     INT                      NULL,
  `misc_expense`      DECIMAL(12,2)            NULL DEFAULT 0.00,
  `raw_material_cost` DECIMAL(12,2)            NULL DEFAULT 0.00,
  `total_cost`        DECIMAL(12,2)            NULL DEFAULT 0.00,
  `cost_per_base_unit`DECIMAL(14,8)            NULL DEFAULT 0.00000000,
  `status`            ENUM('open', 'yielded')  NULL DEFAULT 'open',
  `notes`             TEXT                     NULL,
  `created_at`        TIMESTAMP                NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch_code` (`batch_code`),
  CONSTRAINT `fk_mb_category`  FOREIGN KEY (`category_id`)   REFERENCES `product_categories`  (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_mb_vol_uom`   FOREIGN KEY (`volume_uom_id`) REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  mfg_batch_materials
--  Raw materials consumed per manufacturing batch.
-- -----------------------------------------------------------------------------
CREATE TABLE `mfg_batch_materials` (
  `id`              INT           NOT NULL AUTO_INCREMENT,
  `batch_id`        INT           NOT NULL,
  `raw_material_id` INT           NOT NULL,
  `qty`             DECIMAL(14,4) NOT NULL,
  `uom_id`          INT           NULL,
  `unit_cost`       DECIMAL(12,4) NULL DEFAULT 0.0000,
  `total_cost`      DECIMAL(12,2) NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_mbm_batch` FOREIGN KEY (`batch_id`)        REFERENCES `mfg_batches`        (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mbm_rm`    FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials`      (`id`),
  CONSTRAINT `fk_mbm_uom`   FOREIGN KEY (`uom_id`)          REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  mfg_yields
--  A yield event that converts a finished batch into saleable product units.
-- -----------------------------------------------------------------------------
CREATE TABLE `mfg_yields` (
  `id`          INT         NOT NULL AUTO_INCREMENT,
  `yield_code`  VARCHAR(50) NOT NULL,   -- e.g. YLD-00001
  `batch_id`    INT         NOT NULL,
  `created_at`  TIMESTAMP   NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_yield_code` (`yield_code`),
  CONSTRAINT `fk_my_batch` FOREIGN KEY (`batch_id`) REFERENCES `mfg_batches`(`id`)
);


-- -----------------------------------------------------------------------------
--  mfg_yield_items
--  Finished product units produced per yield, with full per-unit cost breakdown.
--  unit_cost_with_tax includes sales tax on the manufactured product.
-- -----------------------------------------------------------------------------
CREATE TABLE `mfg_yield_items` (
  `id`                       INT           NOT NULL AUTO_INCREMENT,
  `yield_id`                 INT           NOT NULL,
  `product_id`               INT           NOT NULL,
  `units_manufactured`       INT           NOT NULL,
  `pack_volume`              DECIMAL(12,4) NOT NULL,   -- volume per finished unit
  `pack_volume_uom_id`       INT           NULL,
  `total_volume_used`        DECIMAL(14,4) NOT NULL,
  `packaging_material_id`    INT           NULL,
  `packaging_qty`            INT           NULL DEFAULT 1,
  `packaging_cost_per_unit`  DECIMAL(12,4) NULL DEFAULT 0.0000,
  `batch_cost_per_unit`      DECIMAL(14,8) NULL DEFAULT 0.00000000,
  `total_unit_cost`          DECIMAL(12,4) NULL DEFAULT 0.0000,   -- excl. tax
  `unit_cost_with_tax`       DECIMAL(12,4) NULL DEFAULT 0.0000,   -- incl. sales tax
  `added_to_inventory`       TINYINT(1)    NULL DEFAULT 0,
  `batch_no`                 VARCHAR(100)  NULL,
  `exp_date`                 DATE          NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_myi_yield`    FOREIGN KEY (`yield_id`)              REFERENCES `mfg_yields`         (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_myi_product`  FOREIGN KEY (`product_id`)            REFERENCES `products`           (`id`),
  CONSTRAINT `fk_myi_pv_uom`   FOREIGN KEY (`pack_volume_uom_id`)    REFERENCES `units_of_measurement`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_myi_pkg_mat`  FOREIGN KEY (`packaging_material_id`) REFERENCES `raw_materials`      (`id`) ON DELETE SET NULL
);


-- =============================================================================
--  8. LEDGERS & FINANCE
-- =============================================================================

-- -----------------------------------------------------------------------------
--  customer_ledger
--  Double-entry style running ledger per customer.
--  dr increases balance (sale), cr reduces balance (payment/return).
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_ledger` (
  `id`             INT                                      NOT NULL AUTO_INCREMENT,
  `customer_id`    INT                                      NOT NULL,
  `date`           DATE                                     NOT NULL,
  `invoice_no`     VARCHAR(100)                             NULL,
  `description`    VARCHAR(500)                             NULL,
  `dr`             DECIMAL(12,2)                            NULL DEFAULT 0.00,
  `cr`             DECIMAL(12,2)                            NULL DEFAULT 0.00,
  `balance`        DECIMAL(12,2)                            NULL DEFAULT 0.00,
  `reference_type` ENUM('sale', 'payment', 'adjustment')   NULL DEFAULT 'sale',
  `reference_id`   INT                                      NULL,   -- links to sales.id etc.
  `created_at`     TIMESTAMP                                NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_cl_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`)
);


-- -----------------------------------------------------------------------------
--  supplier_ledger
--  Running payable ledger per supplier. Mirrors customer_ledger logic.
-- -----------------------------------------------------------------------------
CREATE TABLE `supplier_ledger` (
  `id`             INT                                          NOT NULL AUTO_INCREMENT,
  `supplier_id`    INT                                          NOT NULL,
  `date`           DATE                                         NOT NULL,
  `invoice_no`     VARCHAR(100)                                 NULL,
  `description`    VARCHAR(500)                                 NULL,
  `dr`             DECIMAL(12,2)                                NULL DEFAULT 0.00,
  `cr`             DECIMAL(12,2)                                NULL DEFAULT 0.00,
  `balance`        DECIMAL(12,2)                                NULL DEFAULT 0.00,
  `reference_type` ENUM('purchase', 'payment', 'adjustment')   NULL DEFAULT 'purchase',
  `reference_id`   INT                                          NULL,
  `created_at`     TIMESTAMP                                    NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_sl_supplier` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`)
);


-- -----------------------------------------------------------------------------
--  rm_ledger
--  Stock movement ledger for raw materials.
--  qty_in: received (purchases); qty_out: consumed (batch usage).
-- -----------------------------------------------------------------------------
CREATE TABLE `rm_ledger` (
  `id`              INT                                              NOT NULL AUTO_INCREMENT,
  `raw_material_id` INT                                              NOT NULL,
  `date`            DATE                                             NOT NULL,
  `reference_type`  ENUM('purchase', 'batch_usage', 'adjustment')   NOT NULL,
  `reference_id`    INT           NULL,   -- links to rm_purchases.id or mfg_batches.id
  `description`     VARCHAR(300)  NULL,
  `qty_in`          DECIMAL(14,4) NULL DEFAULT 0.0000,
  `qty_out`         DECIMAL(14,4) NULL DEFAULT 0.0000,
  `balance_qty`     DECIMAL(14,4) NULL DEFAULT 0.0000,
  `unit_cost`       DECIMAL(12,4) NULL DEFAULT 0.0000,
  `created_at`      TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_rml_rm` FOREIGN KEY (`raw_material_id`) REFERENCES `raw_materials`(`id`)
);


-- -----------------------------------------------------------------------------
--  finance
--  General ledger — expenses, payments to suppliers, payments from customers.
-- -----------------------------------------------------------------------------
CREATE TABLE `finance` (
  `id`              INT                                                              NOT NULL AUTO_INCREMENT,
  `date`            DATE                                                             NOT NULL,
  `category`        ENUM('Expense', 'Payment to Supplier', 'Payment from Customer') NOT NULL,
  `description`     TEXT          NULL,
  `expense_type_id` INT           NULL,
  `supplier_id`     INT           NULL,
  `customer_id`     INT           NULL,
  `amount`          DECIMAL(12,2) NULL DEFAULT 0.00,
  `payment_type`    VARCHAR(50)   NULL,   -- e.g. 'Online', 'Cash', 'Cheque'
  `created_at`      TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fin_expense_type` FOREIGN KEY (`expense_type_id`) REFERENCES `expense_types`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_supplier`     FOREIGN KEY (`supplier_id`)     REFERENCES `suppliers`    (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_customer`     FOREIGN KEY (`customer_id`)     REFERENCES `customers`    (`id`) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
--  tax_ledger
--  FBR sales tax tracking per taxable sale. Tracks submission status.
-- -----------------------------------------------------------------------------
CREATE TABLE `tax_ledger` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `sale_id`             INT           NULL,
  `sale_item_id`        INT           NULL,
  `product_id`          INT           NULL,
  `sale_date`           DATE          NOT NULL,
  `invoice_no`          VARCHAR(100)  NULL,
  `taxable_amount`      DECIMAL(12,2) NULL DEFAULT 0.00,
  `tax_rate`            DECIMAL(5,2)  NULL DEFAULT 0.00,
  `tax_amount`          DECIMAL(12,2) NULL DEFAULT 0.00,
  `submitted_to_fbr`    TINYINT(1)    NULL DEFAULT 0,   -- 1 = submitted
  `fbr_submission_date` DATE          NULL,
  `created_at`          TIMESTAMP     NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_tl_sale`    FOREIGN KEY (`sale_id`)    REFERENCES `sales`   (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tl_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE SET NULL
);


-- =============================================================================
SET FOREIGN_KEY_CHECKS = 1;
-- =============================================================================

-- -----------------------------------------------------------------------------
--  company_settings
--  Single row storing company details used in invoices and reports.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `company_settings` (
  `id`        INT           NOT NULL AUTO_INCREMENT,
  `name`      VARCHAR(300)  NOT NULL DEFAULT 'NUVE Care',
  `address`   TEXT          NULL,
  `phone`     VARCHAR(100)  NULL,
  `email`     VARCHAR(200)  NULL,
  `logo_url`  VARCHAR(500)  NULL,
  `updated_at` TIMESTAMP   NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


-- -----------------------------------------------------------------------------
--  user_permissions
--  Module-level permission flags per user (one row per user).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_permissions` (
  `id`                      INT         NOT NULL AUTO_INCREMENT,
  `user_id`                 INT         NOT NULL,
  -- Master data
  `perm_companies`          TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_products`           TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_employees`          TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_geography`          TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_customers`          TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_suppliers`          TINYINT(1)  NOT NULL DEFAULT 0,
  -- Distribution
  `perm_purchase`           TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_view_purchase_rate` TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_sale`               TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_inventory`          TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_recovery`           TINYINT(1)  NOT NULL DEFAULT 0,
  -- Manufacturing
  `perm_mfg_products`       TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_mfg_raw_materials`  TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_mfg_batches`        TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_mfg_yields`         TINYINT(1)  NOT NULL DEFAULT 0,
  -- Finance & Reports
  `perm_finance`            TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_reports`            TINYINT(1)  NOT NULL DEFAULT 0,
  `perm_tax_ledger`         TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_permissions` (`user_id`),
  CONSTRAINT `fk_up_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);


-- -----------------------------------------------------------------------------
--  audit_logs
--  One row per user action. Referenced by log rotation policy.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`           BIGINT        NOT NULL AUTO_INCREMENT,
  `user_id`      INT           NULL,
  `username`     VARCHAR(100)  NULL,
  `action`       VARCHAR(100)  NOT NULL,          -- e.g. CREATE, UPDATE, DELETE, LOGIN
  `module`       VARCHAR(100)  NOT NULL,          -- e.g. sale, purchase, users
  `record_id`    VARCHAR(100)  NULL,              -- affected record id / invoice_no
  `description`  TEXT          NULL,
  `ip_address`   VARCHAR(50)   NULL,
  `created_at`   DATETIME      NOT NULL,          -- Pakistan Standard Time (UTC+5), set explicitly by app
  PRIMARY KEY (`id`),
  KEY `idx_al_user`    (`user_id`),
  KEY `idx_al_module`  (`module`),
  KEY `idx_al_created` (`created_at`)
);


-- --------------------------------+---------------------------------------------
--  log_rotation_policy
--  Single-row admin-defined retention policy.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `log_rotation_policy` (
  `id`                  INT         NOT NULL AUTO_INCREMENT,
  `logging_enabled`     TINYINT(1)  NOT NULL DEFAULT 1,        -- master on/off switch for audit logging
  `retention_days`      INT         NOT NULL DEFAULT 90,   -- delete logs older than this
  `auto_rotate_enabled` TINYINT(1)  NOT NULL DEFAULT 1,
  `last_rotated_at`     DATETIME    NULL,                  -- Pakistan Standard Time
  `updated_at`          TIMESTAMP   NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


-- -----------------------------------------------------------------------------
--  Migration safety: add columns if this schema is being re-applied to an
--  existing database created with an earlier version of these tables.
-- -----------------------------------------------------------------------------
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='log_rotation_policy' AND COLUMN_NAME='logging_enabled');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `log_rotation_policy` ADD COLUMN `logging_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit_logs' AND COLUMN_NAME='created_at'
  AND DATA_TYPE='timestamp');
SET @sql := IF(@col_exists>0,
  'ALTER TABLE `audit_logs` MODIFY COLUMN `created_at` DATETIME NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


ALTER TABLE `recoveries`
  ADD COLUMN `net_collectible` DECIMAL(12,2) NULL DEFAULT 0.00 AFTER `total_return_amount`,
  ADD COLUMN `pending_amount`   DECIMAL(12,2) NULL DEFAULT 0.00 AFTER `net_collected`;


-- =============================================================================
--  Partial-payment recovery support
--  Adds cumulative recovery bookkeeping directly on `sales`, so an invoice can
--  be LOCKED (line items frozen) after its first recovery event while its
--  recovery itself stays OPEN until the full amount is collected/returned.
--  `recoveries` remains a per-event history log (one row per payment/return
--  installment) — see recoveries.js for how the cumulative figures are kept
--  in sync with the per-event figures on each save.
-- =============================================================================
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='total_discount');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `sales` ADD COLUMN `total_discount` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `is_locked`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='total_return_amount');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `sales` ADD COLUMN `total_return_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `total_discount`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='net_collectible');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `sales` ADD COLUMN `net_collectible` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `total_return_amount`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='total_recovered');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `sales` ADD COLUMN `total_recovered` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `net_collectible`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='pending_amount');
SET @sql := IF(@col_exists=0,
  'ALTER TABLE `sales` ADD COLUMN `pending_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `total_recovered`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sales' AND COLUMN_NAME='recovery_status');
SET @sql := IF(@col_exists=0,
  "ALTER TABLE `sales` ADD COLUMN `recovery_status` ENUM('pending','completed') NOT NULL DEFAULT 'pending' AFTER `pending_amount`",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill invoices that already went through the OLD one-shot recovery flow
-- (one `recoveries` row per sale, always fully locked with no partial-payment concept).
UPDATE `sales` s
JOIN (
  SELECT sale_id,
         SUM(total_discount)      AS td,
         SUM(total_return_amount) AS tr,
         SUM(net_collected)       AS nc
  FROM `recoveries`
  GROUP BY sale_id
) r ON r.sale_id = s.id
SET s.total_discount      = r.td,
    s.total_return_amount = r.tr,
    s.total_recovered     = r.nc,
    s.net_collectible     = s.total_amount - r.td - r.tr,
    s.pending_amount      = GREATEST(0, (s.total_amount - r.td - r.tr) - r.nc),
    s.recovery_status     = IF((s.total_amount - r.td - r.tr) - r.nc <= 0.009, 'completed', 'pending')
WHERE s.total_recovered = 0 AND s.net_collectible = 0;

-- Backfill invoices with no recovery activity yet — nothing collected, everything pending.
UPDATE `sales` s
SET s.net_collectible = s.total_amount,
    s.pending_amount  = s.total_amount,
    s.recovery_status = 'pending'
WHERE s.id NOT IN (SELECT DISTINCT sale_id FROM `recoveries`)
  AND s.net_collectible = 0;