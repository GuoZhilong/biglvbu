#!/usr/bin/env bash
# ============================================================
# 合成大吕布·掉落版 —— 一键部署脚本
#
# 用法：把整个 game 文件夹上传到服务器后，执行
#       bash deploy.sh
#
# 功能：检查/安装 Node.js ≥18 → 写入 systemd 服务并启动 → 自检
# 特性：可重复执行（再次运行 = 更新代码后重启服务）
# 自定义端口：PORT=9000 bash deploy.sh
# ============================================================
set -euo pipefail

PORT="${PORT:-8080}"
NODE_MAJOR_REQUIRED=18
SERVICE_NAME="lvbu"

# ---------- 定位文件（以脚本所在目录为项目根） ----------
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$APP_DIR/server/server.js"
HTML_FILE="$APP_DIR/合成大吕布-掉落版.html"

echo "================ 合成大吕布·掉落版 一键部署 ================"
echo "项目目录: $APP_DIR"
echo "后端文件: $SERVER_JS"
echo "游戏页面: $HTML_FILE"
echo "端口:     $PORT"

# 文件完整性检查（多页面部署：四个文件缺一不可）
MISSING=""
[ -f "$SERVER_JS" ] || MISSING="$MISSING
  - server/server.js（后端）"
[ -f "$HTML_FILE" ] || MISSING="$MISSING
  - 合成大吕布-掉落版.html（掉落版游戏）"
[ -f "$APP_DIR/index.html" ] || MISSING="$MISSING
  - index.html（主页）"
[ -f "$APP_DIR/合成大吕布.html" ] || MISSING="$MISSING
  - 合成大吕布.html（999挑战）"
if [ -n "$MISSING" ]; then
  echo "❌ 以下文件缺失:$MISSING"
  echo "   请按部署手册的清单把文件补传后重试"
  exit 1
fi

# ---------- sudo 处理 ----------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null; then
    echo "❌ 需要 root 权限或 sudo 命令"; exit 1
  fi
  SUDO="sudo"
fi

# ---------- 1. Node.js ----------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_REQUIRED" ]; then
    echo "✔ Node.js $(node -v) 已满足要求"
    NEED_NODE=0
  else
    echo "⚠ Node.js $(node -v) 过低（需 ≥ $NODE_MAJOR_REQUIRED），将安装 Node 22"
  fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "❌ 未找到 apt-get，请手动安装 Node.js ≥ $NODE_MAJOR_REQUIRED 后重跑本脚本"
    exit 1
  fi
  echo "→ 正在安装 Node.js 22.x（约 1-2 分钟）..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
  echo "✔ Node.js $(node -v) 安装完成"
fi

# ---------- 2. systemd 服务 ----------
if ! command -v systemctl >/dev/null 2>&1; then
  echo "⚠ 未检测到 systemd，改用 nohup 后台运行（服务器重启后需重跑本脚本）"
  pkill -f "node .*server\.js" 2>/dev/null || true
  ( cd "$APP_DIR/server" && PORT="$PORT" nohup node server.js > "$APP_DIR/server/out.log" 2>&1 & )
else
  echo "→ 写入 systemd 服务 $SERVICE_NAME ..."
  NODE_BIN="$(command -v node)"
  $SUDO tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null <<EOF
[Unit]
Description=lvbu-drop game server
After=network.target

[Service]
WorkingDirectory=$APP_DIR/server
ExecStart=$NODE_BIN $SERVER_JS
Restart=always
RestartSec=3
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable $SERVICE_NAME >/dev/null 2>&1 || true
  $SUDO systemctl restart $SERVICE_NAME
fi

# ---------- 3. 自检 ----------
echo -n "→ 等待服务启动"
STARTED=0
for i in $(seq 1 10); do
  if curl -sf -o /dev/null "http://localhost:$PORT/"; then
    echo ""
    echo "✔ 服务已启动并响应正常"
    STARTED=1
    break
  fi
  echo -n "."
  sleep 1
done
if [ "$STARTED" -ne 1 ]; then
  echo ""
  echo "❌ 服务未能启动，查看日志："
  echo "   journalctl -u $SERVICE_NAME -n 50"
  echo "   或（nohup 模式）cat $APP_DIR/server/out.log"
  exit 1
fi

# ---------- 4. 完成提示 ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================ 部署完成 ================"
echo "本机访问:    http://localhost:$PORT"
echo "公网访问:    http://${IP:-<服务器IP>}:$PORT"
echo ""
echo "常用命令:"
echo "  查看状态:  systemctl status $SERVICE_NAME"
echo "  查看日志:  journalctl -u $SERVICE_NAME -n 50"
echo "  重启服务:  sudo systemctl restart $SERVICE_NAME"
echo "  停止服务:  sudo systemctl stop $SERVICE_NAME"
echo ""
echo "⚠ 重要：还需在腾讯云控制台的【防火墙】里放行 TCP $PORT 端口，"
echo "  外网才能访问（这步必须手动，脚本代替不了控制台操作）。"
