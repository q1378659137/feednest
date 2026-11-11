#!/usr/bin/env bash
# 停止并移除 FeedNest 容器（数据默认保留）
# 用法： ./uninstall.sh          仅停止容器
#        ./uninstall.sh --purge  连同数据一起删除
set -euo pipefail

cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then
  docker compose down || true
else
  docker-compose down || true
fi

if [ "${1:-}" = "--purge" ]; then
  echo "==> 删除数据目录 $(pwd)/data"
  rm -rf ./data
  echo "    已删除（不可恢复）"
else
  echo "==> 容器已停止，数据保留在 $(pwd)/data"
  echo "    如需彻底删除： ./uninstall.sh --purge"
fi
