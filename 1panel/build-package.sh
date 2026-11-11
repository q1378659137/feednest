#!/usr/bin/env bash
# 打包 1Panel 部署包（单个 zip：镜像 + 脚本 + 应用定义）
# 用法： ./build-package.sh
#        VERSION=1.3.0 ./build-package.sh
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${VERSION:-1.2.0}"
IMAGE="feednest:${VERSION}"
IMAGE_TAR="feednest-${VERSION}.image.tar"
NAME="feednest-1panel-v${VERSION}"
STAGE="dist/${NAME}"
OUT="dist/${NAME}.zip"

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "!! 本地没有镜像 ${IMAGE}，先构建：" >&2
  echo "   cd .. && docker build -t ${IMAGE} ." >&2
  exit 1
fi

echo "==> 清理旧产物"
rm -rf "${STAGE}" "${OUT}"
rm -f dist/*.tar.gz dist/*.image.tar
rm -rf dist/feednest-1panel-bundle-* dist/feednest-1panel-offline-*
mkdir -p "${STAGE}/1panel-app" dist

echo "==> 导出镜像 ${IMAGE} -> ${IMAGE_TAR}"
docker save "${IMAGE}" -o "${STAGE}/${IMAGE_TAR}"

echo "==> 复制脚本与应用定义"
cp docker-compose.yml install.sh uninstall.sh load-image.sh README.md "${STAGE}/"
cp -r app/feednest "${STAGE}/1panel-app/feednest"
chmod +x "${STAGE}/install.sh" "${STAGE}/uninstall.sh" "${STAGE}/load-image.sh"

# 版本号同步（README / 应用定义里写的是默认版本）
if [ "${VERSION}" != "1.2.0" ]; then
  echo "==> 同步版本号 -> ${VERSION}"
  sed -i "s/1\.2\.0/${VERSION}/g" \
    "${STAGE}/README.md" \
    "${STAGE}/1panel-app/feednest/docker-compose.yml" \
    "${STAGE}/1panel-app/feednest/data.yml"
fi

{
  echo "FeedNest 1Panel 部署包 v${VERSION}"
  echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "解压后目录里："
  echo "  ${IMAGE_TAR}      <- 镜像文件，1Panel「容器 → 镜像 → 导入」选这个"
  echo "  1panel-app/                  <- 1Panel 本地应用定义"
  echo "  install.sh / load-image.sh   <- 命令行安装脚本"
  echo
  echo "注意：本 zip 本身不是镜像，不能直接丢进「导入镜像」。"
  echo "先解压，再导入里面的 ${IMAGE_TAR}。"
} > "${STAGE}/MANIFEST.txt"

echo "==> 生成 zip（约 60MB，需要一点时间）"
if command -v python3 >/dev/null 2>&1; then
  python3 - "${STAGE}" "${OUT}" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
base = os.path.basename(src)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src)
            arc = os.path.join(base, rel).replace('\\', '/')
            info = zipfile.ZipInfo.from_file(full, arc)
            info.external_attr = (0o100000 | (0o755 if f.endswith('.sh') else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, 'rb') as fh:
                zf.writestr(info, fh.read())
print('  写入', out)
PY
else
  echo "!! 需要 python3 来生成 zip" >&2
  exit 1
fi

rm -rf "${STAGE}"

echo
echo "==> 完成：${OUT}"
ls -lh "${OUT}" | sed 's/^/    /'
