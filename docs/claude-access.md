# Giving Claude access to the board

Everything Claude needs to read the queue at https://bugs.ezmuze.studio, pick work up,
move it along and keep tickets updated.

## The credential

```
TODONT_TOKEN=ezb_your_token_here
```

It acts as the user **Claude** (a bot account, role `manager`), so everything it does is
attributed on the board like anyone else's work — comments say "Claude", moves show up in
the activity trail.

Stored hashed server-side, so this file is the only copy. To replace it:

```bash
ssh root@your-host 'docker exec todont-tracker node server/dist/cli.js tokens'
ssh root@your-host 'docker exec todont-tracker node server/dist/cli.js revoke <id>'
ssh root@your-host 'docker exec todont-tracker node server/dist/cli.js \
  token "claude" --scopes read,write,manage --bot-name "Claude" --role manager'
```

## Setup — in this repo

`.mcp.json` is already committed and points at the MCP server. Two things needed:

```bash
npm install
npm run build --workspace mcp     # mcp/dist is gitignored, so a fresh clone must build it
```

Then set `TODONT_TOKEN` in the environment Claude Code runs in — `.mcp.json` expands it.
On Windows, `setx TODONT_TOKEN ezb_...` and restart the terminal.

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
        "TRACKER_URL": "https://bugs.ezmuze.studio",
        "TRACKER_TOKEN": "ezb_..."
      }
    }
  }
}
```

## Without MCP

Every tool is a thin wrapper over the REST API, so `curl` works just as well:

```bash
curl -s https://bugs.ezmuze.studio/api/bugs \
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
| `comment_bug` | add to the thread |
| `delete_bug` / `delete_comment` / `delete_attachment` | permanent, no undo |
| `list_versions` | the versions reporters can pick |
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

- Move a ticket to `in-progress` when starting it and assign it to Claude, so it is
  visible that something is being worked on rather than silently changing under you.
- Comment on the ticket with what was actually done, and move it to `in-beta-testing`
  rather than `shipped` — shipping is a human call.
- `unconfirmed` is where reporters land. Confirming a bug means reproducing it; do not
  move things out of `unconfirmed` on a guess.
- Prefer `rejected` over `delete_bug`. Deletion is for spam and mistakes, and it takes
  the comments and attachments with it.
- A bug with a rising `occurrences` count is being hit repeatedly by real users, which is
  a stronger priority signal than its severity.
- Check `blockedBy` before picking work up. A blocked ticket is not ready, however
  urgent it looks, and moving it to `in-progress` only hides that.

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
  urgent it looks, and moving it to `in-progress` only hides that from everyone else.
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
