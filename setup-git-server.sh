#!/usr/bin/env bash
# ============================================================
# 一次性执行：在服务器上创建 Git 裸仓库 + 自动部署钩子
# 在本机执行:
#   ssh ubuntu@<服务器IP> "bash -s" < setup-git-server.sh
# ============================================================
set -euo pipefail

REPO_DIR=/opt/lvbu/repo.git
WORK_TREE=/opt/lvbu

if [ ! -d "$REPO_DIR" ]; then
  git init --bare "$REPO_DIR" >/dev/null
  echo "✔ 裸仓库已创建: $REPO_DIR"
else
  echo "✔ 裸仓库已存在: $REPO_DIR"
fi

mkdir -p "$REPO_DIR/hooks"
cat > "$REPO_DIR/hooks/post-receive" <<'HOOK'
#!/bin/bash
# push 即部署：checkout 最新代码到运行目录 + 重启服务
set -e
WORK_TREE=/opt/lvbu
REPO_DIR=/opt/lvbu/repo.git
while read -r old new ref; do
  branch="${ref#refs/heads/}"
  if [ "$branch" != "main" ]; then
    echo "跳过分支 $branch（只部署 main）"
    continue
  fi
  echo "→ 部署 main ($new) ..."
  GIT_WORK_TREE="$WORK_TREE" git --git-dir="$REPO_DIR" checkout -f main
  echo "→ 重启服务 ..."
  cd "$WORK_TREE" && bash deploy.sh
  echo "✔ 部署完成: http://<服务器IP>:8080"
done
HOOK
chmod +x "$REPO_DIR/hooks/post-receive"

echo "✔ post-receive 钩子已就位"
echo ""
echo "服务器端就绪。回到本机执行:"
echo "  git remote add server ssh://ubuntu@<服务器IP>/opt/lvbu/repo.git"
echo "  git push server main"
echo ""
echo "注意: users.json（玩家数据）在 .gitignore 里，push 不会覆盖它。"
