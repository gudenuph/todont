# ToDont Tracker

A small, self-hosted bug tracker: a drag-and-drop board, crash-trace deduplication,
and an API for the app you are tracking bugs for. One container, one SQLite file.

Anyone can read the board. Signing in lets you raise bugs and comment; managers and
admins move cards between columns and merge duplicates; admins also manage who is a
manager. Your app and your coding agent reach the same board through a
token-authenticated REST API.

Built for, and running as, the bug tracker for [ezmuze studio](https://bugs.ezmuze.studio).

**MIT licensed.** See [LICENSE](LICENSE).

## Quickstart

```bash
git clone <this repo> && cd ToDontTracker
cp .env.example .env          # set PUBLIC_URL and COOKIE_SECRET
docker compose up -d          # http://localhost:4310
```

The first account you create becomes the admin. From the **Admin** dialog you can rename
the board, reshape its lanes, and change what a ticket even is.

For HTTPS on your own domain, with certificates obtained and renewed for you:

```bash
SITE_ADDRESS=bugs.example.com   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Set `PUBLIC_URL=https://bugs.example.com` and `COOKIE_SECURE=true` in `.env` at the same
time — with `COOKIE_SECURE` on and a plain-http address, the browser will not send the
session cookie and signing in will appear to fail for no reason.

Already running a reverse proxy? Skip the TLS file and point yours at the published port.

State lives in `./data` (or wherever `DATA_DIR` says) and is the only thing to back up.

```
web/     React + Vite single-page board (TypeScript)
server/  Fastify API + SQLite, and it serves the built SPA in production
mcp/     MCP server wrapping the REST API, so Claude can work the board
deploy/  the deploy script and the environment template
```

---

## Bugs and feature requests

**Ticket types are data**, edited from the admin panel: a default install has Bug and
Feature request, and an instance can rename them, change their emoji, add its own, or
reshape what each one asks for. A type is a `kind` on the bug row — same board, same
lanes, same triage — because the workflow genuinely is the same and a second table would
only duplicate it.

Each type carries its own **scale** (a bug's severity, a request's "how much do you want
it?"), its own **hidden fields** — the ones that make no sense for it — and its own
**wording** for the fields that remain. All of it is served by `/api/meta`, so the card,
the form and the raise menu cannot drift apart.

Types and levels have permanent keys like lanes do, so renaming either moves no tickets.
Removing a type or a level that holds tickets makes you say where they go, and a type
that loses its tickets to another carries each one's level across **by position** — the
same rule as retyping a single ticket. The card carries the type as an emoji in its bottom-right corner: bug or
feature.

**Raise a bug** in the top bar is a split button; its caret offers the feature request.
A request hides the fields that make no sense for it — steps to reproduce, expected,
actual, and the app version — and rewords what stays. Hidden fields are sent empty,
so text typed before switching kind cannot ride along invisibly.

**Each kind has its own scale**, in the same `severity` column, because it answers the
same question and drives the same colour strip:

| | most pressing → least |
|---|---|
| bug | Critical · Major · Minor · Trivial |
| feature | I can't use it without this · It would make a big difference · Kinda want it · Just an idea |

The scales are parallel, so **retyping a ticket carries the level across by position** —
a critical bug becomes a blocking request, not a reset to the default. The API validates
the level against the ticket's kind and refuses one from the other scale. Levels also
carry a short form for the card footer, where the full wording will not fit.

`/api/meta` serves the kinds, their emoji, their hidden fields and their wording, so the
card, the dialog and the raise menu cannot drift apart. Managers can retype a ticket
from the dialog — "this is not a bug, it is a request" is a triage decision, so it needs
`manage` rather than the looser edit rule.

## The board

Lanes live in the database and are edited from the **Admin** dialog — add, rename,
recolour, reorder, remove. A new instance is seeded with nine: Unconfirmed, Confirmed,
Backlog, Current focus, In release queue, In beta testing, Shipped, On hold, Rejected.

Each lane has a permanent `key`, which is what every ticket stores, and a `label`, which
is what people see. Renaming a lane changes only the label, so no ticket moves — this is
why "In progress" could become "In release queue" without a migration. The key is
generated from the name once, at creation, and never changes.

Rules the admin routes enforce, so the board cannot be broken from the panel:

- **Exactly one intake lane.** Naming a new one stands the old one down; clearing the
  last one is refused, because new reports need somewhere to land.
- **The intake lane cannot be removed**, nor can the last remaining lane.
- **Removing a lane that holds tickets requires saying where they go.** Nothing is
  silently dropped.
- **Reorder sends the whole order at once**, so there is no half-applied state.

The board's name and tagline are settings too, on the same dialog.

### Settings: environment, then panel

Anything that is **policy** can be changed from the Admin dialog while the server runs —
the environment supplies the starting value, a row in `settings` overrides it:

| | |
|---|---|
| Sign-in | which providers are on, whether anyone may sign up, whether an address must be confirmed, how long a session lasts |
| Email | SMTP server, port, credentials, from address — with a **send a test** button, so you find out it works before a user finds out it does not |
| Board | name, tagline, largest attachment, attachments per ticket, live updates |
| Backups | how often, what goes in one, how many to keep, and where copies are sent — with a **back up now** button |

Anything needed to **reach** the database or the site stays in the environment: `PORT`,
`HOST`, `DATA_DIR`, `PUBLIC_URL`, `COOKIE_SECRET`, `COOKIE_SECURE`, `SERVE_WEB`. Getting
one of those wrong from a web form would lock everybody out of the web form.

Two guards worth knowing, because both are the kind of mistake you only make once:

- **You cannot switch off the way you signed in.** Doing so would lock you out of the
  page you are standing on. At least one provider must stay enabled regardless.
- **The attachment limit can be lowered but not raised past what the server started
  with**, because the upload parser's ceiling is fixed at boot. Raising it needs a
  restart, and the panel says so.

A saved SMTP password is never handed back out, not even to the admin who typed it —
sending an empty one means "leave it alone" rather than "clear it".

**Dragging.** Drop a card on a column to move it there; the position within the column
is kept, so a column can be ordered by priority. Drop a card on the **middle** of
another card to merge the two as duplicates — the card you dragged leaves the board and
is listed on the bug it merged into, with a "split it back out" button if that was
wrong. A card's top and bottom edges belong to the column, not the card, so there is
always somewhere to drop between two cards in a full column.

## Staying current

An open board checks for changes on a timer and brings them in without a reload, so two
people looking at the same board see the same thing. **Admin → Board → live updates**
turns it on or off, sets the interval, and decides whether changes animate.

It is a poll, not a socket. On a box small enough to run this, a short request every
twenty seconds costs less — in code, and in memory held per viewer — than a connection
kept open for everyone reading the board. The poll itself reads four numbers and returns
a short string; the board is only re-read when that string differs from the one the tab
already holds.

That stamp comes back with the board data as well as from the poll, which matters more
than it sounds: if the tab took its baseline separately, anything that happened between
reading the board and taking the first stamp would be folded into the baseline and never
shown, and the board would sit there quietly out of date.

What you see when something changes:

| | |
|---|---|
| **New** | drops in, ringed green, badged `new` |
| **Moved** | slides from its old lane to its new one, ringed blue, badged `moved` |
| **Updated** | ringed amber, badged `updated` |

The slide is a FLIP animation — the card is laid out where it now belongs, then animated
from where it used to be. Without it a card someone else moved simply teleports on the
next poll and you are left working out what you missed.

The marks clear themselves after a few seconds: they are an announcement, not a state.
A card counts as updated when **what the card shows** has changed rather than when its
timestamp has, because `updated_at` is stored to the second and an edit made in the same
second as the change before it would otherwise slip past unmarked.

Two things it will not do. It does not poll while you are dragging — re-rendering the
board under the pointer would be both wrong and unpleasant — and it does not poll while
the tab is in the background, though it checks the moment you come back to it. Anyone
whose system asks for reduced motion gets the rings and badges without the movement.

Five seconds is the floor whatever the panel is set to, so a mistyped `1` cannot have
every open tab hammering the box.

## Dependencies

A ticket can be **blocked by** any number of others, and shows both sides: what it is
waiting on, and what is waiting on it. Setting one is triage, so it needs `manage` — the
same bar as moving a card, which is usually the same decision.

Loops are refused, transitively: if #4 already waits on #1 through a chain, #1 cannot be
made to wait on #4, because neither could ever become unblocked.

On the board a blocked card says so and its severity strip goes dashed. **Hovering one
dims every card that is not holding it up**, so "what is this waiting on?" is answered by
pointing rather than by opening anything. Only blocked cards do this — on anything else
there would be nothing to point at — and never mid-drag.

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

**Where it happened** is a picker, not free text, and the list is editable from the admin
panel. `/api/meta` serves it. The API still accepts *any* string — a client raising bugs
programmatically knows more about the machine than a picker can say — and the dialog
keeps an unrecognised value selectable so saving never silently drops it.

Admins promote and demote from the **Users** dialog in the top bar. An admin cannot
change their own role, and the last admin cannot be demoted — otherwise the instance
would have nobody able to manage anyone.

**Bootstrap.** On a fresh database with no admin pinned in the environment, the first
person to sign in becomes admin. Sign in immediately after deploying, then pin yourself
— `ADMIN_EMAILS` for an email account, `ADMIN_EZMUZE_USER_IDS` for an ezmuze one — so
the role survives a database reset.

---

## Signing in

An instance chooses its ways in with `AUTH_PROVIDERS`, and the sign-in dialog offers
whatever is listed, in that order.

### `local` — email and password (the default)

Accounts live in this database. Passwords are hashed with **scrypt** from Node's own
crypto — deliberately not bcrypt or argon2, both of which are native modules, and this
project has already worked around native-build friction once. The parameters travel
inside the stored hash, so they can be raised later without invalidating anyone.

- `ALLOW_SIGNUP=false` closes registration; existing accounts still sign in.
- `ADMIN_EMAILS` names accounts that are always admin.
- Login answers with **one message for every failure**, so it cannot be used to find out
  who has an account, and it hashes even for an unknown address so a miss is not
  obviously faster to probe. It is rate limited to 20 attempts per 15 minutes.
- **Email verification** is sent if SMTP is configured — see below.
- `POST /api/auth/password` changes your own, and needs the current one. Other sessions
  survive it — signing yourself out of your phone for changing a password is rude.

### Email

Optional. With no `SMTP_HOST` the tracker behaves exactly as it did before, and
verification links are written to the log instead — so a self-hoster with no mail server
can still finish a signup by copying one out of `docker logs`.

Volume is a handful of messages a day at most, so this is one plain SMTP connection: no
queue, no worker, no delivery service. **A Gmail account with an app password is a
perfectly good backend.**

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop     # an App Password, not your account password
MAIL_FROM=ToDont <you@gmail.com>
REQUIRE_VERIFIED_EMAIL=true
```

Gmail refuses a normal account password when 2FA is on, which it is by default. Create an
**App Password** at <https://myaccount.google.com/apppasswords> and use that. Port 465 is
implicit TLS; 587 also works and starts plain before upgrading.

`REQUIRE_VERIFIED_EMAIL=true` stops an unconfirmed local account **writing** — reading is
public anyway, so this only ever bites on raising a bug or commenting. Left false, people
are nudged with a banner and nothing is blocked, which keeps an instance usable with no
mail server at all.

Details worth knowing:

- Links are **stored hashed** and are single use, expiring in 24 hours. Asking for a new
  one kills the old one.
- **Sending never fails a signup.** A mail server having a bad morning must not cost
  somebody their account; the failure is logged with the link so it can be recovered by
  hand.
- Accounts created before verification existed are treated as verified. Adding a check
  should not retroactively lock out somebody who signed up when there was nothing to
  comply with.
- `SMTP_ALLOW_INSECURE_TLS=true` accepts a certificate that does not verify. Only for an
  internal relay with a self-signed certificate on a network you trust — the error it
  papers over is otherwise a very cryptic dead end.

### Forgotten passwords

`POST /api/auth/forgot` emails a link; `POST /api/auth/reset` takes the token and a new
password. Both are on the sign-in dialog.

- **The answer to "forgot" never varies** — same message for a real address, an unknown
  one, and an account that only signs in through a provider — so it cannot be used to
  find out who has an account.
- A reset link lasts **one hour**, against a verification link's 24: this one can take an
  account over.
- **Resetting ends every other session.** Unlike a deliberate password change, which
  leaves them alone, a reset is what you reach for when you have lost control of an
  account — leaving whoever else was signed in still signed in would defeat the point.
- It also **confirms the address**, because reading the mail proves what a verification
  link proves.

With no SMTP configured the link goes to the log, so an admin can still hand it over.

### `ezmuze` — an app-connect handshake

The provider this tracker was first built against. It is here as a **worked example of
a second provider**, not because you need it: if you are adding your own single sign-on,
this is the shape it takes.

1. The server calls `POST https://api.ezmuze.co.uk/Auth/AppConnectRequest` and gets a
   connection id back.
2. You approve the request at `https://www.ezmuze.co.uk/appconnection/{requestId}`.
3. The server polls `GET /Auth/AppLogIn` until central returns an `AuthKey`, then swaps
   it for a session cookie on this site.

The handshake runs server-side for two reasons: `api.ezmuze.co.uk` sends no CORS
headers so the browser cannot call it at all, and it keeps the `AuthKey` out of the
page. The legacy username+password `PUT /Auth` endpoint is deliberately not used.

### Adding another

A login is a row in `identities` — `(provider, subject, user_id)` — so an account can
gain a second way in without the others knowing. A new provider needs a route that
proves who someone is and then calls `upsertFederatedUser(provider, subject, name,
email?)`; nothing else in the codebase asks how anyone signed in.

Matching is on the identity, never on a display name. An email is attached only when the
provider supplies one **and** nobody already holds it, so a federated login can never
take over an existing local account.

---

## The API

Base URL is wherever you host it. Reads are public. Writes need either a session
cookie (the browser) or a token:

```
Authorization: Bearer ezb_...
```

Tokens carry scopes — `read`, `write`, `manage`, `admin`, `versions` — and act as a user, so their
actions are attributed on the board like anyone else's. A token can never exceed what
its user's role allows.

### Raising a bug from your app

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
  "externalRef": "crash-9f2c"
}
```

`externalRef` makes the call **idempotent**: raising the same ref twice returns the
existing bug with `"created": false` and HTTP 200 instead of a duplicate. Use a stable
id from whatever raised it — a crash signature, a support ticket number — and a client
that retries on a flaky connection cannot spam the board.

Everything lands in `unconfirmed` unless the token also has `manage` and passes
`status`.

### Registering a release (the publishing pipeline)

Reporters pick their version from a list rather than typing it, and the list is
whatever your publishing pipeline has registered:

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
ssh root@your-host 'docker exec todont-tracker   node server/dist/cli.js token "publishing"     --scopes read,versions --bot-name "Publishing" --role manager'
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

Your app can ask whether a crash is already known before it bothers anyone:

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

**No credential needed**, and deliberately so. It writes, but the caller cannot choose
what: it picks no bug, sets no content and creates nothing — it hands over a trace and the
server decides, from a hash, whether an existing counter moves by one. Moving a counter at
all means already holding the real trace, which means having the app and having hit the
crash, in which case the count is honest. Rate limited to 120 per hour per IP.

`GET /api/stack-traces/:fingerprint` returns the ticket behind one.

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

### Raising a bug from inside your app

> The client-side brief lives in [`docs/client-integration.md`](docs/client-integration.md) —
> hand that to whoever implements reporting inside your application.

The app opens the browser at a report it has already filled in. Two ways in.

**With a stack trace** — POST what you know, open the URL you get back:

```http
POST /api/drafts            (no credential)
{ "title": "...", "stackTrace": "...", "appVersion": "2026.8.2",
  "environment": "Windows (desktop)" }

→ { "id": "Df06lRssosI3",
    "url": "https://bugs.example.com/?draft=Df06lRssosI3",
    "expiresInMinutes": 60 }
```

**Without one** — just open a link:
`https://bugs.example.com/?raise=bug&version=2026.8.2&platform=Windows%20(desktop)`

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
| `GET /api/bugs?status=&kind=&q=&assignee=&mine=&includeMerged=` | the board, plus the `stamp` it corresponds to; `mine=true` needs a signed-in caller |
| `GET /api/bugs/:id` | one bug, with comments, attachments, activity, duplicates |
| `POST /api/bugs` | raise one — `write` |
| `PATCH /api/bugs/:id` | edit the text — `write` (reporter while untriaged, else `manage`) |
| `POST /api/bugs/:id/move` | `{status, index?}` — `manage` |
| `POST /api/bugs/:id/merge` | `{intoId}` — `manage` |
| `POST /api/bugs/:id/unmerge` | — `manage` |
| `POST /api/bugs/:id/assign` | `{userId\|null}` — `manage` |
| `POST /api/bugs/:id/blockers` | `{blockerId}` — `manage` |
| `DELETE /api/bugs/:id/blockers/:blockerId` | — `manage` |
| `POST /api/bugs/:id/comments` | `{body}` as JSON, **or** multipart with `body` and files — `write` |
| `DELETE /api/bugs/:id` | delete a bug outright — `manage` |
| `DELETE /api/comments/:id` | delete one comment — `manage` |
| `POST /api/bugs/:id/attachments` | multipart — `write` |
| `POST /api/comments/:id/attachments` | multipart — the comment's author or `manage` |
| `GET /api/attachments/:id` | the file (public) |
| `DELETE /api/attachments/:id` | uploader or `manage` |
| `GET /api/assignable` | who a bug can be assigned to — `manage` |
| `GET /api/users`, `POST /api/users/:id/role` | — `admin` |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | — `admin` |
| `POST /api/drafts` | prefilled report from the app (no credential, rate limited) |
| `GET /api/drafts/:id` | read one back, with `knownBug` if the crash is known |
| `POST /api/stack-traces/check` | is this crash known? counts it if so (no credential) |
| `GET /api/stack-traces/:fingerprint` | the ticket behind a fingerprint (public) |
| `GET /api/versions` | the version list and the default (public) |
| `POST /api/versions` | register a release — `versions` |
| `DELETE /api/versions/:id` | remove a mistyped one — `admin` |
| `GET /api/board/version` | has anything changed? a stamp plus the live-update policy (public) |
| `GET /api/health` | liveness |
| `GET/POST /api/admin/columns`, `PATCH`/`DELETE /api/admin/columns/:id` | lanes — `admin` |
| `POST /api/admin/columns/reorder` | `{ids}` in the new order — `admin` |
| `GET/PATCH /api/admin/settings` | board name and tagline — `admin` |

### Images on a comment

A comment can carry them too, which is usually where a screenshot belongs: it is
answering something rather than describing the bug. Post the comment and its files in
one request, so the comment is never briefly on the board without the picture it is
about:

```http
POST /api/bugs/42/comments
Authorization: Bearer ezb_...
Content-Type: multipart/form-data

body=Here is what I see after step 3
file=@shot.png
file=@after.png
```

JSON with a `{body}` still works and is unchanged. To add to a comment that is already
there, `POST /api/comments/:id/attachments` with the files alone. **A picture on its own
is a valid comment** — `body` may be empty when at least one file is attached.

Comment images stay out of the bug's own gallery and out of the card's attachment count,
so the badge always agrees with what the gallery shows. They are ordinary attachments
otherwise: same types, same limits, same `GET /api/attachments/:id`, same delete rule.
Deleting a comment takes its images with it, files and all.

In the browser, paste or drop straight onto the comment box — a screenshot is on the
clipboard far more often than it is on disk.

### Limits and types

Attachments accept PNG, JPEG, GIF, WebP, **WebM, MP4**, PDF and plain text — 50MB each,
10 per bug and 10 per comment (a long thread with a screenshot on each reply is normal,
so comments do not eat into the bug's own allowance). Comments take images and
recordings only: a PDF belongs in the bug's attachments. Screen recordings play inline on the bug; they are served as a stream
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

Setup, the token, the tool list and some board conventions are in
[`docs/claude-access.md`](docs/claude-access.md). In short, it needs a token in
`TODONT_TOKEN`:

```bash
ssh root@your-host 'docker exec todont-tracker \
  node server/dist/cli.js token "claude" \
    --scopes read,write,manage --bot-name "Claude" --role manager'
```

The token is printed once and stored hashed. Put it in your environment as
`TODONT_TOKEN` and `.mcp.json` picks it up.

---

## Contributing

```bash
npm install
npm test          # builds, then runs the server suite
npm run test:e2e  # and the browser one
npm run dev       # API on 4310, Vite on 5173
```

CI runs the same `npm run build` and `npm test` on every push and pull request, and
separately proves the Docker image still builds — so a broken image is found on the
change that broke it rather than at release time.

**Server tests** live beside what they test (`*.test.ts`) and use Node's own test runner;
there is no framework to learn. Integration tests drive the real app through Fastify's
`inject()`, so they exercise routes, hooks and auth without binding a port — see
`server/src/test/harness.ts`, which stands a whole tracker up on a throwaway database.

**Browser tests** are in `e2e/`, and exist for what no server test can reach: dragging a
card between lanes, the band that separates "merge with this" from "drop between these",
and the dimming that answers "what is this waiting on?". All three are computed from live
layout, so jsdom — which reports every element as zero by zero — cannot test them at all.
They run against the built app on a throwaway database, one lane of traffic, no mocking.

Where a browser test could be pixel-hunting, it asserts on the app's own decision instead:
the drag helper reports whether the app was going to merge at the moment of release, so a
three-pixel layout shift cannot make a green test go red.

Tagging a version (`git tag v1.0.0 && git push --tags`) publishes a multi-architecture
image to GHCR.

## Running it locally

```bash
npm install
npm run build --workspace server     # or: npm run dev  (API + Vite together)
npm run dev
```

The API listens on `127.0.0.1:4310` and Vite on `5173`, proxying `/api` across. Data
goes in `./data` (gitignored). To exercise it as an admin without a federated
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

Most instances want the quickstart at the top of this file: `docker compose up -d` on
the machine itself, or the published image. This section is for the shape the tracker
was first deployed into, because it is a common one — a small VPS already running
several services in Docker behind one reverse proxy.

In that arrangement the proxy (Nginx Proxy Manager, Caddy, Traefik) owns ports 80 and
443, and each service publishes on the docker bridge address `172.17.0.1:<port>`, which
the proxy container can reach but the internet cannot. TLS terminates at the proxy. The
tracker follows that convention rather than installing a system nginx of its own — and
it never needs the host's Node, because the app is built inside the container.

DNS: point a record at the host, or a CNAME at something that already resolves to it.

```bash
deploy/deploy.sh root@your-host
```

`deploy/deploy.sh` reads `deploy/.env.local` if it exists, so an instance keeps its own
target, paths and public URL there rather than in the repo. That file is untracked:

```bash
TARGET=root@your-host
SRC_DIR=/opt/todont-tracker           # where the source is copied
STATE_DIR=/var/lib/todont-tracker     # where the data lives
BIND_ADDR=172.17.0.1                  # docker bridge, so only the proxy can reach it
PUBLIC_URL=https://bugs.example.com
```

It tars the source over ssh (no rsync on Windows), builds the image on the
server, and starts the container, then polls `/api/health` and prints the
container log if it does not come up. On the first run it also writes
`$STATE_DIR/tracker.env` with a generated `COOKIE_SECRET`; later runs leave it
alone, because replacing it signs everyone out.

Two things worth knowing before you debug a failed deploy on a host like this:

- If root's docker config names a credential store whose key is missing,
  `docker-compose` aborts before building anything. The deploy points only its
  own commands at an empty `DOCKER_CONFIG`; the machine's real config is
  untouched. Everything here comes from public Docker Hub.
- The container runs as the image's `node` user (uid 1000) and `/data` is a bind
  mount, which keeps the host's ownership. The deploy chowns it to 1000; without
  that SQLite fails with `SQLITE_CANTOPEN`.

### Routing

The proxy host entry, in Nginx Proxy Manager's terms:

| | |
|---|---|
| Domain | `bugs.example.com` |
| Scheme | `http` |
| Forward host | `172.17.0.1` |
| Forward port | `4310` |
| Websockets | on |
| SSL | request a new Let's Encrypt certificate, force SSL |

### Backups

**Admin → Backups.** Pick how often (never, hourly, daily, weekly), what goes in one, how
many to keep, and where a copy is sent. There is a **back up now** button, because a
destination you have not proved is a destination you do not have.

A backup is one `.tar.gz` holding a consistent snapshot of the database and, if you want
it, the attachments. A live SQLite file cannot simply be copied — a write mid-copy leaves
a torn database that restores to nothing — so it is taken with `VACUUM INTO` while the
server keeps serving. Restoring is `tar -xzf` over the data directory.

The two halves are wildly different sizes, and that decides most of the configuration:
the database is the tickets, the comments, the accounts and the history, and it is
typically well under a megabyte. The attachments are usually a hundred times that. A
database-only archive fits in an email; a full one does not.

| Destination | What it needs |
|---|---|
| **This machine** | Nothing. Always written, `backup.keep` retained, oldest pruned first. |
| **Email** | The mail server from the Email tab. Refused over 20MB, because most mailboxes bounce anything near 25 and do it silently. |
| **Object storage** | An S3-compatible bucket — Backblaze B2, Cloudflare R2, MinIO, AWS. Endpoint, bucket, key, secret. Signed by hand, no SDK. |
| **A command** | Off unless the server sets `BACKUP_ALLOW_COMMAND=true`. Runs with `$BACKUP_FILE` set to the archive. |

Each is tried independently: one that fails is reported, and does not stop the others.

**Copies on this machine are not a backup.** They cover deleting the wrong thing; they do
not cover losing the machine. Configure at least one of the other three if the board
matters. Object storage is the plainest answer — B2 and R2 both have free tiers far larger
than a tracker will ever need, and neither wants a client running anywhere.

**Google Drive, Dropbox, rsync, git** all go through the command hook, via `rclone` or the
tool's own client:

```bash
rclone copy "$BACKUP_FILE" gdrive:todont-backups/
rsync -a "$BACKUP_FILE" backup@nas:/vol/todont/
```

The tool has to exist inside the container, and by default only `tar`, `gzip` and `curl`
do — add it in your own image layer. The hook is off by default on purpose: administering
a board is not meant to be the same thing as having a shell on the server, and this makes
it so.

`COOKIE_SECRET` is **not** in the archive, because it is not in the database — it lives
in the environment file. Losing it signs everyone out, so keep a copy of it separately.

That exclusion is load-bearing rather than incidental. A federated sign-in leaves a
credential for that person's account on the other service in `sessions.auth_key`, and
those are encrypted (AES-256-GCM) under a key derived from `COOKIE_SECRET`. So an
archive that goes to the wrong mailbox or bucket is a copy of the board, not a set of
working logins — the key to open them was never in the tarball. A server that cannot
open one simply skips revalidation rather than failing.

`deploy/backup.sh` still exists for taking one from the host, outside the app, and needs
no admin account. It is redundant if you have the panel configured.

State that is not in git and must be backed up:

```
$STATE_DIR/data/tracker.db   the board
$STATE_DIR/data/uploads/     the screenshots
$STATE_DIR/tracker.env       COOKIE_SECRET; losing it signs everyone out
```
