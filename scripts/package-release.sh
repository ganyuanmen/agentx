#!/usr/bin/env bash
# 把 agentx 打成一个可离线部署的 tarball。
#
# 为什么要打「整个仓库 + node_modules」，而不是 npm pack 单个包：
#   - 所有包都是 private:true，且用 workspace:* 互相引用，不能发布到 registry；
#   - packages/cli/node_modules/@agentx/* 是指向 ../../../packages/* 的相对软链，
#     整目录一起拷贝时这些软链才有效；单独拷 dist 会断。
#
# 用法：
#   ./scripts/package-release.sh                 # 产出 dist-release/agentx-<版本>-<日期>.tar.gz
#   SKIP_BUILD=1 ./scripts/package-release.sh    # 复用已有 dist（要求先 pnpm verify 通过）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${ROOT}/dist-release"
NAME="agentx-${VERSION}-${STAMP}"
STAGE="${OUT_DIR}/${NAME}"

echo "==> agentx ${VERSION} · 打包目录 ${STAGE}"

# 1) 构建 + 门禁（不通过就不打包，避免发出半成品）
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> pnpm verify（build + typecheck + test-gate）"
  pnpm verify
else
  echo "==> 跳过构建（SKIP_BUILD=1），假定 dist 已是最新"
fi

# 2) 打包前自检：dist 必须存在，且不比 src 旧
node scripts/test-gate.mjs >/dev/null || {
  echo "!! test-gate 未通过，拒绝打包" >&2
  exit 1
}

# 3) staging
rm -rf "${STAGE}"
mkdir -p "${STAGE}"

echo "==> 复制运行时必需文件"
# 注意：tar 的 --exclude 必须写在文件列表【之前】，写在后面会被忽略（GNU tar 只警告不报错），
# 那样 src/ 与 tests/ 会一起打进去 —— 体积涨、还泄露源码。
tar -C "${ROOT}" \
  --exclude='packages/*/tests' \
  --exclude='packages/*/tsconfig*.json' \
  --exclude='packages/*/src' \
  --exclude='packages/*/dist/*.map' \
  --exclude='tests' \
  --exclude='dist-release' \
  -cf - \
  package.json pnpm-workspace.yaml tsconfig.base.json \
  config.example.json README.md skills scripts packages \
  | tar -C "${STAGE}" -xf -

# node_modules 必须保留软链结构（-h 会把它拍平并复制成几十份，反而更大更易错）
echo "==> 复制 node_modules（保留软链）"
tar -C "${ROOT}" -cf - node_modules | tar -C "${STAGE}" -xf -

# 4) 附上部署说明
cat > "${STAGE}/DEPLOY.md" <<'EOF'
# agentx 离线部署

## 目标机要求
- Node.js >= 22（依赖内置 `node:sqlite`；Node 20 会在打开数据库时直接失败）
- POSIX shell（exec 工具默认用 sh）
- 不需要 pnpm、不需要联网装依赖、不需要编译原生模块

## 安装
```bash
tar -xzf agentx-*.tar.gz -C /opt
ln -sf /opt/agentx-*/packages/cli/bin/agentx.js /usr/local/bin/agentx
agentx doctor          # 8 项自检，应全 PASS
```

## 配置 API key（不要放进仓库）
```bash
mkdir -p ~/.agentx
printf 'DEEPSEEK_API_KEY=sk-xxx\n' > ~/.agentx/.env
chmod 600 ~/.agentx/.env
```

## 验证
```bash
agentx doctor
agentx run "只回复两个字：收到"
```

## 运行时数据
默认落在 `~/.agentx/`（config.json / data/agentx.sqlite / logs/ / memory/），
可用 `AGENTX_HOME` 改到别处。升级时保留该目录即可保留历史会话。
EOF

# 5) 打 tarball
echo "==> 生成 tarball"
TARBALL="${OUT_DIR}/${NAME}.tar.gz"
tar -C "${OUT_DIR}" -czf "${TARBALL}" "${NAME}"

# 6) 校验：解到临时目录，用解出来的那份真跑一次 --version
echo "==> 校验产物"
VERIFY_DIR="$(mktemp -d)"
tar -C "${VERIFY_DIR}" -xzf "${TARBALL}"
GOT="$(node "${VERIFY_DIR}/${NAME}/packages/cli/bin/agentx.js" --version)"
rm -rf "${VERIFY_DIR}"
if [[ "${GOT}" != "${VERSION}" ]]; then
  echo "!! 产物校验失败：期望 ${VERSION}，得到 ${GOT}" >&2
  exit 1
fi

echo
echo "完成：${TARBALL}  ($(du -h "${TARBALL}" | cut -f1))"
echo "目标机安装：tar -xzf $(basename "${TARBALL}") -C /opt && ln -sf /opt/${NAME}/packages/cli/bin/agentx.js /usr/local/bin/agentx"
