# 变更日志 (CHANGELOG)

本项目遵循语义化版本控制与确定性对账演化规范。

## [1.2.0] - 2026-11-13

### Added
- **对标 OneBound（36 接口）与 JustOneAPI（21 接口）全量补齐 1688 缺失轮子**：
  - `opencli-fork/clis/1688/item.js` 与 `shared.js` 新增完整 SKU 矩阵提取（`sku_matrix` / `sku_count`）、详情图文与物流摘要。
  - `opencli-fork/clis/1688/search.js` 与 `1688-cli.js` 补全 `--sort`（销量/价格/回头率）、`--price-min`、`--price-max` 与 `--scene`（找工厂/跨境专区）筛选。
  - 新增 6 个 1688 适配器：`reviews.js`（商品评价）、`shop-items.js`（店铺商品与分类）、`fee.js`（运费测算）、`suggest.js`（搜索联想词）、`similar.js`（同款与同行还在看）、`factory-search.js`（找工厂检索）。
- **上游 API 对标巡检与自动脚手架引擎 (`src/parity.js`, `docs/parity_registry.json`)**：
  - 新增 `1688-ops parity [--check] [--json] [--scaffold]`，实时拉取 OneBound 与 JustOneAPI 在线端点目录并与本地 1688/淘宝轮子对比，发现缺口自动生成脚手架并输出 `docs/api_parity_matrix.md`。
- **热备直连降级网关 (`src/api_fallback.js`)**：
  - 新增 `1688-ops fallback <justoneapi|onebound> <1688|taobao> <endpoint>`，按需从环境变量或 1Password 读取凭据。
- **自动监控闭环 (`CAD-20261113-ecommerce-wheel-parity-sentinel`)**：
  - 建立 Paseo 凌晨定期巡检（`25 3 * * 1,4`），自动监控上游缺口并触发吸收补齐，同时在 `vendor-asset-feature-radar` 中纳入 JustOneAPI 与 OneBound 资产。

## [1.1.1] - 2026-11-11

### Fixed
- `src/diagnose.js` 支持通过 `HUB_1688_ADAPTER_SRC` 与 `HUB_1688_ADAPTER_DEST` 环境变量覆写适配器路径，与 `scripts/install-adapters.sh` 对齐。
- `tests/adapter_contract.test.js` 与 `tests/diagnose.test.js` 在无本地 OpenCLI 运行环境的 CI runner 上自动构造隔离临时适配器夹具，消除对宿主机目录的硬编码依赖。

## [1.1.0] - 2026-11-11

### Added
- **自动化多页分页 (Multi-page Pagination)**：
  - `opencli-fork/clis/1688/search.js` 支持 `--pages` 参数，基于 `s.1688.com` 原生 `beginPage` 参数实现跨页并发抓取与去重。
  - `opencli-fork/clis/1688/orders.js` 支持买家采购订单跨页拉取。
  - `HubClient1688.search` 与 `1688-cli.js search` 统一接入 `--pages` 控制。
- **智能货源推理与决策引擎 (`src/reasoner.js`)**：
  - 供应商可信度评分模型 (0-100)：涵盖复购率(30%)、验厂资质(25%)、动销表现(20%)、履约时效(15%)与价格稳定性(10%)。
  - 阶梯批发价与折让幅度分析 (`analyzePriceTiers`)。
  - 跨境出海单件毛利与单位经济模型 (`estimateMarginAndProfit`)：精准测算采购出厂价、到仓落地总成本、目标零售价、单件毛利与保本广告投产比 (Break-Even ROAS)。
  - 7 项核心风险触发器排查 (`evaluateRiskTriggers`)：覆盖低回头率、无退换保障、高起订量、零动销、非源头工厂、缺少阶梯价、宽价格跨度防引流。
  - 全量操作员行动决议生成 (`RECOMMENDED` / `CONDITIONAL` / `HIGH_RISK`)。
- **新增 CLI 指令 `1688-ops reason`**：
  - 支持 `1688-ops reason <offer_id> [--target-price P] [--currency USD] [--live] [--json]`。
  - 支持离线真理库秒级推导与现场在线拉取对账。
- **全量单元测试与端到端验算**：
  - 新增 `tests/reasoner.test.js`，包含 9 项纯函数与端到端决策测试，测试总数增至 36 项，通过率 100%。

## [1.0.0] - 2026-11-10

### 初始发布与核心架构建立
- **统一所有权收敛 (Fix the Real Owner)**：
  - 定位并修复 `./` 与 `~/.opencli/clis/1688`。
  - 重写 `shared.js` 中的 `parsePriceText`，采用严格的货币符号锚定匹配，彻底杜绝促销文本中的年份（如 2026）、天数（如 90天）和回头率百分比串入价格区间。
  - 修复 `search.js` 现代卡片布局（`offerCard--`）下的 scoped 标题与单价提取逻辑。
  - 重写 `auth.js` 认证检测逻辑，移除阻塞式首页导航，实现毫秒级登录身份与会话状态提取。
- **新增 OpenCLI 适配器**：
  - `cart.js`：提取买家采购车/进货单列表，支持多规格 SKU、店铺名称与有效状态。
  - `orders.js`：拉取买家采购订单列表，兼容 Quark/Shadow DOM 组件。
  - `image-search.js`：实现拍立淘以图搜款，采用 DOM DataTransfer 动态文件注入规避 CDP 权限异常。
- **构建单一事实来源 (Single Source of Truth, SSOT)**：
  - 采用原生 SQLite（`data/1688_ops.db`）作为全局数据真理库。
  - 建立 `offers`、`cart_items`、`orders`、`search_history` 与 `audit_logs` 五大核心表。
  - 自动外键关联与商品占位注册机制，确保在拉取购物车与订单时自动补齐商品主档。
- **可观测性与对账器 (Diagnostic-First)**：
  - 实现“能读”：`1688-ops diagnose` 全面检查环境、数据统计与 10 个适配器的 SHA-256 同步状态。
  - 实现“能试”：`1688-ops diagnose --test-parser` 提供纯函数对账白盒证据。
  - 实现“能调”：`1688-ops diagnose --reconcile` 实现源码区向运行区的受控热同步。
- **全局 CLI 与技能套件**：
  - 提供全局独立命令行工具 `1688-ops` 与 `1688-cli`（软链至 `~/.local/bin`）。
  - 创建官方 Agent Skill `1688-ops`，并在 `internal-docs` 建立镜像。
- **全量测试套件 (27/27 全部通过)**：
  - `tests/unit_parsers.test.js`：纯函数解析器 16 项单元测试。
  - `tests/db.test.js`：SQLite 存储与派生计算 5 项测试。
  - `tests/adapter_contract.test.js`：适配器防漂移契约 3 项测试。
  - `tests/diagnose.test.js`：诊断器 3 项测试。
