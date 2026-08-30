#!/usr/bin/env bash
#
# Push the tracker to the host and rebuild its container. Run from the repo root:
#
#   deploy/deploy.sh [user@host]
#
# The image is built on the server, so nothing here depends on the host's own
# Node (which is 16, older than the app needs).
set -euo pipefail

TARGET="${1:-root@your-host}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_todont_deploy}"
SRC_DIR=/root/todont-tracker
STATE_DIR=$STATE_DIR

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes "$TARGET")

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say "Preparing $TARGET"
# The container runs as the image's `node` user (uid 1000). A bind mount keeps
# the host's ownership, so the data directory has to be owned by that uid or
# SQLite cannot create its database.
"${SSH[@]}" "mkdir -p $SRC_DIR $STATE_DIR/data/uploads && chown -R 1000:1000 $STATE_DIR/data"

# First run only: seed the env file with a generated cookie secret. Never
# overwrite it — that would sign every existing session out.
"${SSH[@]}" bash -s <<EOF
set -e
if [ ! -f $STATE_DIR/tracker.env ]; then
  SECRET="\$(openssl rand -base64 48 | tr -d '\n')"
  cat > $STATE_DIR/tracker.env <<ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=4310
PUBLIC_URL=https://bugs.ezmuze.studio
DATA_DIR=/data
SERVE_WEB=true
WEB_DIST=/app/web/dist
COOKIE_SECRET=\$SECRET
COOKIE_SECURE=true
SESSION_DAYS=30
# Ways in, in the order the sign-in dialog offers them.
#   local  = email and password held in this database
#   ezmuze = the ezmuze central handshake
AUTH_PROVIDERS=local
ALLOW_SIGNUP=true
ADMIN_EMAILS=
ADMIN_EZMUZE_USER_IDS=
MAX_UPLOAD_BYTES=52428800
MAX_UPLOADS_PER_BUG=10
LOG_LEVEL=info
ENV
  chmod 600 $STATE_DIR/tracker.env
  echo "wrote $STATE_DIR/tracker.env with a generated COOKIE_SECRET"
else
  echo "$STATE_DIR/tracker.env already exists — left alone"
fi
EOF

say "Syncing source"
# tar over ssh rather than rsync: this has to run from Git Bash on Windows too,
# where rsync is not present. The source directory holds nothing but a copy of
# the repo, so replacing it wholesale is safe — state lives in $STATE_DIR.
tar --exclude=node_modules --exclude=dist --exclude=.git \
    --exclude=data --exclude='*.log' \
    -czf - . \
  | "${SSH[@]}" "rm -rf $SRC_DIR && mkdir -p $SRC_DIR && tar -xzf - -C $SRC_DIR"

say "Building and starting the container"
# The host's root docker config names a `pass` credential store whose GPG key is
# gone, which makes docker-compose abort before it builds anything. Everything
# here pulls from public Docker Hub, so point just these commands at an empty
# config directory instead of altering the machine's real one.
"${SSH[@]}" "mkdir -p $SRC_DIR/.dockercfg && echo '{}' > $SRC_DIR/.dockercfg/config.json \
  && cd $SRC_DIR && DOCKER_CONFIG=$SRC_DIR/.dockercfg docker-compose up -d --build"

say "Waiting for it to come up"
"${SSH[@]}" bash -s <<'EOF'
for i in $(seq 1 30); do
  if curl -fsS http://172.17.0.1:4310/api/health >/dev/null 2>&1; then
    echo "healthy"
    curl -s http://172.17.0.1:4310/api/health
    echo
    exit 0
  fi
  sleep 2
done
echo "the tracker did not answer within 60s" >&2
docker logs --tail 60 todont-tracker >&2
exit 1
EOF

printf '\n\033[1;32mDeployed.\033[0m Routed at https://bugs.ezmuze.studio once the proxy host exists.\n'
