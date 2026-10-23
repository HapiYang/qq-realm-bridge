#!/usr/bin/env bash
# 注册 systemd 服务，开机自启 + 崩溃重拉
set -e
D="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
sudo tee /etc/systemd/system/qq-realm-bridge.service > /dev/null <<EOF
[Unit]
Description=QQ-Realm chat bridge (PiPi)
After=docker.service network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$D/bridge
ExecStart=$NODE index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now qq-realm-bridge
echo "已启动。看日志： journalctl -u qq-realm-bridge -f"
echo "NapCat 记得也设自启： docker update --restart=always napcat"
