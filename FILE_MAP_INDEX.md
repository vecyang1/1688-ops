# 1688-ops File Map Index

> Scope: project-local — this file governs only this project root. Cross-project truth lives in the 2nd Brain vault: /Users/vecsatfoxmailcom/Documents/Cowork/Antigravity Cowork/26.06.06 2nd Brain (contract: 00 - System/contracts/project-link-bridge.md).

本文件为项目文件结构与职责映射索引。

## 目录与文件清单

- `bin/`
  - `1688-cli.js`：全局控制台可执行文件，提供 `doctor`, `whoami`, `search`, `image-search`, `item`, `store`, `cart`, `orders`, `db`, `inspect`, `diagnose`, `install-adapters` 等已实现子命令，并预留 `reason` [M3 规划] 供货推理命令入口。
- `docs/`
  - `feature_map.md`：系统功能全景图谱，包含垂直五层架构（接入层、采集层、推理层、真理持久化层、可观测层）、数据流向图、当前已实现接口与未来规划契约。
  - `architecture.md`：系统架构设计契约，规定原生 ESM 与零外部 NPM 依赖哲学、模块物理边界、SQLite 存储模型、数据状态机与反爬/翻页容错机制。
- `src/`
  - `schema.sql`：SQLite 模式定义，包含商品、购物车、订单、检索历史与审计日志五大核心表结构及索引。
  - `db.js`：基于原生 `node:sqlite` 的数据访问层，实现单一事实来源、冲突去重、事务持久化与排序检索。
  - `extractor.js`：纯函数解析器，包含价格区间、起订量、销量万级换算、回头率百分比派生等无副作用算法。
  - `reasoner.js` [M3 规划]：供货智能决策推理引擎，计划实现供应商多维信誉评级（0-100 分）、阶梯价格与起订量拆解、目标售价毛利与保本测算，以及 7 项风控规则触发器。
  - `client.js`：1688 客户端封装层，编排底层 OpenCLI 调用，实现 75s 超时保护、会话复用与数据自动落库。
  - `diagnose.js`：可观测性对账器核心（能读环境与真理库、能试生产数据样本、能调热同步适配器）。
- `scripts/`
  - `install-adapters.sh`：适配器同步脚本，保证源码真理库与运行态目录哈希一致。
- `tests/`
  - `unit_parsers.test.js`：纯函数单元测试套件（16 项测试）。
  - `db.test.js`：SQLite 存储、排序与派生逻辑测试（5 项测试）。
  - `adapter_contract.test.js`：适配器接口与防漂移契约测试（3 项测试）。
  - `diagnose.test.js`：对账器逻辑测试（3 项测试）。
- `data/`
  - `1688_ops.db`：本地 SQLite 单一事实真理库文件。
- 根目录文档：
  - `AGENTS.md`：本地 Agent 宪章。
  - `README.md`：项目说明文档，包含架构全景图、命令手册与架构文档索引。
  - `CHANGELOG.md`：演进与版本变更记录。
  - `VAULT.md`：架构与知识路由枢纽。
  - `task_plan.md`：任务拆解与完成状态。
  - `progress.md`：技能调用与验证回执。
  - `package.json`：项目元数据与 NPM 脚本（零外部生产依赖）。
