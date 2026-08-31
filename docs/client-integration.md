# Reporting bugs from your app

How a desktop or mobile application hands a bug report to a ToDont board, filling in
what it already knows so the person only has to describe what they were doing.

Replace `https://bugs.example.com` with your instance throughout.

Everything here is **unauthenticated — your app needs no token, ever.** Do not embed one:
a credential shipped in an application is a credential shipped to everyone who can read
the binary.

That is safe because none of these endpoints let the caller choose what gets written. A
draft is inert text that only becomes a ticket when a signed-in person submits it in the
browser; the crash check names no ticket and sets no content — it hands over a trace and
the server decides, from a hash, whether an existing counter moves by one.

---

## 1. "Report a bug" — the simple case

Open the user's browser at:

```
https://bugs.example.com/?raise=bug&version=2.4.1&platform=Windows%20(desktop)
```

Recognised query parameters, all optional: `raise` (a ticket type key — `bug` and
`feature` by default), `title`, `description`, `steps`, `severity`, `version`, `platform`,
`stackTrace`.

Use this when there is no stack trace. **A stack trace must not go in the URL** — it will
blow the length limit and end up in every proxy log between your app and the server.

## 2. A crash — post a draft, then open the short URL

```http
POST https://bugs.example.com/api/drafts
Content-Type: application/json

{
  "title":       "Could not start",
  "stackTrace":  "System.IO.DirectoryNotFoundException: ...",
  "appVersion":  "2.4.1",
  "environment": "Windows (desktop)",
  "kind":        "bug"
}
```

```json
{ "id": "Df06lRssosI3",
  "url": "https://bugs.example.com/?draft=Df06lRssosI3",
  "expiresInMinutes": 60 }
```

Open `url` in the default browser. That is the whole integration.

Other accepted fields: `description`, `steps`, `expected`, `actual`, `severity`.
Everything is optional and each is capped (title 200 characters, text fields 20 000).
Rate limited to 60 drafts per hour per IP. Drafts expire after an hour.

**Send the raw stack trace.** The server strips usernames, home directories, temp paths,
GUIDs and heap addresses before storing it, and generalises version numbers inside
install paths — so the same fault from different users on different releases is
recognised as one ticket. It also folds path separators and .NET runtime identifiers
together, so one fault in shared code is one ticket across Windows, macOS and Linux
rather than three. **Do not pre-clean it yourself**; you will only stop traces matching.

Traces are readable only by managers and admins once the ticket exists — the reporter
sees that theirs arrived, not its contents.

### What to send for `environment`

Whatever the instance offers. `GET /api/meta` returns the list under `environments`;
sending an exact match is what makes reports group together. A default install has:

```
Web — Chrome      Web — Edge      Web — Firefox      Web — Safari
Windows (desktop)      macOS (desktop)      Linux (desktop)      Other
```

(The em dash is U+2014.) Any other string is accepted and kept, but shows as a one-off.

### What to send for `appVersion`

The version as published — `2.4.1`. It is matched against whatever the release pipeline
has registered (see below). `Unreleased` is always valid, for development builds.

---

## 3. Optional: don't nag about a crash you already know

Before showing the user a "report this?" prompt:

```http
POST https://bugs.example.com/api/stack-traces/check
Content-Type: application/json

{ "stackTrace": "..." }
```

- `{ "raised": true, "occurrences": 42, "bug": {...} }` — already known, and the counter
  on that ticket has just gone up. Say "this is a known issue" and skip the prompt, or
  offer a "report it anyway" button.
- `{ "raised": false, "fingerprint": "..." }` — new, worth asking the user to report.

**No token needed here either.** Calling it counts the crash, so it is worth calling on
every crash even when you do not prompt: that is how the board learns which faults are
actually common. Rate limited to 120 per hour per IP.

---

## 4. Telling the tracker about a release

So reporters pick their build from a list instead of typing it. This one **does** need a
token, because it writes something a caller chooses — but it belongs in your release
pipeline, not in the shipped application:

```bash
curl -sf -X POST https://bugs.example.com/api/versions \
  -H "Authorization: Bearer $TRACKER_VERSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"2.4.1"}'
```

Idempotent on `name`, so a pipeline that re-runs is fine. Mint the token with the
`versions` scope only — it can then do nothing else:

```bash
docker exec todont-tracker node server/dist/cli.js \
  token "release-pipeline" --scopes read,versions --bot-name "Releases" --role manager
```

---

## What the user sees

- **Signed in** → the report form opens, already filled in, asking only what they were
  doing when it happened.
- **Not signed in** → they are asked to sign in first, told why, and dropped into the
  filled-in form afterwards. The prefill survives.
- **Crash already reported** → the form says so and links to the existing ticket.
  Submitting anyway counts against that ticket instead of opening a duplicate.

## Failure handling

Treat all of this as best-effort. If `POST /api/drafts` fails or times out, fall back to
opening the plain query-string URL, or just the site root. **Never block shutdown or a
crash handler on it** — fire it with a short timeout (2–3 seconds) and move on.
