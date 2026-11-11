#!/usr/bin/env bash
# 导入 FeedNest 镜像并校验。
#
# 用法：
#   ./load-image.sh                              # 自动在当前目录/上级目录找 *.image.tar
#   ./load-image.sh /opt/feednest-1.2.0.image.tar  # 直接指定镜像文件
set -euo pipefail

cd "$(dirname "$0")"

IMG="${1:-}"

if [ -z "${IMG}" ]; then
  # 依次在 当前目录、上级目录、/opt 里找
  for dir in "." ".." "/opt" "/root" "/tmp"; do
    found="$(ls "${dir}"/*.image.tar 2>/dev/null | head -1 || true)"
    if [ -n "${found}" ]; then
      IMG="${found}"
      break
    fi
  done
fi

if [ -z "${IMG}" ] || [ ! -f "${IMG}" ]; then
  echo "!! 没有找到镜像文件（*.image.tar）" >&2
  echo "   当前目录: $(pwd)" >&2
  echo "   请把 feednest-1.2.0.image.tar 一起上传到服务器，然后：" >&2
  echo "     ./load-image.sh /路径/feednest-1.2.0.image.tar" >&2
  echo >&2
  echo "   注意：外层那个 feednest-1panel-bundle-*.zip 不是镜像，" >&2
  echo "   它是脚本和应用定义，不能用于「导入镜像」。" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "!! 未检测到 docker 命令" >&2
  exit 1
fi

case "${IMG}" in
  *.tar.gz | *.tgz | *.zip)
    echo "!! ${IMG} 看起来是压缩包，不是镜像文件" >&2
    echo "   镜像文件名应该是 *.image.tar（docker save 出来的原始 tar）" >&2
    exit 1
    ;;
esac

echo "==> 导入镜像：${IMG}"
docker load -i "${IMG}"

echo
echo "==> 当前 feednest 镜像："
if docker images feednest --format '    {{.Repository}}:{{.Tag}}   {{.Size}}' | grep -q .; then
  docker images feednest --format '    {{.Repository}}:{{.Tag}}   {{.Size}}'
  echo
  echo "==> 导入成功。回到 1Panel「容器 → 镜像」点一下刷新就能看到。"
else
  echo "    !! 没有找到 feednest 镜像，导入可能失败，请把上面的输出发出来。" >&2
  exit 1
fi
