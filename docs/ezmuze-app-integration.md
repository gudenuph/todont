# Reporting bugs from ezmuze studio to bugs.ezmuze.studio

Brief for whoever implements the app side. The tracker is live and all of this is
working today — nothing here is planned.

Everything below is **unauthenticated**. Do not put a token in the app: it ships to
everyone who can read the binary. None of these endpoints create a bug on their own — a
report only exists once a signed-in person submits it in the browser.

---

## 1. "Report a bug" — the simple case

Open the browser at:

```
https://bugs.ezmuze.studio/?raise=bug&version=2026.8.2&platform=Windows%20(desktop)
```

Recognised query parameters, all optional: `raise` (`bug` or `feature`), `title`,
`description`, `steps`, `severity`, `version`, `platform`, `stackTrace`.

Use this when there is no stack trace. **A stack trace must not go in the URL** — it will
blow the length limit and end up in every proxy log between the app and us.

## 2. A crash — post a draft first, then open the short URL

```http
POST https://bugs.ezmuze.studio/api/drafts
Content-Type: application/json

{
  "title":       "ezmuze could not start",
  "stackTrace":  "System.IO.DirectoryNotFoundException: ...",
  "appVersion":  "2026.8.2",
  "environment": "Windows (desktop)",
  "kind":        "bug"
}
```

```json
{ "id": "Df06lRssosI3",
  "url": "https://bugs.ezmuze.studio/?draft=Df06lRssosI3",
  "expiresInMinutes": 60 }
```

Open `url` in the default browser. That is the whole integration.

Other accepted fields: `description`, `steps`, `expected`, `actual`, `severity`.
Everything is optional and each is capped (title 200 chars, text fields 20 000).
Rate limited to 60 drafts per hour per IP. Drafts expire after an hour.

**Send the raw stack trace.** The server strips usernames, home directories, temp paths,
GUIDs and heap addresses before storing it, and generalises the version inside install
paths — so the same fault from different users and different releases is recognised as
one bug. Do not pre-clean it yourself; you will only make traces stop matching.

Traces are only readable by managers and admins once the ticket exists — the reporter
sees that theirs arrived, not its contents.

### What to send for `environment`

Use one of these exact strings so reports group properly:

```
Web — Chrome      Web — Edge      Web — Firefox      Web — Safari
Windows (desktop)      macOS (desktop)      Linux (desktop)      Other
```

(The em dash in the web entries is U+2014.) Any other string is accepted and kept, but
it will show as a one-off rather than joining the others.

### What to send for `appVersion`

The version string as published — `2026.8.2`. It is matched against the list the
publishing pipeline registers. `Unreleased` is a valid value for dev builds.

---

## 3. Optional: don't nag about a crash we already know

Before showing the user a "report this?" prompt, you can ask:

```http
POST https://bugs.ezmuze.studio/api/stack-traces/check
Authorization: Bearer <token with "write" scope>
Content-Type: application/json

{ "stackTrace": "..." }
```

- `{ "raised": true, "occurrences": 42, "bug": {...} }` — already known, and the counter
  on that ticket has just gone up. You could say "this is a known issue, already reported
  42 times" and skip the prompt.
- `{ "raised": false, "fingerprint": "..." }` — new, worth asking the user to report.

**This one does need a token**, because it writes a counter. If you would rather not ship
a credential, skip this step entirely: `POST /api/drafts` already tells the *browser*
when the crash is known, and the form warns the user before they write anything.

---

## What the user sees

- **Signed in** → the report form opens, already filled in, asking only what they were
  doing when it happened.
- **Not signed in** → they are asked to sign in with their ezmuze account first, told why,
  and dropped into the filled-in form afterwards. The prefill survives.
- **Crash already reported** → the form says so and links to the existing ticket.
  Submitting anyway counts against that ticket instead of opening a duplicate.

## Failure handling

Treat all of this as best-effort. If `POST /api/drafts` fails or times out, fall back to
opening the plain query-string URL, or just `https://bugs.ezmuze.studio/`. Never block
shutdown or a crash handler on it — fire it with a short timeout (2–3s) and move on.
