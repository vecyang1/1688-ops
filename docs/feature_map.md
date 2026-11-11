# 1688 批发采购与数据对账系统功能图谱

本文档定义 1688 批发采购与数据对账系统（`1688-ops`）的完整功能全景、分层调用拓扑、数据流转方向，以及当前已实现接口与下一阶段规划契约规范。

---

## 1. 系统分层全景图

系统采用垂直五层架构，遵循单向数据流与单一事实来源设计准则，全栈基于原生 ESM 与零外部 NPM 依赖构建。

```
+===================================================================================+
|                                1. 接入与调度层                                     |
+===================================================================================+
| [终端控制台] 1688-ops (bin/1688-cli.js)                                           |
|    |-- 基础诊断: doctor / whoami                                                  |
|    |-- 货源检索: search [--limit 10] [--no-sync] / [--pages] [--sort] [M2 规划]   |
|    |-- 拍立淘搜: image-search <path|url> [--limit 10]                             |
|    |-- 深度详情: item <offer_id> / [--no-sync] [M3 规划]                          |
|    |-- 供应商库: store <member_id|url>                                            |
|    |-- 交易对账: cart [--no-sync] / orders [--no-sync] [--status all]             |
|    |             / [--pages] [M2 规划]                                            |
|    |-- 离线真理: db (list / stats / cart / orders) / inspect <offer_id>           |
|    |-- 供货推理: reason <offer_id> [--target-price] [--freight-rate]              |
|    |             [--fresh] [--json] [M3 规划]                                     |
|    +-- 自治运维: diagnose (--test-parser / --reconcile) / install-adapters        |
|                                     |                                             |
|                                     v                                             |
| [编程客户端] HubClient1688 (src/client.js)                                        |
|    +-- OpenCLI 进程调度、超时看门狗 75s、JSON 提取、容错降级                      |
+===================================================================================+
                                      |
                                      v
+===================================================================================+
|                           2. 适配器与数据采集层                                   |
+===================================================================================+
| [源码真理库] ./                          |
| [运行热区]   ~/.opencli/clis/1688 (双向 SHA-256 零漂移校验)                       |
|    |-- search.js       : 关键词检索 (多页自动推导与 beginPage 翻页为 [M2 规划])   |
|    |-- image-search.js : 拍立淘图片上传、特征签名提取、相似款召回                 |
|    |-- item.js         : 商品详情、起订量、梯度价格 (完整 SKU 矩阵为 [M3 规划])   |
|    |-- store.js        : 工厂认证、入驻年限、复购率、企业资质                     |
|    |-- cart.js         : 买家采购车拉取、失效标记与规格解析                       |
|    |-- orders.js       : 采购历史订单流水拉取 (多页循环拉取为 [M2 规划])          |
|    |-- auth.js         : 登录态探针与身份识别                                     |
|    |-- shared.js       : 原生 URL 生成器、DOM 提取器、反爬避让策略                |
|    |-- assets.js       : 详情页主图与视频媒体资源下载                             |
|    +-- download.js     : 大文件流式安全落盘工具                                   |
|                                     |                                             |
|                                     v (依赖原生 Chrome 会话)                      |
| [浏览器原生会话] Chrome CDP / Cookies / window.context / DOM                      |
+===================================================================================+
                                      |
                                      v
+===================================================================================+
|                          3. 纯函数解析与智能推理层                                |
+===================================================================================+
| [纯函数解析引擎] (src/extractor.js)                                               |
|    |-- cleanText              : 空白与特殊换行符规整化                            |
|    |-- parsePriceText         : 优先区间与带货币符号单价；无符号整数剔除 2020-2030|
|    |-- parseMoq               : 起订量规范化提取 (件/套/个/批)                    |
|    |-- parseSales             : 万级销售文本派生为绝对整数 (如 1.4万+ -> 14000)   |
|    |-- parseReturnRate        : 复购率文本派生为浮点百分比 (如 38% -> 38.0)       |
|    |-- extractOfferId         : 1688 商品唯一不可变编号提取                       |
|    +-- extractShopIdentifiers : 店铺域名与 memberId 提取                          |
|                                                                                   |
| [供货决策推理引擎] (src/reasoner.js) [M3 规划]                                    |
|    |-- 供应商综合可靠度评级 (0-100 分): 回头率/认证/时效/年限加权, A-D 级评级     |
|    |-- 阶梯价格与起订量结构分解: 梯度阶梯/单价降幅/最大折扣率计算                 |
|    |-- 目标售价毛利与保本测算: 加价倍数/毛利率/保本红线/各阶梯采买利润模拟        |
|    +-- 7 项布尔风险预警规则: 低复购/无退货保障/无工厂认证/新店/慢发货/高MOQ/高价差|
+===================================================================================+
                                      |
                                      v
+===================================================================================+
|                         4. 单一事实真理持久化层                                   |
+===================================================================================+
| [数据访问层] (src/db.js) 基于 Node.js 原生 node:sqlite (DatabaseSync)             |
| 数据库文件: data/1688_ops.db (WAL 模式, 外键开启)                                 |
|    |-- offers          : 核心商品真理表 (包含原始抓取载荷与派生字段)              |
|    |-- cart_items      : 采购车条目与规格状态表                                   |
|    |-- orders          : 采购订单历史表                                           |
|    |-- search_history  : 检索审计与结果映射表                                     |
|    +-- audit_logs      : 系统操作行为与数据流水审计表                             |
+===================================================================================+
                                      |
                                      v
+===================================================================================+
|                         5. 可观测与自治运维层                                     |
+===================================================================================+
| [对账诊断器] (src/diagnose.js)                                                    |
|    |-- 能读对账 : 环境版本、数据库容量与统计、10 个适配器 SHA-256 哈希            |
|    |-- 能试验算 : 真实脏样本白盒推导，验证价格、年份、销量无偏解析                |
|    +-- 能调同步 : 源码区至运行区一键热同步与守护进程状态确认                      |
| [契约防漂移套件] (tests/adapter_contract.test.js)                                 |
|    +-- 源码与运行区 100% 字节级一致性校验，防范多地开发代码分叉                   |
+===================================================================================+
```

---

## 2. 数据流转架构与生命周期

系统遵循严格的单向数据流管道：

### 2.1 写入流（在线抓取至派生入库）
1. 命令行触发在线指令（`search` / `item` / `cart` / `orders`）。
2. `HubClient1688` 调度底层 `opencli 1688 <subcommand> -f json`。
3. 适配器在浏览器原生会话中执行，解析页面元素或提取 `window.context`。
4. 返回结构化 JSON 数据至 `HubClient1688`。
5. 纯函数解析器（`extractor.js`）介入，从原始文本派生标准数值（`sales_value`, `return_rate_percent`, `price_min`, `price_max`）。
6. 数据访问层（`db.js`）开启事务，向 `offers`, `cart_items`, `orders` 执行基于主键的冲突更新写入。
7. 写入检索历史（`search_history`）与操作审计日志（`audit_logs`）。

```
[CLI] ---> [HubClient1688] ---> [OpenCLI Adapter] ---> [Chrome Context]
                                                             |
[SQLite DB] <--- [db.js UPSERT] <--- [extractor.js] <--------+
```

### 2.2 读取流（离线秒级检索）
1. 命令行触发离线指令（`1688-ops db list`, `1688-ops db stats`, `1688-ops inspect <offer_id>`）。
2. 数据访问层直连本地 SQLite 读取最新快照。
3. 支持关键词匹配（`keyword`）、排序策略（`sales` 降序、`return_rate` 降序、`price_asc` 升序）。
4. 格式化输出为终端表格或结构化 JSON，无任何网络延迟与封控风险。

```
[CLI] <--- [db.js Query / Sort] <--- [SQLite data/1688_ops.db]
```

### 2.3 决策推理流（供货分析与风险研判）[M3 规划]
1. 命令行触发推理指令（`1688-ops reason <offer_id> --target-price 50`）。
2. 优先从本地 SQLite 真理库读取该商品；若未命中或指定 `--fresh`，自动调用 `HubClient1688.getItem(offer_id)` 实时拉取并落库。
3. 将商品数据与选项传入 `src/reasoner.js` 的 `evaluateOffer(offer, options)`。
4. 推理引擎执行：
   - 供应商多维信誉加权打分（0-100 分）与等级映射（A/B/C/D）。
   - 阶梯价格分解与起订量梯度计算。
   - 目标售价毛利测算、加价倍率与保本红线推导。
   - 7 项布尔风险拦截规则判定。
5. 输出全景采购决策建议并记录审计日志。

```
[1688-ops reason]
       |
       v
[Local SQLite SSOT] ---> (未命中或指定 --fresh) ---> [HubClient1688.getItem()] ---> [Upsert DB]
       |
       v
[src/reasoner.js: evaluateOffer()]
       |-- 供应商可靠度评分 (0-100, Grade A-D)
       |-- 起订量与价格阶梯分解
       |-- 毛利与保本推演
       +-- 7 项风控规则触发检查
       |
       v
[结构化采购决策报告]
```

---

## 3. 核心接口与数据契约规范

### 3.1 命令行接口契约

| 子命令 | 实现状态 | 关键参数 | 行为契约 | 输出形态 |
|---|---|---|---|---|
| `doctor` | 已实现 | 无 | 检查浏览器会话、账号身份与桥接状态 | 控制台文本 |
| `whoami` | 已实现 | 无 | 输出当前登录买家或卖家账号核心字段 | 结构化 JSON |
| `search` | 已实现（翻页/排序为 M2 规划） | `<keyword> [--limit 10] [--no-sync]` `[--pages 1] [M2 规划]` `[--sort] [M2 规划]` | 当前默认单页上限 10 条并入库；M2 扩展支持多页翻页与自动分页 | 控制台表格 / JSON |
| `image-search` | 已实现 | `<path\|url> [--limit 10]` | 拍立淘视觉相似货源检索并入库 | 控制台表格 / JSON |
| `item` | 已实现（不入库选项与 SKU 矩阵为 M3 规划） | `<offer_id>` `[--no-sync] [M3 规划]` | 当前提取商品详情、多图与起订量并入库；M3 扩展完整 SKU 矩阵与不入库开关 | 控制台详情卡片 |
| `store` | 已实现 | `<member_id\|url>` | 店铺档案、入驻年限、实力工厂与资质抓取 | 控制台档案卡片 |
| `cart` | 已实现 | `[--no-sync]` | 买家采购车抓取、失效商品标注与入库 | 控制台表格 |
| `orders` | 已实现（跨页循环为 M2 规划） | `[--status all] [--no-sync]` `[--pages 1] [M2 规划]` | 买家采购订单流水抓取与入库；适配器和客户端已透传状态与页数参数，M2 补全多页遍历循环 | 控制台表格 |
| `reason` | [M3 规划] | `<offer_id> [--target-price P] [--freight-rate F] [--fresh] [--json]` | 触发供货智能推理引擎，输出供应商评级、阶梯毛利与风险预警 | 控制台决策报告 / JSON |
| `db list` | 已实现 | `[--limit 20] [--keyword K] [--sort sales\|return_rate\|price_asc]` | 离线真理库检索，多维排序，毫秒级响应 | 控制台表格 |
| `db stats` | 已实现 | 无 | 统计本地商品数、采购车项、订单数与检索历史 | 控制台卡片 |
| `inspect` | 已实现 | `<offer_id>` | 深度白盒审计单个商品的原始抓取文本与派生数值 | 控制台审计报告 |
| `diagnose` | 已实现 | `[--test-parser] [--reconcile]` | 可观测性对账器：默认读取状态，支持解析验算与适配器热同步 | 控制台报告 / JSON |
| `install-adapters`| 已实现 | 无 | 将适配器源码同步到 OpenCLI 运行区并执行 SHA-256 校验 | 控制台回执 |

### 3.2 纯函数解析契约 (`src/extractor.js`)

| 函数 | 输入 | 保证输出契约 | 边界规约 |
|---|---|---|---|
| `cleanText(text)` | `string` | 规整空白字符后的单行字符串 | 空或非字符串输入安全返回空字符串 |
| `parsePriceText(text)` | `string` | `{ price_text, price_min, price_max, currency }` | 优先匹配价格区间；次之匹配带货币符号单价；无货币符号的纯数字兜底分支仅当数值为 2020-2030 之间整数时作为年份干扰剔除并返回空 |
| `parseMoq(text)` | `string` | `{ moq_text, moq_value }` | 提取件/套/个/批/起批/起订前的整数，无法解析则数值为 null |
| `parseSales(text)` | `string` | `{ sales_text, sales_value }` | 支持万级换算（如 `1.4万+` 换算为 14000），无销量返回 null |
| `parseReturnRate(text)`| `string` | `{ return_rate_text, return_rate_percent }` | 提取百分比浮点数（如 38.0），无回头率返回 null |
| `extractOfferId(url)` | `string` | `string \| null` | 正则提取链接中的 `/offer/(\d+).html` 或 `offerId=(\d+)` |

### 3.3 多页翻页扩展契约 (`search.js` 与 `orders.js`) [M2 规划]

1. **`search.js` 与 `shared.js` 分页规范 [M2 规划]**：
   - `shared.js` 导出函数签名：`buildSearchUrl(query, page = 1)`。
   - 参数化 URL 模板：`https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=${query}&beginPage=${page}`，并在翻页调用时将当前页码透传给构造器。
   - 自动分页推导公式：当命令行未显式指定 `--pages` 且 `--limit > 20` 时，自动计算目标抓取页数 `pages = Math.ceil(limit / 20)`。
   - 保护上限常量：单次搜索结果数量上限 `SEARCH_LIMIT_MAX = 100`，最大翻页深度上限 `MAX_SEARCH_PAGES = 12`。
   - 跨页去重与持久化：在翻页循环内基于不可变 `offer_id` 执行内存去重，并将每页或聚合结果实时写入 SQLite 真理库。

2. **`orders.js` 订单历史翻页规范 [M2 规划]**：
   - 接口支持 `pages` 参数（默认 1）与 `status` 参数（默认 `all`，枚举支持 `all`, `waitpay`, `waitsellersend`, `waitbuyerreceive`, `success`, `cancel`）。
   - 执行从第 1 页到第 `pages` 页的循环翻页抓取，逐页点击/导航分页控件并检查页面空状态或重复页停机条件。
   - 基于订单主键 `order_id` 执行跨页幂等合并去重，最终写入 `orders` 表。

### 3.4 商品详情 SKU 矩阵提取契约 (`item.js`) [M3 规划]

- 函数 `normalizeItemPayload(payload)` 在保留现有主图、起订量、价格阶梯及服务承诺的基础上，扩展输出结构化 SKU 矩阵字段：
  ```javascript
  sku_matrix: Array<{
    sku_id: string,
    spec_id: string,
    spec_text: string,
    price: number | null,
    stock: number | null,
    image_url: string | null
  }>
  ```
- **提取源字段映射关系（提取自页面 `window.context`）**：
  - `skuProps`：提取各规格维度名称、规格值文本以及对应的规格预览图片地址（映射至 `spec_text`, `image_url`）。
  - `skuMap`：以规格组合名称或编号为键，提取对应独立 `skuId`、`specId`、单品可售库存 `canBookCount` 与单规格售价（映射至 `sku_id`, `spec_id`, `stock`, `price`）。
  - `orderParam` 与 `skuRangePrices`：结合起批模式与多档数量区间规则，核对并补全按阶梯起订变化的 SKU 基准报价。

### 3.5 供货推理引擎契约 (`src/reasoner.js`) [M3 规划]

**函数签名**:
```javascript
export function evaluateOffer(offer, options = {})
```

**输入参数**:
- `offer`：商品主档对象（来自数据库 `offers` 表或 `client.getItem()` 返回值）
- `options`：可选评估配置对象
  - `targetPrice`：预期零售或分销目标价（数值，单位元）
  - `freightRate`：预估物流损耗费率（浮点数，如 0.05 代表 5%）

**输出契约结构**:
```javascript
{
  offer_id: "1024786474053",
  title: "户外便携折叠椅超轻露营钓鱼凳",
  supplier_reliability: {
    score: 84.5, // 0-100 分
    grade: "B",  // A: >=90, B: 75-89, C: 60-74, D: <60
    breakdown: {
      return_rate: { value: 38.0, points: 26.6, max: 35 },             // 权重 35%
      badges: { list: ["实力商家", "深度验厂"], points: 25.0, max: 25 }, // 权重 25%
      delivery: { text: "48小时发货", points: 15.0, max: 20 },          // 权重 20%
      years: { text: "入驻5年", points: 17.9, max: 20 }                 // 权重 20%
    }
  },
  moq_and_tiers: {
    moq: 2,
    unit: "件",
    tiers: [
      { min_quantity: 2, max_quantity: 49, price: 28.5 },
      { min_quantity: 50, max_quantity: 199, price: 25.0 },
      { min_quantity: 200, max_quantity: null, price: 22.0 }
    ],
    max_discount_percent: 22.81
  },
  profit_and_margin: {
    target_price: 59.0,
    cost_base: 28.5,
    gross_profit: 30.5,
    gross_margin_percent: 51.69,
    markup_multiple: 2.07,
    breakeven_price: 30.0,
    simulation_by_tier: [
      { quantity: 2, unit_cost: 28.5, unit_profit: 30.5, margin_percent: 51.69 },
      { quantity: 50, unit_cost: 25.0, unit_profit: 34.0, margin_percent: 57.63 },
      { quantity: 200, unit_cost: 22.0, unit_profit: 37.0, margin_percent: 62.71 }
    ]
  },
  risk_warnings: [
    {
      rule: "RETURN_RATE_LOW",
      level: "MEDIUM",
      message: "店铺回头率低于行业基准 20%"
    }
  ]
}
```

**7 项布尔风控预警规则全集**:

| 规则标识 | 触发阈值条件 | 风险级别 | 业务含义 |
|---|---|---|---|
| `RETURN_RATE_LOW` | `return_rate_percent` 低于 `20.0`（含为空时按无复购信誉提示） | `MEDIUM` | 复购粘性不足，需核查实际产品质量稳定性 |
| `NO_RETURN_INSURANCE` | 服务保障标签中缺失 `退货包运费` | `LOW` | 样品或批量退换货需自行承担退回物流成本 |
| `NO_FACTORY_CERT` | 资质标签缺失 `源头工厂`、`深度验厂` 与 `实力工厂` | `MEDIUM` | 存在贸易商转手或中间加价风险，议价空间受限 |
| `NEW_SHOP` | 提取到的入驻年限小于 `2` 年 | `LOW` | 平台履约历史沉淀较短，建议小额拿样测试 |
| `SLOW_DELIVERY` | 发货时效文本超过 `72` 小时或完全缺失承诺时效 | `MEDIUM` | 供应链备货周期较长，影响动销补货节奏 |
| `HIGH_MOQ` | 派生起订量 `moq_value` 高于 `500` 件 | `MEDIUM` | 首单起订资金占用过高，试错成本大 |
| `EXTREME_PRICE_GAP` | 区间最高价与最低价离散度或最高阶梯降幅超过 `50%` | `HIGH` | 存在低价引流 SKU 或配件混挂虚标主价的可能 |

**缺省与降级容错策略**:
- **`targetPrice` 缺省降级**：当调用方未传入 `targetPrice` 或传入非正数时，`profit_and_margin` 仅返回成本基准价 `cost_base` 与各阶梯单价，跳过目标毛利、毛利率、加价倍率及各阶梯利润模拟计算（对应字段置 `null`），确保评分与风控推演正常返回。
- **`years` 入驻年限缺失降级**：当商品或店铺载荷中缺失入驻年限文本无法提取数字时，年限维度（满分 20 分）不直接归零，而是赋予保守中位数基准分 `10` 分，避免因页面结构差异误判优质商家为高风险。

---

## 4. 可观测性与三能对账器体系

系统内置三位一体对账机制，确保生产环境运行状态透明可控：

1. **能读对账**
   - 随时审查 Node 环境版本、OpenCLI 运行状态。
   - 审查本地 SQLite 真理库物理路径、文件大小、各表记录总数。
   - 审查 10 个适配器文件的源码与运行态 SHA-256 指纹比对，量化未同步文件数。
2. **能试验算**
   - 使用包含复杂年份串入（如 2026）、多重价格区间、脏促销文本、万级销量文本的现场测试样本。
   - 调用生产环境的提取函数即时验算，输出期望与实际对比，确保算法零漂移。
3. **能调同步**
   - 从源码归属目录（`./`）自动递归复制所有适配器文件到运行时目录（`~/.opencli/clis/1688`）。
   - 校验复制后字节哈希一致性，杜绝本地修改未生效的静默故障。
