# 1688-ops Agent Constitution

本项目是 1688（阿里巴巴中国站批发网）货源采购、以图搜款、详情对账与离线数据真理库的核心工具与 Skill 仓库。

## 继承与层级
- 继承 `../AGENTS.md` 基础规则。
- 本地指令与合约以本文件为最终基准。
- `CLAUDE.md` 与 `GEMINI.md` 仅作为重定向指针，统一指向本文件。

## 核心架构原则 (Architecture Invariants)
1. **单一事实来源 (Single Source of Truth, SSOT)**：
   - 本地 SQLite (`data/1688_ops.db`) 是所有商品、采购车与订单数据的终态真理库。
   - 界面与 CLI 仅作为真理的投影与渲染器。
2. **单向数据流 (Unidirectional Data Flow, UDF)**：
   - 读流向：SQLite 数据库 -> 数据访问层 -> CLI 渲染。
   - 写流向：在线抓取 -> 纯函数清洗校验 -> 写入 SQLite -> 重新拉取渲染。
3. **能派生的绝不存冗余 (Derived State, Don't Duplicate)**：
   - 销量整数 (`sales_value`) 与回头率百分比 (`return_rate_percent`) 在入库时由纯函数派生计算，严禁手工存重复副本。
4. **稳定不可变主键**：
   - 商品严格以数字 `offer_id` 为唯一主键，严禁用变动的标题作为外键关联。
5. **对账器与可观测性优先 (Diagnostic-First)**：
   - 凡称可配置，必须可检查；凡有业务规则，必须能找到对账依据。
   - 必须常态维护三大诊断能力：能读 (`1688-ops diagnose`)、能试 (`1688-ops diagnose --test-parser`)、能调 (`1688-ops diagnose --reconcile`)。

## 适配器维护与防漂移规则
- 适配器源码唯一源头：`~/Documents/A-coding/opencli-fork/clis/1688`。
- 运行态部署目录：`~/.opencli/clis/1688`。
- 任何适配器修改必须运行 `npm test`，通过 `tests/adapter_contract.test.js` 验证哈希完全一致。

## 执行与技能日志规范
- 所有工作块中调用的 Skills 必须且仅记录在 `progress.md` 中。
- 不得在 `vault/` 或聊天历史中分散技能调用记录。
