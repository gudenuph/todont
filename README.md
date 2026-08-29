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
deploy/  the deploy script and the environment template
```

---

## Bugs and feature requests

A feature request is a bug row with `kind: "feature"` — same board, same columns, same
triage, because the workflow genuinely is the same and a second table would only
duplicate it. The card carries the type as an emoji in its bottom-right corner: bug or
feature.

**Raise a bug** in the top bar is a split button; its caret offers the feature request.
A request hides the fields that make no sense for it — steps to reproduce, expected,
actual, and the ezmuze version — and rewords what stays. Hidden fields are sent empty,
so text typed before switching kind cannot ride along invisibly.

**Each kind has its own scale**, in the same `severity` column, because it answers the
same question and drives the same colour strip:

| | most pressing → least |
|---|---|
| bug | Critical · Major · Minor · Trivial |
| feature | I can't use ezmuze without this · It would make a big difference · Kinda want it · Just an idea |

The scales are parallel, so **retyping a ticket carries the level across by position** —
a critical bug becomes a blocking request, not a reset to the default. The API validates
the level against the ticket's kind and refuses one from the other scale. Levels also
carry a short form for the card footer, where the full wording will not fit.

`/api/meta` serves the kinds, their emoji, their hidden fields and their wording, so the
card, the dialog and the raise menu cannot drift apart. Managers can retype a ticket
from the dialog — "this is not a bug, it is a request" is a triage decision, so it needs
`manage` rather than the looser edit rule.

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

Anyone signed in can comment, on any bug. Managers additionally delete bugs, comments
and attachments, and set severity — all moderation, so none of it is available to a
plain user. Deleting is permanent and the UI asks twice; deleting a bug releases any
duplicates merged into it back onto their columns, and unlinks its uploaded files.

Severity (`critical`, `major`, `minor`, `trivial`) colours the strip down the left of
every card, so a board can be read at a glance without opening anything.

**Only my bugs** in the top bar filters the board to what you raised *or* what is
assigned to you — for a reporter that is their own reports, for a manager it is also
their queue.

**Where it happened** is a picker, not free text: the browser builds (`Web — Chrome`,
`Edge`, `Firefox`, `Safari`) and the desktop ones (`Windows`, `macOS`, `Linux`), plus
`Other`. `/api/meta` serves the list. The API still accepts *any* string here — ezmuze
raises bugs programmatically and knows more about the machine than a picker can say —
and the dialog keeps an unrecognised value selectable so saving never silently drops
it.

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

Tokens carry scopes — `read`, `write`, `manage`, `admin`, `versions` — and act as a user, so their
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

### Registering a release (the publishing pipeline)

Reporters pick their ezmuze version from a list rather than typing it, and the list is
whatever publishing has registered:

```http
POST /api/versions
Authorization: Bearer ezb_...
Content-Type: application/json

{ "name": "2026.9.0", "releasedAt": "2026-09-01T10:00:00Z" }
```

`releasedAt` is optional and defaults to now; pass it to backfill in the right order.
The call is **idempotent on `name`** — a pipeline that re-runs gets `created: false` and
HTTP 200 rather than an error it would have to special-case.

This needs a token with the **`versions`** scope, which is deliberately separate from
`manage`: publishing needs to register a release and nothing else, and a CI token that
could also delete bugs would be far too much authority.

```bash
ssh root@your-host 'docker exec todont-tracker   node server/dist/cli.js token "ezmuze-publish"     --scopes read,versions --bot-name "ezmuze publishing" --role manager'
```

`GET /api/versions` is public and returns the list plus the default. **Unreleased** is
seeded into the database, always sorts last, is reserved (publishing cannot claim the
name) and cannot be deleted — someone reporting against a dev build still needs
something to pick. A new report defaults to the newest actual release, so most reporters
touch nothing.

Bugs store the version as plain text, not a foreign key, so removing a version never
rewrites history — and the picker keeps an unrecognised value selectable, so editing an
old bug cannot silently drop the version it was raised against.

### Crash reporting: "have you seen this?"

ezmuze can ask whether a crash is already known before it bothers anyone:

```http
POST /api/stack-traces/check
Authorization: Bearer ezb_...
Content-Type: application/json

{ "stackTrace": "System.IO.DirectoryNotFoundException: ..." }
```

- **Seen before** → `{ "raised": true, "occurrences": 42, "bug": {...} }`, and the count
  on that ticket goes up by one.
- **New** → `{ "raised": false, "fingerprint": "...", "normalized": "..." }`. Pass the
  trace to `POST /api/bugs` as `stackTrace` to raise it.

Needs `write`. `GET /api/stack-traces/:fingerprint` returns the full ticket behind one.

**Matching.** The same fault reaches us as different text on every machine, so the trace
is normalised before it is hashed: home directories become `<HOME>`, temp folders
`<TMP>`, GUIDs `<GUID>`, heap addresses `<ADDR>`, and a dotted version inside a *path*
becomes `<VERSION>` — an install directory named after the release would otherwise make
the same crash look new on every ship. A second pass, used only for matching and never
shown, folds path separators and .NET runtime identifiers (`win-x64-dx`, `osx-arm64`,
`linux-x64`) together, so one fault in shared code is one ticket across all three
platforms rather than three.

Match is then **exact on the normalised text**. That is deliberate: a reporter can be
told precisely why two traces did or did not group, which a similarity score cannot.
A version quoted in a message ("expected 2.0 or later") is left alone — only paths are
generalised. Anything under 20 characters after normalising is refused, so "it crashed"
cannot become the parent of every future crash.

**Traces are stored already normalised**, so no username or machine path lands on a
board that anyone can read.

**Only managers and admins can read a trace**, on any ticket — including the person who
reported it. Everyone else sees that one was attached, which is what tells a reporter
their crash details arrived. This is enforced in `serializeDetail`, not in the UI: the
board is world-readable and hiding it client-side would leave it a `curl` away. The
parameter defaults to *not* visible, so a new call site cannot leak one by forgetting.

`POST /api/bugs` applies the same matching: raising a bug whose trace is already known
returns the existing ticket with `created: false`, `alreadyRaised: true` and the new
count, instead of a duplicate. A client that skips the check call and just reports every
crash still behaves correctly.

The count shows as `↻ 42` on the card and "Seen 42 times" on the ticket, and is separate
from merged duplicates (`×3`), which count people who reported it by hand.

### Raising a bug from inside ezmuze

> The app-side brief lives in [`docs/ezmuze-app-integration.md`](docs/ezmuze-app-integration.md) —
> hand that to whoever implements it in ezmuze studio.

The app opens the browser at a report it has already filled in. Two ways in.

**With a stack trace** — POST what you know, open the URL you get back:

```http
POST /api/drafts            (no credential)
{ "title": "...", "stackTrace": "...", "appVersion": "2026.8.2",
  "environment": "Windows (desktop)" }

→ { "id": "Df06lRssosI3",
    "url": "https://bugs.ezmuze.studio/?draft=Df06lRssosI3",
    "expiresInMinutes": 60 }
```

**Without one** — just open a link:
`https://bugs.ezmuze.studio/?raise=bug&version=2026.8.2&platform=Windows%20(desktop)`

A draft exists because a stack trace will not survive a query string, and putting one
there would spill it into every proxy log on the way. It is **unauthenticated on
purpose**: shipping a token inside a desktop app ships it to everyone who can read the
binary, and a draft is not a bug — it is inert text that still needs a signed-in person
to submit it. It is rate limited, capped, and expires in an hour.

Traces are normalised when the draft is stored, so the reporter sees on the form exactly
what will be saved — no username or machine path.

If the crash is already on the board, `GET /api/drafts/:id` says so, and the form tells
the reporter before they write anything: sending it anyway counts against the existing
ticket rather than opening a second one.

**Not signed in?** The site asks them to sign in first, explains why, and drops them into
the filled-in form afterwards — the prefill survives the handshake.

### The rest

| | |
|---|---|
| `GET /api/meta` | columns and severities |
| `GET /api/bugs?status=&kind=&q=&assignee=&mine=&includeMerged=` | the board; `mine=true` needs a signed-in caller |
| `GET /api/bugs/:id` | one bug, with comments, attachments, activity, duplicates |
| `POST /api/bugs` | raise one — `write` |
| `PATCH /api/bugs/:id` | edit the text — `write` (reporter while untriaged, else `manage`) |
| `POST /api/bugs/:id/move` | `{status, index?}` — `manage` |
| `POST /api/bugs/:id/merge` | `{intoId}` — `manage` |
| `POST /api/bugs/:id/unmerge` | — `manage` |
| `POST /api/bugs/:id/assign` | `{userId\|null}` — `manage` |
| `POST /api/bugs/:id/comments` | `{body}` — `write` |
| `DELETE /api/bugs/:id` | delete a bug outright — `manage` |
| `DELETE /api/comments/:id` | delete one comment — `manage` |
| `POST /api/bugs/:id/attachments` | multipart — `write` |
| `GET /api/attachments/:id` | the file (public) |
| `DELETE /api/attachments/:id` | uploader or `manage` |
| `GET /api/assignable` | who a bug can be assigned to — `manage` |
| `GET /api/users`, `POST /api/users/:id/role` | — `admin` |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | — `admin` |
| `POST /api/drafts` | prefilled report from the app (no credential, rate limited) |
| `GET /api/drafts/:id` | read one back, with `knownBug` if the crash is known |
| `POST /api/stack-traces/check` | is this crash known? counts it if so — `write` |
| `GET /api/stack-traces/:fingerprint` | the ticket behind a fingerprint (public) |
| `GET /api/versions` | the version list and the default (public) |
| `POST /api/versions` | register a release — `versions` |
| `DELETE /api/versions/:id` | remove a mistyped one — `admin` |
| `GET /api/health` | liveness |

Attachments accept PNG, JPEG, GIF, WebP, **WebM, MP4**, PDF and plain text — 50MB each
and 10 per bug. Screen recordings play inline on the bug; they are served as a stream
with byte-range support, which a browser needs in order to seek (and which Safari needs
in order to play video at all).

SVG is refused on purpose: it can carry script, and attachments are served from the same
origin as the app. `.mov` is not accepted yet — say if you want it, it is one line.

The proxy host's `client_max_body_size` must stay above `MAX_UPLOAD_BYTES`, or a large
upload dies at nginx with a 413 the app never sees.

---

## Claude's access

`mcp/` is an MCP server over the same REST API, registered in `.mcp.json`. It exposes
`list_bugs`, `get_bug`, `create_bug`, `update_bug`, `move_bug`, `merge_bugs`,
`unmerge_bug`, `assign_bug`, `comment_bug`, `list_assignable` and `list_columns`, so
Claude can read the queue, pick something up, move it along and keep the ticket
updated.

It needs a token in `TODONT_TOKEN`:

```bash
ssh root@your-host 'docker exec todont-tracker \
  node server/dist/cli.js token "claude" \
    --scopes read,write,manage --bot-name "Claude" --role manager'
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
