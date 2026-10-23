#!/usr/bin/env bash
# QQ群 <-> 皮皮欢乐多 Realm 桥接
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没装 node。Ubuntu/Debian 执行："
  echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs"
  exit 1
fi
echo "node $(node -v)"

echo "== 启动 NapCat =="
if command -v docker >/dev/null 2>&1; then
  docker compose up -d
  echo "  扫码登录看日志： docker logs -f napcat   （二维码是字符画，手机QQ直接扫屏幕）"
  echo "  WebUI: docker logs napcat | grep -i 'WebUi Token'"
else
  echo "  ⚠️ 没装 docker，跳过 NapCat。要装： curl -fsSL https://get.docker.com | sudo sh"
fi

echo
echo "== 启动桥接（Ctrl+C 停止）=="
cd bridge
exec node index.js
