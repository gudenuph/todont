#!/usr/bin/env bash
#
# Back up a running instance: the database, the uploads, and the env file.
#
#   deploy/backup.sh                      # on the host, or via cron
#   STATE_DIR=/srv/todont deploy/backup.sh
#
# Everything worth keeping is in three places, so this is deliberately a
# tarball and not a backup system. Restoring is `tar -xzf` into STATE_DIR.
#
#   STATE_DIR    where the instance keeps its data (default /var/lib/todont-tracker)
#   BACKUP_DIR   where archives go        (default $STATE_DIR/backups)
#   KEEP         how many to keep         (default 14)
set -euo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/todont-tracker}"
BACKUP_DIR="${BACKUP_DIR:-$STATE_DIR/backups}"
KEEP="${KEEP:-14}"

DB="$STATE_DIR/data/tracker.db"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$DB" ] || { echo "no database at $DB" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

# A live SQLite file cannot just be copied — a write mid-copy leaves a torn
# database that restores to nothing. .backup takes a consistent snapshot while
# the server keeps serving. VACUUM INTO is the modern equivalent and needs no
# sqlite3 binary on the host, so use whichever is available.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$WORK/tracker.db'"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx todont-tracker; then
  # The container has SQLite through better-sqlite3, so borrow it.
  docker exec todont-tracker node -e "
    const D = require('better-sqlite3');
    D('/data/tracker.db').exec(\"VACUUM INTO '/data/.backup-tmp.db'\");
  "
  mv "$STATE_DIR/data/.backup-tmp.db" "$WORK/tracker.db"
else
  echo "need either sqlite3 on the host or the running container" >&2
  exit 1
fi

# Uploads and the env file. The env file holds COOKIE_SECRET: losing it signs
# everybody out, so it belongs in the backup — which is also why the archive is
# created private.
cp -a "$STATE_DIR/data/uploads" "$WORK/uploads" 2>/dev/null || mkdir -p "$WORK/uploads"
[ -f "$STATE_DIR/tracker.env" ] && cp -a "$STATE_DIR/tracker.env" "$WORK/tracker.env"

ARCHIVE="$BACKUP_DIR/todont-$STAMP.tar.gz"
(umask 077 && tar -czf "$ARCHIVE" -C "$WORK" .)

# Keep the last KEEP, drop the rest.
ls -1t "$BACKUP_DIR"/todont-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f

printf '%s  (%s)\n' "$ARCHIVE" "$(du -h "$ARCHIVE" | cut -f1)"

# A backup nobody has restored is a guess. Prove the database in the archive
# opens and has the tables it should.
VERIFY="$(mktemp -d)"
trap 'rm -rf "$WORK" "$VERIFY"' EXIT
tar -xzf "$ARCHIVE" -C "$VERIFY" ./tracker.db

if command -v sqlite3 >/dev/null 2>&1; then
  COUNT="$(sqlite3 "$VERIFY/tracker.db" 'SELECT COUNT(*) FROM bugs')"
elif command -v docker >/dev/null 2>&1; then
  # No sqlite3 on the host, so read it back through the container the same way
  # the app would — which is a truer test of "will this restore" anyway.
  cp "$VERIFY/tracker.db" "$STATE_DIR/data/.verify-tmp.db"
  COUNT="$(docker exec todont-tracker node -e "
    const D = require('better-sqlite3');
    process.stdout.write(String(D('/data/.verify-tmp.db', { readonly: true })
      .prepare('SELECT COUNT(*) AS n FROM bugs').get().n));
  ")"
  rm -f "$STATE_DIR/data/.verify-tmp.db"
else
  echo "could not verify the archive: no sqlite3 and no docker" >&2
  exit 1
fi

echo "verified: $COUNT tickets readable from the archive"

