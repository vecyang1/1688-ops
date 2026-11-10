# 1688-ops Knowledge & Architecture Router (VAULT.md)

> Scope: project-local — this file governs only this project root. Cross-project truth lives in the 2nd Brain vault: /Users/vecsatfoxmailcom/Documents/Cowork/Antigravity Cowork/26.06.06 2nd Brain (contract: 00 - System/contracts/project-link-bridge.md).

本文件是 1688-ops 项目的上下文与技术路由枢纽。

## 项目定位与归属
- **项目路径**：`/Users/vecsatfoxmailcom/Documents/A-coding/26.11.10-1688-ops`
- **适配器源码**：`~/Documents/A-coding/opencli-fork/clis/1688`
- **OpenCLI 运行区**：`~/.opencli/clis/1688`
- **Agent Skill**：`~/.agents/skills/1688-ops/SKILL.md`（镜像位于 `~/.gemini/antigravity/skills/1688-ops`）
- **全局可执行文件**：`~/.local/bin/1688-ops`，`~/.local/bin/1688-cli`
- **默认数据库**：`data/1688_ops.db`

## 核心接口契约 (Interface Contracts)
- **OpenCLI 适配器接口**：
  - `opencli 1688 whoami`：登录身份与状态检查
  - `opencli 1688 search <query> [--limit N]`：商品货源检索
  - `opencli 1688 image-search <image> [--limit N]`：拍立淘搜款
  - `opencli 1688 item <offer_id>`：商品详情规格抓取
  - `opencli 1688 store <store_id>`：供应商店铺档案
  - `opencli 1688 cart`：买家采购车
  - `opencli 1688 orders [--status S] [--pages P]`：买家采购订单流水

## 数据库架构 (Database Contracts)
- `offers`：货源商品主表，主键 `offer_id`。
- `cart_items`：采购车条目表，主键 `cart_item_id`，关联 `offer_id`。
- `orders`：采购订单流水表，主键 `order_id`。
- `search_history`：检索审计日志。
- `audit_logs`：全量操作审计轨迹。

## 可观测性诊断器契约
- **能读**：`readSystemStatus(db)` 输出环境、数据库大小、10 个适配器的 SHA-256 哈希值。
- **能试**：`testLiveParser()` 现场执行纯函数价格解析（含 2026 年份过滤、销量万级换算、回头率提取）。
- **能调**：`reconcileAdapters()` 将源码同步到运行态并自动重启 daemon。
