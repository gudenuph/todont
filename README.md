# ToDont Tracker

The public bug tracker for ezmuze studio, served at **https://bugs.ezmuze.studio**.

Anyone can read the board. Signing in with an ezmuze account lets you raise bugs and
comment; managers and admins move cards between columns and merge duplicates; admins
also manage who is a manager. ezmuze itself and Claude reach the same board through a
token-authenticated REST API.

```
web/     React + Vite single-page board (TypeScript)
server/  Fastify API + SQLite, and it serves the built SPA in production
mcp/     MCP server wrapping the REST API, so Claude can work the board
deploy/  nginx site, systemd unit, and the two scripts that stand it up
```

---

## The board

Nine columns, left to right. `key` is what the API uses; the label is what people see.

| key | label | |
|---|---|---|
| `unconfirmed` | Unconfirmed | where every new bug lands |
| `confirmed` | Confirmed | |
| `backlog` | Backlog | |
| `current-focus` | Current focus | |
| `in-progress` | In progress | |
| `in-beta-testing` | In beta testing | |
| `shipped` | Shipped | |
| `on-hold` | On hold | |
| `rejected` | Rejected | |

**Dragging.** Drop a card on a column to move it there; the position within the column
is kept, so a column can be ordered by priority. Drop a card on the **middle** of
another card to merge the two as duplicates — the card you dragged leaves the board and
is listed on the bug it merged into, with a "split it back out" button if that was
wrong. A card's top and bottom edges belong to the column, not the card, so there is
always somewhere to drop between two cards in a full column.

## Roles

| | read | raise & comment | move & merge | manage users |
|---|---|---|---|---|
| anonymous | ✅ | | | |
| `user` | ✅ | ✅ | | |
| `manager` | ✅ | ✅ | ✅ | |
| `admin` | ✅ | ✅ | ✅ | ✅ |

Admins promote and demote from the **Users** dialog in the top bar. An admin cannot
change their own role, and the last admin cannot be demoted — otherwise the instance
would have nobody able to manage anyone.

**Bootstrap.** On a fresh database with no `ADMIN_EZMUZE_USER_IDS` set, the first
person to sign in becomes admin. Sign in immediately after deploying, then pin your
ezmuze user id into `ADMIN_EZMUZE_USER_IDS` so the role survives a database reset.

---

## Signing in

There is no password on this site. It uses ezmuze central's **app-connect handshake** —
the same one ezmuze studio performs (`ezmuze-studio/docs/services-design.md` §2.1):

1. The server calls `POST https://api.ezmuze.co.uk/Auth/AppConnectRequest` and gets a
   connection id back.
2. You approve the request at `https://www.ezmuze.co.uk/appconnection/{requestId}`.
3. The server polls `GET /Auth/AppLogIn` until central returns an `AuthKey`, then swaps
   it for a session cookie on this site.

The handshake runs server-side for two reasons: `api.ezmuze.co.uk` sends no CORS
headers so the browser cannot call it at all, and it keeps the `AuthKey` out of the
page. The legacy username+password `PUT /Auth` endpoint is deliberately not used.

---

## The API

Base URL `https://bugs.ezmuze.studio`. Reads are public. Writes need either a session
cookie (the browser) or a token:

```
Authorization: Bearer ezb_...
```

Tokens carry scopes — `read`, `write`, `manage`, `admin` — and act as a user, so their
actions are attributed on the board like anyone else's. A token can never exceed what
its user's role allows.

### Raising a bug from ezmuze

```http
POST /api/bugs
Authorization: Bearer ezb_...
Content-Type: application/json

{
  "title": "Mixer fader jumps to silence on double-click",
  "description": "Double-click should reset to unity gain.",
  "steps": "1. Open the mixer\n2. Double-click any fader",
  "expected": "Fader resets to 0dB",
  "actual": "Fader drops to -inf",
  "severity": "major",            // critical | major | minor | trivial
  "appVersion": "2026.8.1",
  "environment": "Windows 11, desktop DX build",
  "externalRef": "ezmuze-crash-9f2c"
}
```

`externalRef` makes the call **idempotent**: raising the same ref twice returns the
existing bug with `"created": false` and HTTP 200 instead of a duplicate. Use a stable
id from whatever raised it — a crash signature, a support ticket number — and a client
that retries on a flaky connection cannot spam the board.

Everything lands in `unconfirmed` unless the token also has `manage` and passes
`status`.

### The rest

| | |
|---|---|
| `GET /api/meta` | columns and severities |
| `GET /api/bugs?status=&q=&assignee=&includeMerged=` | the board |
| `GET /api/bugs/:id` | one bug, with comments, attachments, activity, duplicates |
| `POST /api/bugs` | raise one — `write` |
| `PATCH /api/bugs/:id` | edit the text — `write` (reporter while untriaged, else `manage`) |
| `POST /api/bugs/:id/move` | `{status, index?}` — `manage` |
| `POST /api/bugs/:id/merge` | `{intoId}` — `manage` |
| `POST /api/bugs/:id/unmerge` | — `manage` |
| `POST /api/bugs/:id/assign` | `{userId\|null}` — `manage` |
| `POST /api/bugs/:id/comments` | `{body}` — `write` |
| `POST /api/bugs/:id/attachments` | multipart — `write` |
| `GET /api/attachments/:id` | the file (public) |
| `DELETE /api/attachments/:id` | uploader or `manage` |
| `GET /api/assignable` | who a bug can be assigned to — `manage` |
| `GET /api/users`, `POST /api/users/:id/role` | — `admin` |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | — `admin` |
| `GET /api/health` | liveness |

Attachments accept PNG, JPEG, GIF, WebP, PDF and plain text, 10MB each and 10 per bug.
SVG is refused on purpose: it can carry script, and attachments are served from the
same origin as the app.

---

## Claude's access

`mcp/` is an MCP server over the same REST API, registered in `.mcp.json`. It exposes
`list_bugs`, `get_bug`, `create_bug`, `update_bug`, `move_bug`, `merge_bugs`,
`unmerge_bug`, `assign_bug`, `comment_bug`, `list_assignable` and `list_columns`, so
Claude can read the queue, pick something up, move it along and keep the ticket
updated.

It needs a token in `TODONT_TOKEN`:

```bash
# on the server
sudo -u todont node /opt/todont-tracker/server/dist/cli.js \
  token "claude" --scopes read,write,manage --bot-name "Claude" --role manager
```

The token is printed once and stored hashed. Put it in your environment as
`TODONT_TOKEN` and `.mcp.json` picks it up.

---

## Running it locally

```bash
npm install
npm run build --workspace server     # or: npm run dev  (API + Vite together)
npm run dev
```

The API listens on `127.0.0.1:4310` and Vite on `5173`, proxying `/api` across. Data
goes in `./data` (gitignored). To exercise it as an admin without a real ezmuze
account, mint a token instead:

```bash
DATA_DIR=./data node server/dist/cli.js token "dev" --scopes read,write,manage,admin --role admin
curl -H "Authorization: Bearer ezb_..." localhost:4310/api/me
```

### CLI

`node server/dist/cli.js` — `users`, `promote <id|ezmuzeId> <role>`, `token <name>`,
`tokens`, `revoke <id>`. This is the way back in if nobody can sign in as an admin.

---

## Deploying

The host (your-host) runs every service in Docker, with **Nginx Proxy
Manager** owning ports 80 and 443. Services publish on the docker bridge address
`172.17.0.1:<port>`, which the proxy container can reach but the internet cannot,
and NPM terminates TLS in front. The tracker follows that convention rather than
installing a system nginx or upgrading the host's Node (still 16).

DNS: `bugs.ezmuze.studio` is a CNAME to `ezmuze.studio`, an A record to the host.

```bash
deploy/deploy.sh                      # defaults to root@your-host
```

It tars the source over ssh (no rsync on Windows), builds the image on the
server, and starts the container, then polls `/api/health` and prints the
container log if it does not come up. On the first run it also writes
`$STATE_DIR/tracker.env` with a generated `COOKIE_SECRET`;
later runs leave it alone, because replacing it signs everyone out.

Two things about this host worth knowing before you debug a failed deploy:

- Root's docker config names a `pass` credential store whose GPG key is gone, so
  `docker-compose` aborts before building anything. The deploy points only its
  own commands at an empty `DOCKER_CONFIG`; the machine's real config is
  untouched. Everything here comes from public Docker Hub.
- The container runs as the image's `node` user (uid 1000) and `/data` is a bind
  mount, which keeps the host's ownership. The deploy chowns it to 1000; without
  that SQLite fails with `SQLITE_CANTOPEN`.

### Routing

The proxy host entry in Nginx Proxy Manager (admin UI on port 8181):

| | |
|---|---|
| Domain | `bugs.ezmuze.studio` |
| Scheme | `http` |
| Forward host | `172.17.0.1` |
| Forward port | `4310` |
| Websockets | on |
| SSL | request a new Let's Encrypt certificate, force SSL |

State that is not in git and must be backed up:

```
$STATE_DIR/data/tracker.db   the board
$STATE_DIR/data/uploads/     the screenshots
$STATE_DIR/tracker.env       COOKIE_SECRET; losing it signs everyone out
```
