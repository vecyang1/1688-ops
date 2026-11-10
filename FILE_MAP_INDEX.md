# 1688-ops File Map Index

本文件为项目文件结构与职责映射索引。

## 目录与文件清单

- `bin/`
  - `1688-cli.js`：全局控制台可执行文件，提供 `doctor`, `search`, `image-search`, `item`, `store`, `cart`, `orders`, `db`, `inspect`, `diagnose`, `install-adapters`。
- `src/`
  - `schema.sql`：SQLite 模式定义，包含商品、购物车、订单、检索与审计日志表。
  - `db.js`：基于原生 `node:sqlite` 的数据访问层，实现单一事实来源（SSOT）、冲突去重与派生计算。
  - `extractor.js`：纯函数解析器，包含价格区间、起订量、销量万级换算、回头率提取等。
  - `client.js`：1688 客户端封装层，编排底层 OpenCLI 调用，实现超时保护与数据同步。
  - `diagnose.js`：可观测性对账器核心（能读、能试、能调）。
- `scripts/`
  - `install-adapters.sh`：适配器同步脚本，保证源码真理库与运行态目录哈希一致。
- `tests/`
  - `unit_parsers.test.js`：纯函数单元测试套件（16 项测试）。
  - `db.test.js`：SQLite 存储、排序与派生逻辑测试（5 项测试）。
  - `adapter_contract.test.js`：适配器接口与防漂移契约测试（3 项测试）。
  - `diagnose.test.js`：对账器逻辑测试（3 项测试）。
- `data/`
  - `1688_ops.db`：本地 SQLite 数据库文件。
- 根目录文档：
  - `AGENTS.md`：本地 Agent 宪章。
  - `README.md`：项目说明文档。
  - `CHANGELOG.md`：演进与版本变更记录。
  - `VAULT.md`：架构与知识路由枢纽。
  - `task_plan.md`：任务拆解与完成状态。
  - `progress.md`：技能调用与验证回执。
  - `package.json`：项目元数据与 NPM 脚本。
