-- 1688 Operations Hub SQLite Schema
-- Single Source of Truth (SSOT) with strict contracts

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. 商品表 (Offers / Products)
CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  member_id TEXT,
  shop_id TEXT,
  seller_name TEXT,
  seller_url TEXT,
  item_url TEXT NOT NULL,
  image_url TEXT,
  main_images_json TEXT, -- JSON 数组
  price_text TEXT,
  price_min REAL,
  price_max REAL,
  currency TEXT DEFAULT 'CNY',
  moq_text TEXT,
  moq_value INTEGER,
  sales_text TEXT,
  sales_value INTEGER, -- 派生整数，如 14000
  return_rate_text TEXT,
  return_rate_percent REAL, -- 派生浮点数，如 38.0
  location TEXT,
  delivery_days_text TEXT,
  customization_text TEXT,
  stock_quantity INTEGER,
  badges_json TEXT, -- JSON 数组
  price_tiers_json TEXT, -- JSON 阶梯价格
  visible_attributes_json TEXT, -- 规格参数 JSON
  source_strategy TEXT DEFAULT 'cookie',
  raw_payload_json TEXT, -- 原始完整抓取载荷
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_offers_updated_at ON offers(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_seller_name ON offers(seller_name);
CREATE INDEX IF NOT EXISTS idx_offers_sales_value ON offers(sales_value DESC);
CREATE INDEX IF NOT EXISTS idx_offers_return_rate ON offers(return_rate_percent DESC);

-- 2. 采购购物车表 (Buyer Cart Items)
CREATE TABLE IF NOT EXISTS cart_items (
  cart_item_id TEXT PRIMARY KEY,
  offer_id TEXT,
  seller_name TEXT,
  seller_url TEXT,
  title TEXT NOT NULL,
  item_url TEXT,
  image_url TEXT,
  spec_name TEXT,
  price REAL,
  quantity INTEGER DEFAULT 1,
  subtotal REAL,
  status TEXT DEFAULT 'normal', -- normal,失效,降价
  raw_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (offer_id) REFERENCES offers(offer_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cart_seller ON cart_items(seller_name);

-- 3. 采购订单表 (Buyer Orders)
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  seller_name TEXT,
  seller_url TEXT,
  status_text TEXT,
  total_amount REAL,
  currency TEXT DEFAULT 'CNY',
  order_time TEXT,
  items_json TEXT, -- JSON 数组
  raw_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status_text);
CREATE INDEX IF NOT EXISTS idx_orders_time ON orders(order_time DESC);

-- 4. 检索历史表 (Search Audits)
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_type TEXT NOT NULL, -- 'text' 或 'image'
  query_content TEXT NOT NULL, -- 关键词或图片路径/URL
  result_count INTEGER DEFAULT 0,
  result_offer_ids_json TEXT, -- 匹配到的商品 ID 列表
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_history_time ON search_history(executed_at DESC);

-- 5. 操作与审计痕迹表 (Audit Logs)
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL, -- search, item_fetch, cart_sync, order_sync, diagnose
  target_id TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
