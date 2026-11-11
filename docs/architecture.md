# 1688 批发采购与数据对账系统架构契约

本文档规定 1688 批发采购与数据对账系统（`1688-ops`）的核心架构设计哲学、模块物理边界、数据流向、状态机转换规则、数据库存储模型以及反爬容错机制。

---

## 1. 架构设计哲学与原则

### 1.1 原生 ESM 与现代平台能力
项目完全拥抱 Node.js 22+ 原生 ESM 模块体系与内置工程化能力：
- 采用原生 `node:sqlite`（`DatabaseSync`）替代第三方 SQLite 驱动，直接利用 V8 引擎内部高效绑定，实现零编译依赖与极致吞吐。
- 采用原生 `node:test` 与 `node:assert/strict` 组装轻量级单元与集成测试套件，杜绝大型测试框架的依赖膨胀。
- 采用原生 `node:child_process`（`execFile`）与 `node:util` 实现异步进程编排与看门狗。

### 1.2 零外部 NPM 依赖
生产代码与测试代码的 `package.json` 不包含任何三方 NPM 生产依赖：
- 彻底消除供应链攻击、间接依赖投毒与不可控的语义化版本破损。
- 保持运行态轻量敏捷，冷启动耗时低于 30ms，适合嵌入自动化工作流与微代理调度。
- 适配各种受限环境、容器镜像与边缘计算节点。

### 1.3 单一事实来源
- 本地 SQLite（`data/1688_ops.db`）是整个系统状态的唯一终态真理库。
- 在线抓取的原始载荷（`raw_payload_json`）与结构化提取字段协同落库，保障数据可溯源与可白盒审计。
- 离线查询优先直连 SQLite，提供毫秒级多维排序与关键词筛选，将对 1688 目标站点的网络探测与会话暴露降至最低。

### 1.4 能派生不另存
- 原始页面文本（如 `1.4万+件`、`回头率 38%`、`¥25.00-38.00`）作为现场凭据严格保存。
- 派生整数与浮点数（如 `sales_value: 14000`、`return_rate_percent: 38.0`、`price_min: 25.0`）由纯函数在摄取管道中即时推导并建立索引，满足业务聚合计算。

### 1.5 适配器唯一源码与防漂移原则
- 适配器唯一开发真理库为 `./`。
- 运行时目录 `~/.opencli/clis/1688` 为执行镜像。
- 架构内建 `adapter_contract.test.js` 与 `diagnose.js`，通过 SHA-256 哈希比对实行硬性防漂移约束。

---

## 2. 系统架构与模块边界划分

系统逻辑上划分为六大核心模块，遵循高内聚、低耦合原则：

```
+---------------------------------------------------------------------------------+
|                                 bin/1688-cli.js                                 |
|                         (CLI 门面层: 命令解析与终端呈现)                         |
+---------------------------------------------------------------------------------+
          |                                               |
          v                                               v
+-----------------------------+               +-----------------------------------+
|        src/client.js        |               |          src/diagnose.js          |
| (HubClient1688 适配调度客户端)|               |    (可观测性对账器: 能读/试/调)     |
+-----------------------------+               +-----------------------------------+
          |                                               |
          v                                               v
+-----------------------------+               +-----------------------------------+
|   OpenCLI 适配器 (10个)     |               |    OpenCLI 运行区与源码区热同步   |
| (search, item, cart, etc.)  |               | (~/.opencli <-> opencli-fork)     |
+-----------------------------+               +-----------------------------------+
          |                                               |
          +-----------------------+   +-------------------+
                                  |   |
                                  v   v
+---------------------------------------------------------------------------------+
|                               src/extractor.js                                  |
|                      (纯函数解析层: 数据清洗与标准化派生)                        |
+---------------------------------------------------------------------------------+
                                  |
          +-----------------------+-----------------------+
          |                                               |
          v                                               v
+-----------------------------+               +-----------------------------------+
|  src/reasoner.js [M3 规划]  |               |            src/db.js              |
|   (供货决策与智能推理引擎)   |               |   (原生 SQLite 数据访问与事务)    |
+-----------------------------+               +-----------------------------------+
                                                          |
                                                          v
                                              +-----------------------------------+
                                              |        data/1688_ops.db           |
                                              |      (WAL 模式持久化真理库)        |
                                              +-----------------------------------+
```

### 2.1 模块职责矩阵

| 模块文件 | 角色与定位 | 允许依赖 | 禁止行为 |
|---|---|---|---|
| `bin/1688-cli.js` | 终端 CLI 入口，参数解析与表格/卡片渲染 | `node:util`, `src/db.js`, `src/client.js`, `src/diagnose.js`, `src/reasoner.js`（预留） | 禁止直接执行 SQL 裸语句或直接调用底层 child_process |
| `src/client.js` | 编程客户端，编排 OpenCLI 命令与看门狗超时 | `node:child_process`, `node:util`, `src/db.js`, `src/extractor.js` | 禁止直接依赖终端 UI 或控制台打印输出 |
| `src/extractor.js` | 纯函数解析器，处理价格、销量、回头率、起订量 | 原生 JavaScript 标准库（零 I/O 依赖） | 禁止产生副作用、禁止读写文件或访问网络/数据库 |
| `src/reasoner.js` [M3 规划] | 确定性供货决策推理引擎，计算评级、毛利与风控 | 原生 JavaScript 标准库、`src/extractor.js` | 禁止包含不确定的随机数或外部黑盒模型调用 |
| `src/db.js` | 数据访问层，管理表结构与事务性持久化 | `node:sqlite`, `node:fs`, `node:path`, `src/extractor.js` | 禁止绕过主键约束执行无校验写入 |
| `src/diagnose.js` | 系统体检与自愈，支持三能对账与适配器同步 | `node:fs`, `node:path`, `node:crypto`, `node:child_process`, `src/db.js`, `src/extractor.js` | 禁止修改源码区文件（仅允许源码区向运行区单向同步） |

---

## 3. 核心表结构定义与索引拓扑

数据库持久化层采用 SQLite WAL 模式，开启外键级联检查。

### 3.1 商品真理表 (`offers`)
记录 1688 商品主档数据、供应商资质及提取清洗后的规格阶梯。

```sql
CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT PRIMARY KEY,               -- 1688 唯一商品编号 (不可变主键)
  title TEXT NOT NULL,                     -- 商品标题
  member_id TEXT,                          -- 商家会员号
  shop_id TEXT,                            -- 店铺唯一二级标识
  seller_name TEXT,                        -- 供应商公司名称
  seller_url TEXT,                         -- 供应商店铺主页
  item_url TEXT NOT NULL,                  -- 商品直达链接
  image_url TEXT,                          -- 商品首图
  main_images_json TEXT,                   -- 主图多图列表 (JSON 数组)
  price_text TEXT,                         -- 原始展示价格文本 (如 "¥28.50-32.00")
  price_min REAL,                          -- 派生最小单价 (如 28.5)
  price_max REAL,                          -- 派生最大单价 (如 32.0)
  currency TEXT DEFAULT 'CNY',             -- 货币类型
  moq_text TEXT,                           -- 原始起订量文本 (如 "2件起批")
  moq_value INTEGER,                       -- 派生起订量数值 (如 2)
  sales_text TEXT,                         -- 原始销量文本 (如 "月销1.2万+件")
  sales_value INTEGER,                     -- 派生销售总数 (如 12000)
  return_rate_text TEXT,                   -- 原始回头率文本 (如 "回头率 41.5%")
  return_rate_percent REAL,                -- 派生回头率百分比 (如 41.5)
  location TEXT,                           -- 货源所在地 (如 "浙江金华")
  delivery_days_text TEXT,                 -- 发货时效说明 (如 "48小时发货")
  customization_text TEXT,                 -- 定制服务说明
  stock_quantity INTEGER,                  -- 当前总库存
  badges_json TEXT,                        -- 实力标签 (JSON 数组: 实力商家/深度验厂等)
  price_tiers_json TEXT,                   -- 阶梯价格与MOQ (JSON 数组)
  visible_attributes_json TEXT,            -- 属性规格列表 (JSON 键值对)
  source_strategy TEXT DEFAULT 'cookie',   -- 抓取途径 (cookie/token)
  raw_payload_json TEXT,                   -- 原始未经清洗的抓取载荷
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_offers_updated_at ON offers(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_seller_name ON offers(seller_name);
CREATE INDEX IF NOT EXISTS idx_offers_sales_value ON offers(sales_value DESC);
CREATE INDEX IF NOT EXISTS idx_offers_return_rate ON offers(return_rate_percent DESC);
```

### 3.2 采购购物车表 (`cart_items`)
记录买家采购车条目与关联的商品状态。

```sql
CREATE TABLE IF NOT EXISTS cart_items (
  cart_item_id TEXT PRIMARY KEY,           -- 购物车条目唯一 ID
  offer_id TEXT,                           -- 关联商品 ID (外键)
  seller_name TEXT,                        -- 供应商名称
  seller_url TEXT,                         -- 店铺链接
  title TEXT NOT NULL,                     -- 商品标题
  item_url TEXT,                           -- 商品链接
  image_url TEXT,                          -- 规格图片
  spec_name TEXT,                          -- 规格/属性名称
  price REAL,                              -- 加入购物车时的单价
  quantity INTEGER DEFAULT 1,              -- 采购数量
  subtotal REAL,                           -- 金额小计
  status TEXT DEFAULT 'normal',            -- 状态: normal, 失效, 降价
  raw_payload_json TEXT,                   -- 原始载荷
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (offer_id) REFERENCES offers(offer_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cart_seller ON cart_items(seller_name);
```

### 3.3 采购订单表 (`orders`)
记录买家历史订单与履约状态流水。

```sql
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,               -- 1688 采购订单号
  seller_name TEXT,                        -- 供货商名称
  seller_url TEXT,                         -- 供货商主页
  status_text TEXT,                        -- 订单状态 (如 "交易成功", "等待发货")
  total_amount REAL,                       -- 订单总实付金额
  currency TEXT DEFAULT 'CNY',             -- 货币单位
  order_time TEXT,                         -- 下单时间文本
  items_json TEXT,                         -- 订单商品条目清单 (JSON 数组)
  raw_payload_json TEXT,                   -- 原始完整载荷
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status_text);
CREATE INDEX IF NOT EXISTS idx_orders_time ON orders(order_time DESC);
```

### 3.4 检索历史与审计日志表
```sql
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_type TEXT NOT NULL,                -- 检索类型: 'text' 或 'image'
  query_content TEXT NOT NULL,             -- 关键词或图片地址
  result_count INTEGER DEFAULT 0,          -- 结果数量
  result_offer_ids_json TEXT,              -- 命中商品 ID 集合
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_history_time ON search_history(executed_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,                    -- 行为类型: search, item_fetch, cart_sync, order_sync, diagnose
  target_id TEXT,                          -- 目标资源 ID
  summary TEXT NOT NULL,                   -- 审计摘要
  metadata_json TEXT,                      -- 上下文元数据
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.5 商品 SKU 矩阵持久化演进策略 [M3 规划]

在 M3 阶段，系统将在 `item.js` 适配器中支持完整规格矩阵抽取，输出结构化数组：
`sku_matrix: Array<{ sku_id: string, spec_id: string, spec_text: string, price: number | null, stock: number | null, image_url: string | null }>`。

针对该矩阵的落库持久化，系统采取明确的分阶段演进方案：
1. **第一阶段持久化策略（M3 落地）**：
   - 将解析得到的完整 `sku_matrix` 数组对象直接归入 `offers` 表的 `raw_payload_json` 字段内进行结构化无损保存。
   - 该策略兼顾向下兼容与数据完整性，无需变更既有表模式，即可供决策推理引擎（`reasoner.js`）以及白盒对账工具直接反序列化读取。
2. **第二阶段架构演进规划**：
   - 在后续版本中，计划在 `schema.sql` 中新增独立的明细关联表 `offer_skus`（以 `(offer_id, sku_id)` 作为复合主键，通过外键级联绑定 `offers(offer_id)`）或在 `offers` 表显式扩展 `sku_matrix_json TEXT` 字段。
   - 建立针对 `sku_id`、`price` 与 `stock` 的独立索引，以支撑跨商品细粒度规格级 SQL 检索、库存下限预警以及多规格历史波动对账。

---

## 4. 数据状态机与流转模型

### 4.1 商品数据生命周期状态机

```
       [网络抓取]
           |
           v
  +-----------------+  清洗派生成功   +-------------------+  再次抓取/更新   +-------------------+
  | RAW_DISCOVERED  | ------------> | PARSED_NORMALIZED | --------------> |  UPSERTED_SSOT   |
  +-----------------+               +-------------------+                 +-------------------+
           |                                                                        |
           | 解析失败                                                                v
           v                                                              +-------------------+
  +-----------------+                                                     | REASONING_READY   |
  | DEGRADED_OFFER  | --------------------------------------------------> | [M3 供货推理就绪] |
  +-----------------+               (兜底降级入库)                         +-------------------+
```

1. **RAW_DISCOVERED**: 适配器从 Chrome Context 捕获到原始 HTML 片段或 `window.context`。
2. **PARSED_NORMALIZED**: 经 `extractor.js` 纯函数处理，提取出准确的单价区间、整数销量、起订量与浮点回头率。
3. **DEGRADED_OFFER**: 若原始页面结构剧烈变更或字段缺失，触发容错兜底机制，保留原文本并将数值字段置 null，确保主数据流程不中断。
4. **UPSERTED_SSOT**: 借助 SQLite `INSERT INTO offers (...) ON CONFLICT(offer_id) DO UPDATE` 写入数据库，刷新 `updated_at`。
5. **REASONING_READY**: 存入数据库后的实体具备完整的数据契约，随时可被 `src/reasoner.js` 提取进行多维打分与毛利推演。

---

## 5. 反爬避让、翻页与容错降级机制

1688 作为国内严格风控的电商站点，具备高强度的反爬机制。本系统设计了多重工程化应对策略：

### 5.1 浏览器原生会话复用
- **非无头模式**: 不启动容易被探测的无头无态浏览器实例，而是通过 OpenCLI 挂载用户已登录的原生 Chrome 浏览器会话。
- **真实指纹**: 继承真实的已认证登录态 Cookie、LocalStorage、Canvas 指纹与硬件特征，彻底免除登录握手阶段的风险。

### 5.2 多页翻页平滑避让策略 [M2 规划]
- **参数化 URL 构造**:
  - `shared.js` 导出签名 `buildSearchUrl(query, page = 1)`。
  - 构造模板：`https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=${query}&beginPage=${page}`，翻页时显式透传页码参数。
- **自动分页推算公式**: 当命令行未指定 `--pages` 且指定 `--limit > 20` 时，自动按 `Math.ceil(limit / 20)` 计算所需抓取页数。
- **上限阈值保护**: 单次抓取条数上限限制为 `SEARCH_LIMIT_MAX = 100`，最大翻页深度限制为 `MAX_SEARCH_PAGES = 12`。
- **订单多页对账循环**: `orders.js` 从第 1 页到第 `pages` 页进行遍历，逐页判定空状态与重复页停机条件，按 `order_id` 集合在内存中去重合并后批量入库。
- **延迟抖动与即时落库**: 分页遍历内置随机延迟抖动（1200ms 至 2500ms），严格模拟人类浏览翻页动作；每页抓取后即时增量落库，即便中途遇到网络中断，已抓取数据仍安全落盘。

### 5.3 双重数据提取源互备与 SKU 矩阵提取 [M3 规划]
在 `item.js` 适配器中建立双通道提取体系：
1. **优先信源（内嵌状态树提取 SKU 矩阵）**:
   - 挂载并读取页面内嵌的 `window.context` 原生状态树（包含 `orderParam`、`skuProps`、`skuMap`、`skuRangePrices`）。
   - 提取起订量、梯度价格以及完整结构化矩阵：
     `sku_matrix: Array<{ sku_id, spec_id, spec_text, price, stock, image_url }>`。
   - `skuProps` 提供规格维度名称、属性值与图片；
   - `skuMap` 提供 `skuId`、`specId`、可售库存 `canBookCount` 与基础售价；
   - `orderParam` 与 `skuRangePrices` 提供起订门槛与多档阶梯单价。
2. **备用信源（DOM 降级解析）**: 若页面混淆导致内嵌状态树无法读取，降级启动 DOM 解析器，抓取属性面板与价格阶梯元素，确保核心指标不缺失。

### 5.4 进程级看门狗与超时隔离
- `HubClient1688` 统一封装 75,000ms 执行超时看门狗。
- 若特定请求发生死锁或悬挂，超时信号安全杀死子进程并释放资源，抛出包含结构化错误码（`TIMEOUT`）的异常，防止宿主服务被拖挂。

### 5.5 适配器版本一致性防护
- 适配器开发源码与生产执行镜像分离，通过 `tests/adapter_contract.test.js` 在自动化 CI 中执行 10 个适配器的 SHA-256 哈希比对。
- 支持 `1688-ops diagnose --reconcile` 一键安全对调热部署，杜绝因本地环境适配器版本过旧导致的未知解析崩溃。
