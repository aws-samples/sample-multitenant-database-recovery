-- Simple fake database schema designed for testing database restoration
-- This covers most common DDL use cases that extract-ddl and pre/post ddl-apply functions handle
-- Parameter substitution: {{SCHEMA_NAME}} will be replaced with actual schema name

-- =============================================================================
-- 1. EXTENSIONS (Database level - only create if not exists)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 2. SCHEMA CREATION
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS {{SCHEMA_NAME}};

-- =============================================================================
-- 3. CUSTOM TYPES
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE {{SCHEMA_NAME}}.user_status AS ENUM ('active', 'inactive', 'pending');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE {{SCHEMA_NAME}}.order_status AS ENUM ('pending', 'processing', 'completed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =============================================================================
-- 4. SEQUENCES
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS {{SCHEMA_NAME}}.user_id_seq
    START WITH 1000 INCREMENT BY 1 MINVALUE 1000 MAXVALUE 999999999 CACHE 10;

CREATE SEQUENCE IF NOT EXISTS {{SCHEMA_NAME}}.order_number_seq
    START WITH 100000 INCREMENT BY 1 MINVALUE 100000 MAXVALUE 999999999 CACHE 50;

-- =============================================================================
-- 5. FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.generate_user_code()
RETURNS TEXT AS $$
BEGIN
    RETURN 'USER-' || upper(left(md5(random()::text), 6));
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION {{SCHEMA_NAME}}.update_modified_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 6. TABLES (WITHOUT PRIMARY KEYS - will be added separately for pre-DMS)
-- =============================================================================

-- Table 1: Users (basic table, PK will be added separately)
CREATE TABLE IF NOT EXISTS {{SCHEMA_NAME}}.users (
    id INTEGER DEFAULT nextval('{{SCHEMA_NAME}}.user_id_seq') NOT NULL,
    user_code VARCHAR(20) DEFAULT {{SCHEMA_NAME}}.generate_user_code() NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    status {{SCHEMA_NAME}}.user_status DEFAULT 'pending' NOT NULL,
    age INTEGER,
    balance DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
    metadata JSONB DEFAULT '{}' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table 2: Products (different data types, PK will be added separately)
CREATE TABLE IF NOT EXISTS {{SCHEMA_NAME}}.products (
    id SERIAL NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    stock_quantity INTEGER DEFAULT 0 NOT NULL,
    tags TEXT[],
    attributes JSONB DEFAULT '{}' NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table 3: Orders (PK will be added separately)
CREATE TABLE IF NOT EXISTS {{SCHEMA_NAME}}.orders (
    id SERIAL NOT NULL,
    order_number VARCHAR(20) DEFAULT ('ORD-' || nextval('{{SCHEMA_NAME}}.order_number_seq')) NOT NULL,
    user_id INTEGER NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    status {{SCHEMA_NAME}}.order_status DEFAULT 'pending' NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Table 4: Order Items (PK will be added separately)
CREATE TABLE IF NOT EXISTS {{SCHEMA_NAME}}.order_items (
    id SERIAL NOT NULL,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    total_price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- =============================================================================
-- 7. PRIMARY KEYS (separate statements for pre-DMS compatibility)
-- =============================================================================

ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE {{SCHEMA_NAME}}.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE {{SCHEMA_NAME}}.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE {{SCHEMA_NAME}}.order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

-- =============================================================================
-- 8. UNIQUE CONSTRAINTS (post-DMS)
-- =============================================================================

ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_email_unique UNIQUE (email);
ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_user_code_unique UNIQUE (user_code);
ALTER TABLE {{SCHEMA_NAME}}.products ADD CONSTRAINT products_name_unique UNIQUE (name);
ALTER TABLE {{SCHEMA_NAME}}.orders ADD CONSTRAINT orders_order_number_unique UNIQUE (order_number);

-- =============================================================================
-- 9. CHECK CONSTRAINTS (post-DMS)
-- =============================================================================

ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_email_format CHECK (email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+\.[A-Za-z]{2,}$');
ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_age_valid CHECK (age IS NULL OR (age >= 18 AND age <= 120));
ALTER TABLE {{SCHEMA_NAME}}.users ADD CONSTRAINT users_balance_positive CHECK (balance >= 0);
ALTER TABLE {{SCHEMA_NAME}}.products ADD CONSTRAINT products_price_positive CHECK (price > 0);
ALTER TABLE {{SCHEMA_NAME}}.products ADD CONSTRAINT products_stock_non_negative CHECK (stock_quantity >= 0);
ALTER TABLE {{SCHEMA_NAME}}.orders ADD CONSTRAINT orders_total_positive CHECK (total_amount >= 0);
ALTER TABLE {{SCHEMA_NAME}}.order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);
ALTER TABLE {{SCHEMA_NAME}}.order_items ADD CONSTRAINT order_items_unit_price_positive CHECK (unit_price >= 0);

-- =============================================================================
-- 10. FOREIGN KEY CONSTRAINTS (post-DMS)
-- =============================================================================

ALTER TABLE {{SCHEMA_NAME}}.orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES {{SCHEMA_NAME}}.users(id) ON DELETE RESTRICT;
ALTER TABLE {{SCHEMA_NAME}}.order_items ADD CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES {{SCHEMA_NAME}}.orders(id) ON DELETE CASCADE;
ALTER TABLE {{SCHEMA_NAME}}.order_items ADD CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES {{SCHEMA_NAME}}.products(id) ON DELETE RESTRICT;

-- =============================================================================
-- 11. INDEXES (post-DMS)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_users_email ON {{SCHEMA_NAME}}.users (email);
CREATE INDEX IF NOT EXISTS idx_users_status ON {{SCHEMA_NAME}}.users (status);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON {{SCHEMA_NAME}}.users (created_at);

CREATE INDEX IF NOT EXISTS idx_products_price ON {{SCHEMA_NAME}}.products (price);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON {{SCHEMA_NAME}}.products (is_active);
CREATE INDEX IF NOT EXISTS idx_products_tags ON {{SCHEMA_NAME}}.products USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON {{SCHEMA_NAME}}.orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON {{SCHEMA_NAME}}.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON {{SCHEMA_NAME}}.orders (created_at);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON {{SCHEMA_NAME}}.order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON {{SCHEMA_NAME}}.order_items (product_id);

-- =============================================================================
-- 12. TRIGGERS (post-DMS)
-- =============================================================================

CREATE TRIGGER users_update_timestamp
    BEFORE UPDATE ON {{SCHEMA_NAME}}.users
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_modified_timestamp();

CREATE TRIGGER products_update_timestamp
    BEFORE UPDATE ON {{SCHEMA_NAME}}.products
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_modified_timestamp();

CREATE TRIGGER orders_update_timestamp
    BEFORE UPDATE ON {{SCHEMA_NAME}}.orders
    FOR EACH ROW EXECUTE FUNCTION {{SCHEMA_NAME}}.update_modified_timestamp();

-- =============================================================================
-- 13. VIEWS (post-DMS)
-- =============================================================================

CREATE OR REPLACE VIEW {{SCHEMA_NAME}}.user_order_summary AS
SELECT 
    u.id,
    u.name,
    u.email,
    COUNT(o.id) as total_orders,
    COALESCE(SUM(o.total_amount), 0) as total_spent,
    MAX(o.created_at) as last_order_date
FROM {{SCHEMA_NAME}}.users u
LEFT JOIN {{SCHEMA_NAME}}.orders o ON u.id = o.user_id
GROUP BY u.id, u.name, u.email;

CREATE OR REPLACE VIEW {{SCHEMA_NAME}}.product_sales_summary AS
SELECT 
    p.id,
    p.name,
    p.price,
    p.stock_quantity,
    COALESCE(SUM(oi.quantity), 0) as total_sold,
    COUNT(DISTINCT oi.order_id) as orders_count
FROM {{SCHEMA_NAME}}.products p
LEFT JOIN {{SCHEMA_NAME}}.order_items oi ON p.id = oi.product_id
GROUP BY p.id, p.name, p.price, p.stock_quantity;

-- =============================================================================
-- 14. ROW LEVEL SECURITY POLICIES (post-DMS)
-- =============================================================================

ALTER TABLE {{SCHEMA_NAME}}.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE {{SCHEMA_NAME}}.order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_own_data_policy ON {{SCHEMA_NAME}}.users
    AS PERMISSIVE FOR ALL
    TO PUBLIC
    USING (email = current_setting('app.current_user_email', true) OR current_user = 'postgres');

CREATE POLICY order_user_access_policy ON {{SCHEMA_NAME}}.orders
    AS PERMISSIVE FOR ALL
    TO PUBLIC
    USING (user_id IN (
        SELECT id FROM {{SCHEMA_NAME}}.users 
        WHERE email = current_setting('app.current_user_email', true)
    ) OR current_user IN ('postgres', 'admin'));

CREATE POLICY order_items_access_policy ON {{SCHEMA_NAME}}.order_items
    AS PERMISSIVE FOR ALL
    TO PUBLIC
    USING (order_id IN (
        SELECT id FROM {{SCHEMA_NAME}}.orders
        WHERE user_id IN (
            SELECT id FROM {{SCHEMA_NAME}}.users 
            WHERE email = current_setting('app.current_user_email', true)
        )
    ) OR current_user IN ('postgres', 'admin'));

-- =============================================================================
-- 15. SAMPLE FAKE DATA (completely fake for testing)
-- =============================================================================

-- Insert fake users
INSERT INTO {{SCHEMA_NAME}}.users (name, email, status, age, balance) VALUES
('User One of {{SCHEMA_NAME}}', 'user1@{{SCHEMA_NAME}}.com', 'active', 25, 150.00),
('User Two of {{SCHEMA_NAME}}', 'user2@{{SCHEMA_NAME}}.com', 'active', 30, 200.50),
('User Three of {{SCHEMA_NAME}}', 'user3@{{SCHEMA_NAME}}.com', 'pending', 22, 0.00),
('User Four of {{SCHEMA_NAME}}', 'user4@{{SCHEMA_NAME}}.com', 'inactive', 35, 75.25),
('User Five of {{SCHEMA_NAME}}', 'user5@{{SCHEMA_NAME}}.com', 'active', 28, 300.00)
ON CONFLICT (email) DO NOTHING;

-- Insert fake products
INSERT INTO {{SCHEMA_NAME}}.products (name, description, price, stock_quantity, tags, attributes) VALUES
('Product A of {{SCHEMA_NAME}}', 'Product A description', 19.99, 100, ARRAY['sample', 'data'], '{"color": "red", "size": "medium"}'),
('Product B of {{SCHEMA_NAME}}', 'Product B description', 29.99, 50, ARRAY['test', 'demo'], '{"color": "blue", "weight": "1kg"}'),
('Product C of {{SCHEMA_NAME}}', 'Product C description', 39.99, 75, ARRAY['sample', 'test'], '{"material": "plastic", "warranty": "1 year"}'),
('Product D of {{SCHEMA_NAME}}', 'Product D description', 49.99, 25, ARRAY['demo', 'data'], '{"brand": "TestBrand", "model": "2024"}'),
('Product E of {{SCHEMA_NAME}}', 'Product E description', 59.99, 200, ARRAY['test', 'sample'], '{"category": "electronics", "rating": 4.5}')
ON CONFLICT (name) DO NOTHING;

-- Insert fake orders
INSERT INTO {{SCHEMA_NAME}}.orders (user_id, total_amount, status, notes) VALUES
(1000, 89.97, 'completed', 'Order 1'),
(1001, 139.96, 'processing', 'Order 2'),
(1002, 49.99, 'pending', 'Order 3'),
(1003, 29.99, 'cancelled', 'Oancelled order'),
(1004, 159.95, 'completed', 'Order 5')
ON CONFLICT (order_number) DO NOTHING;

-- Insert fake order items
INSERT INTO {{SCHEMA_NAME}}.order_items (order_id, product_id, quantity, unit_price, total_price) VALUES
(1, 1, 2, 19.99, 39.98),
(1, 2, 1, 29.99, 29.99),
(1, 3, 1, 39.99, 39.99),
(2, 2, 1, 29.99, 29.99),
(2, 4, 1, 49.99, 49.99),
(2, 5, 1, 59.99, 59.99),
(3, 4, 1, 49.99, 49.99),
(5, 1, 3, 19.99, 59.97),
(5, 5, 1, 59.99, 59.99),
(5, 3, 2, 39.99, 79.98)
ON CONFLICT DO NOTHING;