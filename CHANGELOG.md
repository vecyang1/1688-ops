# 变更日志 (CHANGELOG)

本项目遵循语义化版本控制与确定性对账演化规范。

## [1.0.0] - 2026-11-10

### 初始发布与核心架构建立
- **统一所有权收敛 (Fix the Real Owner)**：
  - 定位并修复 `~/Documents/A-coding/opencli-fork/clis/1688` 与 `~/.opencli/clis/1688`。
  - 重写 `shared.js` 中的 `parsePriceText`，采用严格的货币符号锚定匹配，彻底杜绝促销文本中的年份（如 2026）、天数（如 90天）和回头率百分比串入价格区间。
  - 修复 `search.js` 现代卡片布局（`offerCard--`）下的 scoped 标题与单价提取逻辑。
  - 重写 `auth.js` 认证检测逻辑，移除阻塞式首页导航，实现毫秒级登录身份提取（`hongxin52013`）。
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
  - 创建官方 Agent Skill `1688-ops`，并在 `~/.gemini/antigravity/skills/1688-ops` 建立镜像。
- **全量测试套件 (27/27 全部通过)**：
  - `tests/unit_parsers.test.js`：纯函数解析器 16 项单元测试。
  - `tests/db.test.js`：SQLite 存储与派生计算 5 项测试。
  - `tests/adapter_contract.test.js`：适配器防漂移契约 3 项测试。
  - `tests/diagnose.test.js`：诊断器 3 项测试。
