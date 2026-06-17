#!/usr/bin/env bash
# ===== designforge 启动器 (macOS / Linux) =====
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$ROOT/runtime/node"
APP="$ROOT/app/dist/cli.js"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/browser"

if [ ! -x "$NODE" ]; then
  # fall back to system node if portable runtime is absent
  if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; else
    echo "[!] 未找到 Node 运行时，请确认完整解压。"; exit 1
  fi
fi

echo ""
echo "  正在启动 designforge 本地服务，稍候自动打开浏览器..."
echo "  按 Ctrl+C 停止。"
echo ""
"$NODE" "$APP" serve
