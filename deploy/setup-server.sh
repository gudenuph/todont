#!/usr/bin/env bash
#
# One-time setup on the host that serves bugs.ezmuze.studio.
# Run as root:  bash setup-server.sh
#
# Safe to re-run: every step checks before it acts, and it never touches an
# nginx site other than its own.
set -euo pipefail

APP_USER=todont
APP_DIR=/opt/todont-tracker
DATA_DIR=/var/lib/todont-tracker
ENV_FILE=/etc/todont-tracker.env
SITE=bugs.ezmuze.studio
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }

# --------------------------------------------------------------------- node
say "Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$MAJOR" -ge 20 ]]; then
    echo "node $(node -v) already installed"
    NEED_NODE=0
  else
    echo "node $(node -v) is too old (need >= 20)"
  fi
fi

if [[ $NEED_NODE -eq 1 ]]; then
  echo "installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --------------------------------------------------------------- user, dirs
say "Service account and directories"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  echo "created user $APP_USER"
else
  echo "user $APP_USER exists"
fi

mkdir -p "$APP_DIR" "$DATA_DIR/uploads"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ------------------------------------------------------------------ env file
say "Environment file"
if [[ -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE already exists — leaving it alone"
else
  install -m 600 -o root -g root "$HERE/todont-tracker.env.example" "$ENV_FILE"
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  sed -i "s|^COOKIE_SECRET=.*|COOKIE_SECRET=${SECRET}|" "$ENV_FILE"
  echo "wrote $ENV_FILE with a generated COOKIE_SECRET"
fi

# ------------------------------------------------------------------- systemd
say "systemd unit"
install -m 644 "$HERE/todont-tracker.service" /etc/systemd/system/todont-tracker.service
systemctl daemon-reload
systemctl enable todont-tracker >/dev/null
echo "todont-tracker.service installed and enabled"

# --------------------------------------------------------------------- nginx
say "nginx site"
if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed — install it, then re-run this script" >&2
  exit 1
fi

install -m 644 "$HERE/nginx-$SITE.conf" "/etc/nginx/sites-available/$SITE"
ln -sfn "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"

if nginx -t; then
  systemctl reload nginx
  echo "nginx reloaded with the $SITE site"
else
  echo "nginx config test failed — the site was written but nginx was NOT reloaded" >&2
  exit 1
fi

# ----------------------------------------------------------------------- TLS
say "TLS"
if command -v certbot >/dev/null 2>&1; then
  if [[ -d "/etc/letsencrypt/live/$SITE" ]]; then
    echo "a certificate for $SITE already exists"
  else
    echo "requesting a certificate for $SITE"
    certbot --nginx -d "$SITE" --non-interactive --agree-tos \
      --register-unsafely-without-email --redirect || {
        echo "certbot failed — the site still works over http; re-run certbot once DNS resolves" >&2
      }
  fi
else
  echo "certbot is not installed; skipping TLS. Install it and run:"
  echo "  certbot --nginx -d $SITE --redirect"
fi

say "Done"
cat <<EOF
Next: push the build from your machine with deploy/deploy.sh, then

  systemctl start todont-tracker
  systemctl status todont-tracker --no-pager

Sign in at https://$SITE once — the first account through becomes admin.
Then pin it so a database reset cannot orphan the instance:

  sudo -u $APP_USER node $APP_DIR/server/dist/cli.js users
  # copy the ezmuze id, put it in ADMIN_EZMUZE_USER_IDS in $ENV_FILE
EOF
