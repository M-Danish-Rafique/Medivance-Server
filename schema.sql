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

INSERT INTO `cities` (`id`, `name`, `created_at`) VALUES
  (1, 'Islamabad', '2026-05-18 11:40:22');


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

INSERT INTO `areas` (`id`, `name`, `city_id`, `created_at`) VALUES
  (1, 'Blue Area', 1, '2026-05-18 11:40:43'),
  (2, 'I-8',       1, '2026-05-18 11:52:15'),
  (3, 'F-10',      1, '2026-06-10 01:09:27');


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

INSERT INTO `territories` (`id`, `name`, `area_id`, `created_at`) VALUES
  (1, 'New Blue Area',       1, '2026-05-18 11:41:26'),
  (2, 'Main Markaz, I-8/4', 2, '2026-05-18 11:52:53'),
  (3, 'F-10 Markaz',        3, '2026-06-10 01:09:39');


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

INSERT INTO `units_of_measurement` (`id`, `name`, `symbol`, `base_type`, `to_base_factor`) VALUES
  (1, 'Count (no.)',     'pcs', 'count',  1.00000000),
  (2, 'Kilogram (kg)',   'kg',  'weight', 1000.00000000),
  (3, 'Gram (g)',        'g',   'weight', 1.00000000),
  (4, 'Liter (L)',       'L',   'volume', 1000.00000000),
  (5, 'Milliliter (ml)', 'ml',  'volume', 1.00000000);


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

INSERT INTO `product_categories` (`id`, `name`, `created_at`) VALUES
  (1, 'Hair Oil', '2026-05-19 12:52:07'),
  (2, 'Serum',    '2026-05-26 11:39:58');


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

-- (no data yet)


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

INSERT INTO `companies` (`id`, `name`, `address`, `phone`) VALUES
  ('MVC-0001', 'GlaxosmithKline (GSK) Pakistan',          '35, Dockyard Road West Wharf, Karachi',                                    '+92 21 3231 4898'),
  ('MVC-0002', 'Abbott Laboratories (Pakistan) Limited',  'House No: 123 - A, Ahmed Block, New Garden Town, Lahore',                  '042 35844737'),
  ('MVC-0003', 'Getz Pharma (Private) Limited',           '29-30/27 Main Korangi Industrial Rd, Sector 27 Landhi Town, Karachi',     '+92 21 111 111 511'),
  ('MVC-0004', 'NUVE Care',                               'Office No. 2, Fazal Arcade, Street No. 2, Ghauri Town - VIP Block, Islamabad', '+92 308 8421202');


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

INSERT INTO `users` (`id`, `username`, `password`, `full_name`, `role`, `is_active`) VALUES
  (1, 'admin', '$2a$10$7kEi12e1034m2qXMv1g.KO2Qrbi0p2gkwPYIEQ3ByKabXFuT715Te', 'System Administrator', 'admin', 1);


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

INSERT INTO `employees` (`id`, `name`, `cnic`, `phone`, `role`) VALUES
  (8, 'Ahsan Faraz', '41211-1562774-7', '+9230 0527 8387', 'Salesman');


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

INSERT INTO `customers` (`id`, `name`, `address`, `phone`, `license_no`, `license_expiry`, `city_id`, `area_id`, `territory_id`, `balance`) VALUES
  (1, 'D Watson Pharmacy I-8',  'Shop 132-134, Main Markaz I-8, Islamabad',     '+92 42 521 788 921', 'DRP-10217810', '2030-10-31', 1, 2, 2, 63000.00),
  (2, 'D Watson Pharmacy F-10', 'House No 655, Street 41, E-11/3, Islamabad',   '0211 1111 1511',     'D-108784789',  '2027-01-01', 1, 3, 3,     0.00);


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

INSERT INTO `suppliers` (`id`, `name`, `address`, `phone`, `supplier_type`, `balance`) VALUES
  (1, 'MDK Suppliers',           '154, Industrial Triangle Khuda Bakhsh Road, Kahuta Rd, Islamabad', '+92 300 8420810', 'raw_material', 114348.24),
  (2, 'Unichem Pharmaceuticals', 'Plot no 310, industrial triangle kahuta road, H 8/2 H-8, Islamabad', '+92 321 5171779', 'product',    0.00);


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

-- (no data yet)


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

-- (no data yet)


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

INSERT INTO `products` (`id`, `name`, `pack_size`, `volume`, `volume_uom_id`, `purchase_rate`, `sale_rate`, `retail_price`, `company_id`, `category_id`, `is_manufactured`, `tax_applicable`, `sale_tax_pct`) VALUES
  (1, 'Panadol 500mg',      '50\'s',  NULL,  NULL, 120.0000, 145.00, 165.00, 'MVC-0003', NULL, 0, 0,  0.00),
  (2, 'Augmentin Tab 625mg','6\'s',   NULL,  NULL, 195.0000, 230.00, 270.00, 'MVC-0001', NULL, 0, 0,  0.00),
  (3, 'Flagyl 400mg',       '10\'s',  NULL,  NULL,  32.0000,  38.00,  50.00, 'MVC-0002', NULL, 0, 0,  0.00),
  (4, 'Coconut Oil 150ml',  '150 ml', 150.0, 5,    327.1750, 600.00, 750.00, 'MVC-0004', 1,    1, 1, 15.00),
  (5, 'Vitamin C Serum',    '30 ml',   20.0, 5,      0.0000,1250.00,1100.00, 'MVC-0004', 2,    1, 1, 17.00),
  (7, 'Vitamin C Serum',    '50 ml',  NULL,  NULL,   0.0000, 150.00, 180.00, 'MVC-0002', NULL, 0, 0,  0.00);


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

INSERT INTO `raw_materials` (`id`, `name`, `material_type`, `uom_id`, `cost_per_unit`, `stock_qty`) VALUES
  (1, 'C-oil Ingredient 1', 'raw_material',       5,    8.0000,    0.0000),
  (2, 'C-oil Ingredient 2', 'raw_material',       3,    1.2000, -500.0000),
  (3, 'C-oil Ingredient 3', 'raw_material',       1,   20.0000, -100.0000),
  (5, 'C-oil Bottle 150ml', 'packaging_material', NULL,  2.5000,   54.0000),
  (6, 'C-oil Sticker',      'packaging_material', NULL,  1.6667,  120.0000),
  (7, 'C-oil Bottle Cap',   'packaging_material', NULL,  1.2500,  120.0000);


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

INSERT INTO `purchases` (`id`, `purchase_id`, `supplier_id`, `invoice_no`, `date`, `total_amount`) VALUES
  (1, 'PUR-00001', 1, 'SI-01245', '2026-05-18',  7798.24),
  (2, 'PUR-00002', 1, 'S-789456', '2026-05-19', 79500.00),
  (3, 'P25-00001', 1, 'SI-1213',  '2026-06-10',  3200.00),
  (4, 'P26-00001', 1, 'Si-2421',  '2026-06-10',  6000.00);


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

INSERT INTO `purchase_items` (`id`, `purchase_id`, `product_id`, `batch_no`, `pack_size`, `purchase_rate`, `qty`, `bonus`, `discount_pct`, `exp_date`, `retail_price`, `total`) VALUES
  (1, 1, 2, 'B-123', '6\'s',  195.00,  30, 0, 0.03, '2030-10-19', 270.00, 5848.24),
  (2, 1, 2, 'B-124', '6\'s',  195.00,  10, 0, 0.00, '2028-10-30', 270.00, 1950.00),
  (5, 2, 2, 'B-125', '6\'s',  195.00, 100, 0, 0.00, '2030-01-01', 270.00,19500.00),
  (6, 2, 1, 'B-50',  '50\'s', 120.00, 500, 0, 0.00, '2028-01-01', 165.00,60000.00),
  (7, 3, 3, 'B-12',  '10\'s',  32.00, 100, 0, 0.00, '2030-01-01',  50.00, 3200.00),
  (8, 4, 1, 'B-10',  '50\'s', 120.00,  50, 0, 0.00, '2030-01-01', 165.00, 6000.00);


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

INSERT INTO `rm_purchases` (`id`, `raw_material_id`, `supplier_id`, `date`, `invoice_no`, `qty`, `amount`, `unit_cost`) VALUES
  (1, 1, 1, '2026-05-26', 'Inv-RM-001', 1000.0000,  6000.00,  6.0000),
  (2, 1, 1, '2026-05-26', 'Inv-RM-001', 1000.0000,  8000.00,  8.0000),
  (3, 2, 1, '2026-05-26', 'Inv-RM-002', 1000.0000,  1200.00,  1.2000),
  (4, 3, 1, '2026-05-26', 'Inv-RM-004',  100.0000,  2000.00, 20.0000),
  (5, 5, 1, '2026-05-26', 'Inv-PM-001',  120.0000,   300.00,  2.5000),
  (6, 7, 1, '2026-05-26', NULL,           120.0000,   150.00,  1.2500),
  (7, 6, 1, '2026-05-26', NULL,           120.0000,   200.00,  1.6667);


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

INSERT INTO `inventory` (`id`, `product_id`, `batch_no`, `qty`, `purchase_rate`, `sale_rate`, `retail_price`, `exp_date`) VALUES
  (1, 2, 'B-123',      0, 195.0000,   0.00, 270.00, '2030-10-19'),
  (2, 2, 'B-124',      8, 195.0000,   0.00, 270.00, '2028-10-30'),
  (3, 2, 'B-125',     50, 195.0000, 230.00, 270.00, '2030-01-01'),
  (4, 1, 'B-50',     300, 120.0000, 145.00, 165.00, '2028-01-01'),
  (5, 4, 'MFG-00001', 16, 327.1750, 600.00,   0.00, '2030-05-25'),
  (6, 3, 'B-12',     100,  32.0000,  38.00,  50.00, '2030-01-01'),
  (7, 1, 'B-10',      50, 120.0000, 145.00, 165.00, '2030-01-01');


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

INSERT INTO `sales` (`id`, `invoice_no`, `customer_id`, `salesman_id`, `delivery_by`, `date`, `total_amount`, `is_locked`) VALUES
  (1, 'INV-00001', 1, NULL, NULL, '2026-05-18',  9200.00, 1),
  (2, 'INV-00002', 1, NULL, NULL, '2026-05-18',   450.00, 1),
  (3, 'INV-00003', 1, NULL, NULL, '2026-05-19', 11000.00, 1),
  (4, 'INV-00004', 1, NULL, NULL, '2026-05-19', 30000.00, 0),
  (5, 'INV-00005', 1, NULL, NULL, '2026-05-27', 30000.00, 0);


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

INSERT INTO `sale_items` (`id`, `sale_id`, `product_id`, `batch_no`, `pack_size`, `sale_rate`, `qty`, `total`) VALUES
  (1, 1, 2, 'B-123',     '6\'s',   230.00,  40,  9200.00),
  (2, 2, 2, 'B-124',     '6\'s',   225.00,   2,   450.00),
  (3, 3, 2, 'B-125',     '6\'s',   220.00,  50, 11000.00),
  (4, 4, 1, 'B-50',      '50\'s',  150.00, 200, 30000.00),
  (5, 5, 4, 'MFG-00001', '150 ml', 600.00,  50, 30000.00);


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

INSERT INTO `recoveries` (`id`, `sale_id`, `salesman_id`, `date`, `total_discount`, `total_return_amount`, `net_collectible`, `net_collected`, `pending_amount`) VALUES
  (1, 1, NULL, '2026-05-18',  200.00, 2300.00,  6700.00,  6700.00, 0.00),
  (2, 2, NULL, '2026-05-18',   50.00,    0.00,   400.00,   400.00, 0.00),
  (3, 3, NULL, '2026-05-19', 1000.00,    0.00, 10000.00, 10000.00, 0.00);


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

INSERT INTO `recovery_items` (`id`, `recovery_id`, `sale_item_id`, `product_id`, `batch_no`, `original_total`, `discount_given`, `final_amount`) VALUES
  (1, 1, 1, 2, 'B-123',  9200.00,  200.00, 9000.00),
  (2, 2, 2, 2, 'B-124',   450.00,   50.00,  400.00),
  (3, 3, 3, 2, 'B-125', 11000.00, 1000.00,10000.00);


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

INSERT INTO `return_items` (`id`, `recovery_id`, `sale_id`, `sale_item_id`, `product_id`, `batch_no`, `qty_returned`, `return_rate`, `return_amount`) VALUES
  (1, 1, 1, 1, 2, 'B-123', 10, 230.00, 2300.00);


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

INSERT INTO `mfg_batches` (`id`, `batch_code`, `category_id`, `batch_date`, `expiry_date`, `total_volume`, `volume_uom_id`, `misc_expense`, `raw_material_cost`, `total_cost`, `cost_per_base_unit`, `status`) VALUES
  (1, 'MFG-00001',   1, '2026-05-26', '2030-05-25', 10000.0000, 5, 5000.00, 13800.00, 18800.00, 1.88000000, 'yielded'),
  (2, 'B-260611-01', 1, '2026-06-11', '2028-07-15', 15000.0000, 5, 1600.00,  8000.00,  9600.00, 0.64000000, 'open');


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

INSERT INTO `mfg_batch_materials` (`id`, `batch_id`, `raw_material_id`, `qty`, `uom_id`, `unit_cost`, `total_cost`) VALUES
  (1, 1, 1, 1000.0000, 5,  8.0000, 8000.00),
  (2, 1, 2, 1500.0000, 3,  1.2000, 1800.00),
  (3, 1, 3,  200.0000, 1, 20.0000, 4000.00),
  (4, 2, 1, 1000.0000, 5,  8.0000, 8000.00);


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

INSERT INTO `mfg_yields` (`id`, `yield_code`, `batch_id`, `created_at`) VALUES
  (1, 'YLD-00001', 1, '2026-05-26 22:02:41');


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

INSERT INTO `mfg_yield_items` (`id`, `yield_id`, `product_id`, `units_manufactured`, `pack_volume`, `pack_volume_uom_id`, `total_volume_used`, `packaging_material_id`, `packaging_qty`, `packaging_cost_per_unit`, `batch_cost_per_unit`, `total_unit_cost`, `unit_cost_with_tax`, `added_to_inventory`, `batch_no`, `exp_date`) VALUES
  (1, 1, 4, 66, 150.0000, 5, 9900.0000, 5, 1, 2.5000, 282.00000000, 284.5000, 327.1750, 0, 'MFG-00001', '2030-05-25');


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

INSERT INTO `customer_ledger` (`id`, `customer_id`, `date`, `invoice_no`, `description`, `dr`, `cr`, `balance`, `reference_type`, `reference_id`) VALUES
  (1, 1, '2026-05-18', 'INV-00001', 'Sale',                                      9200.00,    0.00,  9200.00, 'sale',    1),
  (2, 1, '2026-05-18', 'INV-00001', 'Recovery - Discount/Return on INV-00001',      0.00, 2500.00,  6700.00, 'payment', 1),
  (3, 1, '2026-05-18', 'INV-00002', 'Sale',                                       450.00,    0.00,  7150.00, 'sale',    2),
  (4, 1, '2026-05-18', 'INV-00002', 'Recovery - Discount/Return on INV-00002',      0.00,   50.00,  7100.00, 'payment', 2),
  (5, 1, '2026-05-18', NULL,        'IBFT from D Watson [Online]',                   0.00, 5100.00,  2000.00, 'payment', 1),
  (6, 1, '2026-05-19', 'INV-00003', 'Sale',                                     11000.00,    0.00, 13000.00, 'sale',    3),
  (7, 1, '2026-05-19', 'INV-00003', 'Recovery received — Invoice INV-00003',        0.00,10000.00,  3000.00, 'payment', 3),
  (8, 1, '2026-05-19', 'INV-00004', 'Sale',                                     30000.00,    0.00, 33000.00, 'sale',    4),
  (9, 1, '2026-05-27', 'INV-00005', 'Sale',                                     30000.00,    0.00, 63000.00, 'sale',    5);


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

INSERT INTO `supplier_ledger` (`id`, `supplier_id`, `date`, `invoice_no`, `description`, `dr`, `cr`, `balance`, `reference_type`, `reference_id`) VALUES
  ( 1, 1, '2026-05-18', 'SI-01245',   'Purchase',              7798.24, 0.00,  7798.24, 'purchase', 1),
  ( 3, 1, '2026-05-19', 'S-789456',   'Purchase (Edited)',     79500.00, 0.00, 87298.24, 'purchase', 2),
  ( 4, 1, '2026-05-26', 'Inv-RM-001', 'Raw Material Purchase',  6000.00, 0.00, 93298.24, 'purchase', 1),
  ( 5, 1, '2026-05-26', 'Inv-RM-001', 'Raw Material Purchase',  8000.00, 0.00,101298.24, 'purchase', 2),
  ( 6, 1, '2026-05-26', 'Inv-RM-002', 'Raw Material Purchase',  1200.00, 0.00,102498.24, 'purchase', 3),
  ( 7, 1, '2026-05-26', 'Inv-RM-004', 'Raw Material Purchase',  2000.00, 0.00,104498.24, 'purchase', 4),
  ( 8, 1, '2026-05-26', 'Inv-PM-001', 'Raw Material Purchase',   300.00, 0.00,104798.24, 'purchase', 5),
  ( 9, 1, '2026-05-26', NULL,          'Raw Material Purchase',   150.00, 0.00,104948.24, 'purchase', 6),
  (10, 1, '2026-05-26', NULL,          'Raw Material Purchase',   200.00, 0.00,105148.24, 'purchase', 7),
  (11, 1, '2026-06-10', 'SI-1213',    'Purchase',               3200.00, 0.00,108348.24, 'purchase', 3),
  (12, 1, '2026-06-10', 'Si-2421',    'Purchase',               6000.00, 0.00,114348.24, 'purchase', 4);


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

INSERT INTO `rm_ledger` (`id`, `raw_material_id`, `date`, `reference_type`, `reference_id`, `description`, `qty_in`, `qty_out`, `balance_qty`, `unit_cost`) VALUES
  ( 1, 1, '2026-05-26', 'purchase',    1, 'Purchase - Invoice: Inv-RM-001',   1000.0000,    0.0000, 1000.0000,  6.0000),
  ( 2, 1, '2026-05-26', 'purchase',    2, 'Purchase - Invoice: Inv-RM-001',   1000.0000,    0.0000, 2000.0000,  8.0000),
  ( 3, 2, '2026-05-26', 'purchase',    3, 'Purchase - Invoice: Inv-RM-002',   1000.0000,    0.0000, 1000.0000,  1.2000),
  ( 4, 3, '2026-05-26', 'purchase',    4, 'Purchase - Invoice: Inv-RM-004',    100.0000,    0.0000,  100.0000, 20.0000),
  ( 5, 5, '2026-05-26', 'purchase',    5, 'Purchase - Invoice: Inv-PM-001',    120.0000,    0.0000,  120.0000,  2.5000),
  ( 6, 7, '2026-05-26', 'purchase',    6, 'Purchase - Invoice: N/A',           120.0000,    0.0000,  120.0000,  1.2500),
  ( 7, 6, '2026-05-26', 'purchase',    7, 'Purchase - Invoice: N/A',           120.0000,    0.0000,  120.0000,  1.6667),
  ( 8, 1, '2026-05-26', 'batch_usage', 1, 'Used in batch MFG-00001',             0.0000, 1000.0000, 1000.0000,  8.0000),
  ( 9, 2, '2026-05-26', 'batch_usage', 1, 'Used in batch MFG-00001',             0.0000, 1500.0000, -500.0000,  1.2000),
  (10, 3, '2026-05-26', 'batch_usage', 1, 'Used in batch MFG-00001',             0.0000,  200.0000, -100.0000, 20.0000),
  (11, 5, '2026-05-26', 'batch_usage', 1, 'Packaging for yield YLD-00001',       0.0000,   66.0000,   54.0000,  2.5000),
  (12, 1, '2026-06-11', 'batch_usage', 2, 'Used in batch B-260611-01',           0.0000, 1000.0000,    0.0000,  8.0000);


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

INSERT INTO `finance` (`id`, `date`, `category`, `description`, `expense_type_id`, `supplier_id`, `customer_id`, `amount`, `payment_type`) VALUES
  (1, '2026-05-18', 'Payment from Customer', 'IBFT from D Watson [Online]', NULL, NULL, 1, 5100.00, 'Online');


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

INSERT INTO `tax_ledger` (`id`, `sale_id`, `sale_item_id`, `product_id`, `sale_date`, `invoice_no`, `taxable_amount`, `tax_rate`, `tax_amount`, `submitted_to_fbr`, `fbr_submission_date`) VALUES
  (1, 5, NULL, 4, '2026-05-27', 'INV-00005', 30000.00, 15.00, 4500.00, 1, '2026-05-28');


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

INSERT INTO `company_settings` (`id`, `name`, `address`, `phone`, `email`) VALUES
  (1, 'NUVE Care',
   'Office No. 2, Fazal Arcade, Street No. 2, Ghauri Town - VIP Block, Islamabad',
   '0308-8421202', 'nuevecare@gmail.com')
ON DUPLICATE KEY UPDATE `id`=`id`;

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

-- Admin gets all permissions
INSERT INTO `user_permissions` (`user_id`,
  `perm_companies`,`perm_products`,`perm_employees`,`perm_geography`,`perm_customers`,`perm_suppliers`,
  `perm_purchase`,`perm_sale`,`perm_inventory`,`perm_recovery`,
  `perm_mfg_products`,`perm_mfg_raw_materials`,`perm_mfg_batches`,`perm_mfg_yields`,
  `perm_finance`,`perm_reports`,`perm_tax_ledger`)
VALUES (1, 1,1,1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1)
ON DUPLICATE KEY UPDATE `perm_companies`=1;

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

-- -----------------------------------------------------------------------------
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

INSERT INTO `log_rotation_policy` (`id`, `logging_enabled`, `retention_days`, `auto_rotate_enabled`) VALUES (1, 1, 90, 1)
ON DUPLICATE KEY UPDATE `id`=`id`;

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
