#!/usr/bin/env bash
#
# Push this checkout to an already-provisioned host and rebuild its container.
#
#   deploy/deploy.sh user@host
#
# This is one way to run the tracker, not the way. Most instances want the
# quickstart in the README — `docker compose up -d` on the machine itself — or
# the published image. Reach for this when the host cannot build the app
# itself: the machine this was written for runs Node 16 and the app needs 22,
# so everything is built inside the container instead.
#
# Overridable, so it is not tied to any one server:
#
#   TARGET      user@host to deploy to (or the first argument)
#   SSH_KEY     key to authenticate with
#   SRC_DIR     where the source is copied on the host
#   STATE_DIR   where the database, uploads and env file live
#   BIND_ADDR   address the container publishes on
#   PUBLIC_URL  the address people will use
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# An instance keeps its own values here rather than in the repo. Untracked.
if [ -f deploy/.env.local ]; then
  # shellcheck disable=SC1091
  . deploy/.env.local
fi

TARGET="${1:-${TARGET:-}}"
if [ -z "$TARGET" ]; then
  echo "usage: deploy/deploy.sh user@host   (or set TARGET)" >&2
  exit 2
fi

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_todont_deploy}"
SRC_DIR="${SRC_DIR:-/opt/todont-tracker}"
STATE_DIR="${STATE_DIR:-/var/lib/todont-tracker}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
PUBLIC_URL="${PUBLIC_URL:-https://${TARGET#*@}}"

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes "$TARGET")

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say "Preparing $TARGET"
# The container runs as the image's `node` user (uid 1000). A bind mount keeps
# the host's ownership, so the data directory has to be owned by that uid or
# SQLite cannot create its database.
"${SSH[@]}" "mkdir -p '$SRC_DIR' '$STATE_DIR/data/uploads' && chown -R 1000:1000 '$STATE_DIR/data'"

# First run only: seed the env file with a generated cookie secret. Never
# overwrite it — that would sign every existing session out, and would undo
# whatever settings the instance has been given since.
"${SSH[@]}" bash -s <<EOF
set -e
if [ ! -f '$STATE_DIR/tracker.env' ]; then
  SECRET="\$(openssl rand -base64 48 | tr -d '\n')"
  cat > '$STATE_DIR/tracker.env' <<ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=4310
PUBLIC_URL=$PUBLIC_URL
DATA_DIR=/data
SERVE_WEB=true
WEB_DIST=/app/web/dist
COOKIE_SECRET=\$SECRET
COOKIE_SECURE=true
SESSION_DAYS=30
AUTH_PROVIDERS=local
ALLOW_SIGNUP=true
ADMIN_EMAILS=
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
REQUIRE_VERIFIED_EMAIL=false
MAX_UPLOAD_BYTES=52428800
MAX_UPLOADS_PER_BUG=10
LOG_LEVEL=info
ENV
  chmod 600 '$STATE_DIR/tracker.env'
  echo "wrote $STATE_DIR/tracker.env with a generated COOKIE_SECRET"
else
  echo "$STATE_DIR/tracker.env already exists — left alone"
fi
EOF

say "Syncing source"
# tar over ssh rather than rsync: this has to run from Git Bash on Windows too,
# where rsync is not present. The source directory holds nothing but a copy of
# the repo, so replacing it wholesale is safe — state lives in STATE_DIR.
tar --exclude=node_modules --exclude=dist --exclude=.git \
    --exclude=data --exclude='*.log' \
    -czf - . \
  | "${SSH[@]}" "rm -rf '$SRC_DIR' && mkdir -p '$SRC_DIR' && tar -xzf - -C '$SRC_DIR'"

say "Building and starting the container"
# Some hosts have a docker config naming a credential store whose key is gone,
# which makes compose abort before it builds anything. Everything here comes
# from public Docker Hub, so point just these commands at an empty config
# directory rather than altering the machine's own.
"${SSH[@]}" "mkdir -p '$SRC_DIR/.dockercfg' && echo '{}' > '$SRC_DIR/.dockercfg/config.json' \
  && cd '$SRC_DIR' \
  && DOCKER_CONFIG='$SRC_DIR/.dockercfg' \
     ENV_FILE='$STATE_DIR/tracker.env' \
     DATA_DIR='$STATE_DIR/data' \
     BIND_ADDR='$BIND_ADDR' \
     docker-compose up -d --build"

say "Waiting for it to come up"
"${SSH[@]}" "ADDR='$BIND_ADDR' bash -s" <<'EOF'
for _ in $(seq 1 30); do
  if curl -fsS "http://$ADDR:4310/api/health" >/dev/null 2>&1; then
    echo "healthy"
    curl -s "http://$ADDR:4310/api/health"
    echo
    exit 0
  fi
  sleep 2
done
echo "the tracker did not answer within 60s" >&2
docker logs --tail 60 todont-tracker >&2
exit 1
EOF

printf '\n\033[1;32mDeployed.\033[0m Reachable at %s once a proxy routes to it.\n' "$PUBLIC_URL"
