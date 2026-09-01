# Giving Claude access to the board

Everything Claude needs to read the queue, pick work up, move it along and keep tickets
updated.

## Getting a token

**Admin → API tokens → New token.** Name it, choose what it may do, and press create. The
token is shown once and stored hashed; there is no way to read it back, so copy it then.

For working the board, the useful shape is:

| | |
|---|---|
| What is it for | `claude` |
| Show on the board as | `Claude` |
| Allowed to | Read, Raise and comment, Move/merge/assign/delete |
| Role | manager |

That is `read,write,manage` — enough to triage and update tickets, and deliberately not
enough to manage users, mint tokens or register a release. `manage` includes `move`, the
narrower scope a release pipeline gets, so there is nothing extra to tick here.

If the panel is unreachable, the CLI does the same thing:

```bash
docker exec todont-tracker node server/dist/cli.js   token "claude" --scopes read,write,manage --bot-name "Claude" --role manager
```

A token acts as a bot account, so everything it does is attributed on the board like
anyone else's work — comments say "Claude", moves appear in the activity trail — and
revoking it leaves that history intact.

**Do not commit the token.** Put it in the environment as `TODONT_TOKEN`, which is what
`.mcp.json` reads.

## Setup — in this repo

`.mcp.json` is already committed and points at the MCP server. Two things needed:

```bash
npm install
npm run build --workspace mcp     # mcp/dist is gitignored, so a fresh clone must build it
```

Then set two variables in the environment Claude Code runs in; `.mcp.json` expands both:

| | |
|---|---|
| `TODONT_TOKEN` | the token you just minted |
| `TRACKER_URL` | the board's address — **defaults to `http://127.0.0.1:4310`**, so set it if the board is not the one you are running locally |

On Windows, `setx TODONT_TOKEN ezb_...` then `setx TRACKER_URL https://bugs.example.com`,
and restart the terminal.

## Setup — anywhere else

The MCP server is a standalone stdio process with no dependency on this repo's checkout
beyond its own build:

```json
{
  "mcpServers": {
    "bugs": {
      "command": "node",
      "args": ["/path/to/ToDontTracker/mcp/dist/index.js"],
      "env": {
        "TRACKER_URL": "https://bugs.example.com",
        "TRACKER_TOKEN": "ezb_..."
      }
    }
  }
}
```

## Without MCP

Every tool is a thin wrapper over the REST API, so `curl` works just as well:

```bash
curl -s "$TRACKER_URL/api/bugs" \
  -H "Authorization: Bearer $TODONT_TOKEN"
```

The full endpoint list is in the main README.

## The tools

| | |
|---|---|
| `list_columns` | the board's columns, the ticket kinds, each kind's scale and wording |
| `list_bugs` | filter by `status`, `kind`, `q`, `assigneeId` |
| `get_bug` | one ticket: description, steps, attachments, comments, activity, duplicates |
| `create_bug` | raise one |
| `update_bug` | rewrite any descriptive field, severity, or retype it |
| `move_bug` | to another column, optionally at an index |
| `merge_bugs` / `unmerge_bug` | mark a duplicate, or split it back out |
| `assign_bug` | set or clear the assignee |
| `block_bug` / `unblock_bug` | "this cannot start until that is done"; loops are refused |
| `comment_bug` | add to the thread, with images by path if you have any |
| `delete_bug` / `delete_comment` / `delete_attachment` | permanent, no undo |

**Images on a comment.** `comment_bug` takes an `images` array of paths to files on the
machine Claude is running on, and posts them with the comment in one call:

```
comment_bug(id: 42, body: "Before and after the fix:", images: ["/tmp/before.png", "/tmp/after.png"])
```

An image on its own is a valid comment — `body` may be empty. PNG, JPEG, GIF, WebP,
WebM and MP4 only, and the **file's bytes** are checked rather than its name, so
something merely called `.png` is refused instead of being uploaded and served as an
image. Every file is read and checked before any of it is sent, so one bad path in the
list leaves nothing on the board.

The board is world-readable. Do not attach anything that should not be.
| `list_versions` | the versions reporters can pick |
| `list_columns` | also returns the ticket types and each one's scale, which an instance can change |
| `list_assignable` | who a ticket can be assigned to |

## What this token cannot do

It is a manager, not an admin. It **cannot** list or promote users, mint or revoke
tokens, or register a release version. Those need an admin credential and are yours.

If Claude ever needs them, change `--role manager` to `--role admin` and add `admin`
and/or `versions` to `--scopes` when minting.

## Working the board

The columns, left to right, are `unconfirmed`, `confirmed`, `backlog`, `current-focus`,
`in-progress`, `in-beta-testing`, `shipped`, `on-hold`, `rejected`.

Reasonable conventions, not enforced by anything:

- Move a ticket to `current-focus` when starting it and assign it to Claude, so it is
  visible that something is being worked on rather than silently changing under you.
- When the work is done and merged, comment with what was actually done and move it to
  `in-progress` — which the board shows as **In release queue**, and which means exactly
  that: finished, waiting for a build to carry it out.
- **Do not move anything to `in-beta-testing` or `shipped` by hand.** The release
  pipeline empties the release queue into beta when a beta deploys, and beta into
  shipped when a release goes live. Those columns are a record of what a build actually
  did, and putting a ticket there before the build has run makes them lie.

  This is why work in progress belongs in `current-focus` and not in the release queue:
  a beta deploys on every push, and anything sitting in that lane goes out with it.
- `unconfirmed` is where reporters land. Confirming a bug means reproducing it; do not
  move things out of `unconfirmed` on a guess.
- Prefer `rejected` over `delete_bug`. Deletion is for spam and mistakes, and it takes
  the comments and attachments with it.
- A bug with a rising `occurrences` count is being hit repeatedly by real users, which is
  a stronger priority signal than its severity.
- Check `blockedBy` before picking work up. A blocked ticket is not ready, however
  urgent it looks, and moving it to `current-focus` only hides that.

Stack traces are visible to this token because it is a manager. They are not visible to
reporters or to the public, so do not paste one into a comment.

---

## Blocking: "this cannot start until that is done"

### Getting the direction right

This is the one thing that is easy to get backwards. The **first** argument is the ticket
that has to wait:

```
block_bug({ id: 42, blockerId: 7 })     # 42 waits on 7.  7 must be finished first.
```

Read it as **"block #42, on #7"** — not "#42 blocks #7". If you find yourself saying
"this blocks that", you almost certainly want the arguments the other way round.

`unblock_bug` takes the same pair and drops the link. Either ticket can be named first
when you *talk* about it, but the call is always `(waiter, waited-on)`.

### Reading it

`get_bug` returns both directions:

- `blockedBy` — tickets this one is waiting on. **Non-empty means not ready to start.**
- `blocking` — tickets waiting on this one. Finishing it releases them.

`list_bugs` returns the same two as plain id arrays on every card, so a single call tells
you what the whole board is waiting on.

### Using it when picking work up

- **Check `blockedBy` before starting anything.** A blocked ticket is not ready however
  urgent it looks, and moving it to `current-focus` only hides that from everyone else.
- **A ticket with a long `blocking` list is worth more than its own severity suggests** —
  finishing it releases everything downstream. That is usually a better thing to pick up
  than a slightly worse bug that unblocks nothing.
- **When you finish something, look at its `blocking` list** and say so in a comment on
  each ticket it releases. Nobody gets notified otherwise.
- **Remove a blocker as soon as it stops being true.** A stale block is worse than none:
  it parks work that could have proceeded.

### When to use it, and when not to

Use it for a real ordering constraint — the second piece of work genuinely cannot be done,
or cannot be verified, until the first is finished.

Do **not** use it for:

- **Duplicates.** That is `merge_bugs`, which folds one ticket into another and counts
  the reports. Blocking leaves two tickets alive forever.
- **"Related to".** There is no such link, and blocking is not a stand-in — it changes
  what shows as ready to work on.
- **"Would be easier after".** Preference is not a constraint. If the work *can* be done
  now, leave it unblocked and let priority decide the order.
- **Waiting on a person or a decision.** Move it to `on-hold` and comment why. Blocking is
  ticket-to-ticket.

### What the server refuses

- A ticket blocking itself.
- The same edge twice.
- **Any loop, however long the chain.** If #4 already waits on #1 through other tickets,
  #1 cannot be made to wait on #4 — neither could ever become unblocked. The error names
  the conflict; do not try to route around it, it means the dependency is modelled wrong.

Deleting a ticket removes its links automatically, so a `blockedBy` list never points at
something that no longer exists.

### What people see

A blocked card says `blocked` on the board and its severity strip goes dashed. Hovering it
dims every card that is not holding it up. So a blocker you add is immediately visible to
everyone — worth a comment saying *why*, since the link itself carries no reason.
