#!/usr/bin/env bash
# FeedNest 离线安装脚本（1Panel 宿主机或任意装了 Docker 的 Linux）
# 用法： ./install.sh [端口] [镜像文件路径]
#        ./install.sh                     # 端口 13786，自动找 *.image.tar
#        ./install.sh 8080                # 指定端口
#        ./install.sh 8080 /opt/feednest-1.2.0.image.tar
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-13786}"
IMG_ARG="${2:-}"

echo "==> FeedNest 离线安装"
echo "    安装目录: $(pwd)"
echo "    访问端口: ${PORT}"

if ! command -v docker >/dev/null 2>&1; then
  echo "!! 未检测到 docker，请先安装 Docker（1Panel 可在「主机 → 终端」里使用面板自带的 Docker）" >&2
  exit 1
fi

# 导入镜像（逻辑都在 load-image.sh 里）
if [ -x ./load-image.sh ]; then
  ./load-image.sh ${IMG_ARG:+"${IMG_ARG}"}
else
  IMG="${IMG_ARG:-$(ls ./*.image.tar ../*.image.tar 2>/dev/null | head -1 || true)}"
  if [ -z "${IMG}" ]; then
    echo "!! 找不到 *.image.tar，请把镜像文件和本目录放在一起，或用 ./install.sh 端口 镜像路径" >&2
    exit 1
  fi
  echo "==> 导入镜像: ${IMG}"
  docker load -i "${IMG}"
fi

echo "FEEDNEST_PORT=${PORT}" > .env
mkdir -p data

echo "==> 启动容器"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
else
  docker-compose up -d
fi

sleep 3
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "${IP}" ] && IP="服务器IP"

echo
echo "==> 完成"
echo "    访问地址: http://${IP}:${PORT}"
echo "    默认账号: admin / admin   （登录后请立刻修改密码）"
echo "    数据目录: $(pwd)/data"
echo
echo "    查看日志: docker logs -f feednest"
echo "    停止服务: ./uninstall.sh"
