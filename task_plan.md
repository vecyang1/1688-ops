# 1688-ops Task Plan & Execution Roadmap

## 核心任务目标
根据平台与架构规范，构建 1688.com 自动化采购与货源对账系统，消除 Ghost Logic & Snippet Rot，落实单一事实来源（SSOT）、单向数据流（UDF）与可观测性对账器（能读、能试、能调）。

## 任务拆解与完成状态

- [x] **Phase 1: 真实 Owner 定位与适配器修复**
  - [x] 定位 `~/Documents/A-coding/opencli-fork/clis/1688` 与 `~/.opencli/clis/1688`。
  - [x] 修复 `shared.js` 中的 `parsePriceText`，防止 2026 年份、90 天最低价及回头率百分比污染价格区间。
  - [x] 修复 `search.js` 现代卡片结构（`offerCard--`）下的 scoped 标题与单价提取。
  - [x] 优化 `auth.js` 认证提取，跳过重载阻塞页面，实现毫秒级会话身份提取。
  - [x] 新增 `cart.js`、`orders.js` 与 `image-search.js`（DataTransfer 文件注入绕过 CDP 限制）。

- [x] **Phase 2: 单一事实来源与数据契约设计**
  - [x] 设计 `src/schema.sql`：包含 `offers`、`cart_items`、`orders`、`search_history`、`audit_logs`。
  - [x] 实现 `src/db.js`：基于 Node 原生 `node:sqlite`（DatabaseSync），实现严格契约、冲突更新与商品占位自动补齐。
  - [x] 实现 `src/extractor.js`：编写针对价格、起订量、销量与回头率的纯函数解析器。

- [x] **Phase 3: 可观测性对账器与客户端封装**
  - [x] 实现 `src/diagnose.js`：
    - 能读：读取当前环境配置、数据库统计与 10 个适配器的 SHA-256 同步状态。
    - 能试：测试真实纯函数在脏数据样本下的推导对账证据。
    - 能调：一键热覆盖源码区到 OpenCLI 运行区并验证 daemon 注册。
  - [x] 实现 `src/client.js`：封装 `HubClient1688`，实现错误分类、超时保护与自动入库。

- [x] **Phase 4: 全局命令行工具与 Agent 技能构建**
  - [x] 编写 `bin/1688-cli.js`：实现 `doctor`、`search`、`image-search`、`item`、`store`、`cart`、`orders`、`db`、`inspect` 与 `diagnose` 全套指令。
  - [x] 软链全局命令：`~/.local/bin/1688-ops` 与 `~/.local/bin/1688-cli`。
  - [x] 编写 `~/.agents/skills/1688-ops/SKILL.md`，并在 `~/.gemini/antigravity/skills/1688-ops` 建立镜像。

- [x] **Phase 5: 全量测试套件与端到端真实页面验证**
  - [x] `tests/unit_parsers.test.js`：16 项单元测试全部通过。
  - [x] `tests/db.test.js`：5 项 SQLite 存储与排序测试全部通过。
  - [x] `tests/adapter_contract.test.js`：3 项适配器哈希防漂移契约测试全部通过。
  - [x] `tests/diagnose.test.js`：3 项诊断器测试全部通过。
  - [x] 真实浏览器端到端测试：验证登录、关键词检索、采购车拉取与 SQLite 自动持久化。
