#!/usr/bin/env bash
#
# Build locally and push to the server. Run from the repo root:
#
#   deploy/deploy.sh [user@host]
#
# Defaults to root@bugs.ezmuze.studio. Assumes deploy/setup-server.sh has
# already run there once.
set -euo pipefail

TARGET="${1:-root@bugs.ezmuze.studio}"
APP_DIR=/opt/todont-tracker
APP_USER=todont

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say "Building"
npm ci --workspaces --include-workspace-root
npm run build

[[ -f server/dist/index.js ]] || { echo "server build missing" >&2; exit 1; }
[[ -f web/dist/index.html ]] || { echo "web build missing" >&2; exit 1; }

say "Pushing to $TARGET:$APP_DIR"
ssh "$TARGET" "mkdir -p $APP_DIR/server $APP_DIR/web"

# Only what the service actually runs: compiled output, the SPA, and the
# production dependency tree. No sources, no dev tooling, no data.
rsync -az --delete server/dist/          "$TARGET:$APP_DIR/server/dist/"
rsync -az --delete web/dist/             "$TARGET:$APP_DIR/web/dist/"
rsync -az            server/package.json "$TARGET:$APP_DIR/server/package.json"
rsync -az            package.json        "$TARGET:$APP_DIR/package.json"
rsync -az --delete   deploy/             "$TARGET:$APP_DIR/deploy/"

say "Installing production dependencies on the server"
# better-sqlite3 is native; --omit=dev keeps the toolchain off the box but the
# prebuilt binary still has to be fetched for the server's own Node version.
ssh "$TARGET" "cd $APP_DIR/server && npm install --omit=dev --no-audit --no-fund --ignore-scripts=false"

say "Restarting the service"
ssh "$TARGET" "chown -R $APP_USER:$APP_USER $APP_DIR && systemctl restart todont-tracker && sleep 2 && systemctl is-active todont-tracker"

say "Health check"
if ssh "$TARGET" "curl -fsS http://127.0.0.1:4310/api/health"; then
  printf '\n\033[1;32mDeployed.\033[0m\n'
else
  echo
  echo "The service did not answer. Recent logs:" >&2
  ssh "$TARGET" "journalctl -u todont-tracker -n 40 --no-pager" >&2
  exit 1
fi
