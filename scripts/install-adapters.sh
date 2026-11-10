#!/usr/bin/env bash
# 同步 1688 OpenCLI 适配器到 ~/.opencli/clis/1688
# 确保源码真理库与运行态适配器保持一致

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/.." && pwd)"
SRC="${HUB_1688_ADAPTER_SRC:-$HOME/Documents/A-coding/opencli-fork/clis/1688}"
DEST="${HUB_1688_ADAPTER_DEST:-$HOME/.opencli/clis/1688}"

if [ ! -d "$SRC" ]; then
  echo "错误: 未找到适配器源码目录: $SRC" >&2
  exit 2
fi

count=0
for f in "$SRC"/*.js; do
  if [[ "$f" != *".test.js" ]]; then
    node --check "$f"
    count=$((count + 1))
  fi
done

if [ "$count" -eq 0 ]; then
  echo "错误: 在 $SRC 中未找到 .js 适配器文件" >&2
  exit 2
fi

mkdir -p "$DEST"
for f in "$SRC"/*.js; do
  if [[ "$f" != *".test.js" ]]; then
    cp -p "$f" "$DEST"/
  fi
done

echo "成功同步 $count 个适配器 -> $DEST"

if command -v opencli >/dev/null 2>&1; then
  opencli daemon restart 2>/dev/null | grep -v '^⚠' | head -1 || true
  if opencli list --site 1688 2>/dev/null | grep -q '1688 search'; then
    echo "对账回执: opencli 1688 search 已成功加载并在运行态注册"
  else
    echo "警告: opencli 未能正确列出 1688 命令" >&2
    exit 1
  fi
fi
