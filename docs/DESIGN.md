# Ariadne design

**Summary:** Ariadne is a **graph** (tasks, people, teams, resources) with an **audit trail**. You keep
it up to date by directing **Claude Code** in an interactive session (over MCP), and browse or edit it
in a **graph view**. It's a task and org tracker: trusted external memory for the bigger picture and
what's next, so they survive interruptions and session changes.

---

## 1. History

| When | What | Why |
|---|---|---|
| v1 (`v1` branch) | Outcomes, tasks, plans, reviews... (~25 tables), pages and forms | Felt like data entry or a bug tracker |
| v2, 2026-10-01 | Graph + events (assign / report), an Analyst agent, cards, claims, RabbitMQ runners, System One dispatch | An interactive, AI-decision-oriented tool |
| 2026-10-02 | **Graph + audit only.** Removed the Analyst, events, cards, claims, timers, RabbitMQ, runners, agents, and System One | In practice the user just directed Claude Code in an interactive session, using Ariadne as a task and org tracker. The graph view was what earned its place |

Kept from v2: one task edge kind (`needs`), root tasks instead of Outcomes, inherited context, decision
lines, branch scopes, and undo.

## 2. Data model

| Table | Holds |
|---|---|
| `nodes` | `kind` = task / person / team / resource, plus `title`, `body` (markdown), `status` (tasks only: open / done / dropped), and `attrs` (checked per kind) |
| `edges` | `src -kind-> dst` with an optional `note` |
| `audit` | Every change, with who made it (`actor`: you for the UI, null for MCP) and how (`via`: `ui` / `mcp`). Grouped into changesets for Undo |

**Attrs per kind**

| Kind | Attrs |
|---|---|
| task | `guidance`: instructions for this task and everything it needs (inherited). Any other keys are allowed too (e.g. an agent's structured run state) and are not checked |
| person, team | `areas`: what they own or can help with |
| resource | `type` (repo / branch / build / doc / link / other), `url`; for a branch, `repo` and `branch` |

**Edge kinds**

| Kind | From → to | Meaning |
|---|---|---|
| `needs` | task → task | Must be done first (subtask or blocker). Acyclic |
| `uses` | task → resource | Repo, branch, Jenkins build, library docs, link |
| `involves` | task → person/team | Coordinate with them |
| `reports_to` | person/team → person/team | Supervisor. Acyclic |
| `member_of` | person/team → team | Acyclic |
| `waits_on` | task → person/team/resource | Blocked outside your control: a PR review, CI build, merge, or answer. Drawn yellow. To You: waiting on your own action, drawn violet |

**Computed, not stored:** whether a task is ready (open, everything it needs is closed, and no `waits_on`) and whether
it's a root (no task needs it). An open task's **state** says who can move it now: `ready` (anyone, an agent included;
green border), `yours` (it waits only on You; violet), `blocked` (it waits on another person, team, or resource;
yellow), or `waiting` (on open subtasks; dashed). MCP `graph` and `get_node` return it, so an agent picks `ready` work
and leaves `yours` to you. When `apply_ops` closes tasks, its answer lists the tasks that just
became ready (`nowReady`), so the next step is never silent.

**Waiting on someone:** an external blocker is a leaf task ("Waiting on review: <repo> PR #48") that
`waits_on` the reviewer, team, or build, and is needed by what it blocks. While open it's **blocked**
(yellow in the graph), not ready. Closing it unblocks its parents and reports them in `nowReady`; the
edge stays as history. Why a leaf and not an edge on the blocked task: closing a task keeps the history
and the `nowReady` signal, where deleting an edge would lose both.

**Waiting on you:** the same shape, pointed at You. When an agent finishes work that needs your action, it adds
a leaf "Review: <what>" (a branch to push, a PR to open, a draft to send) or "Decide: <question>" (including a
provisional decision to confirm) that `waits_on` You, with the exact command or draft in its body. Your queue is
`graph` from You, up, `waits_on`; in the graph view it's the violet tasks. Why You and not a new attr or status: the
edge already means "blocked until this one acts", the leaf keeps history and `nowReady`, and nothing new has to be
kept in sync.

**Inheritance:** a task's context includes the guidance, resources, and `involves` people of every
task that (transitively) needs it. Attach a repo to a root task once, and all its subtasks get it.

**Decisions** (yours or anyone's) are lines in the body of the task they shape:
`**Decision (Karl, 2026-10-02):** skip signing for now`. No table or node kind: the sidebar shows
them with the body, and MCP `search` with `decisions: true` finds only nodes that have them and returns
the lines. The MCP instructions tell Claude to record them this way.

**Branches are shared scopes:** a resource with `attrs.type` `branch` (plus `repo` and `branch`)
groups work that ships in one PR. Every task that uses it, and everything those tasks need, is in
its scope. `get_node` on a task lists each branch it ships on with every task in that scope.

**You** (`…0001`) is a person node created by the first migration. It can be edited but not deleted.

## 3. One change vocabulary

`create_node`, `update_node`, `delete_node`, `create_edge`, `update_edge`, `delete_edge`, applied
as a batch in one transaction (`ref` / `$ref` link new nodes). The web UI (`POST /api/ops`) and
Claude Code (`apply_ops` over MCP) use the same ops.

## 4. Runtime

```text
browser ──HTTP/SSE──► server (Fastify) ──► PostgreSQL
Claude Code ──MCP (/mcp)──►
```

- **MCP tools:** `get_node` (a node with its edges; for a task, readiness, inherited context, and
  branches), `search` (text, kind, status, `decisions`), `graph` (reachable subgraph, or roots and
  actors), `history`, `apply_ops`, `undo`. Stateless Streamable HTTP, no token: localhost only.
- **SSE:** browsers refetch on `changed`.
- **Undo:** `history` (grouped by changeset) and `undo` over MCP. An undo is refused if something
  changed again since. In the UI, a delete shows a short "Deleted … Undo" message (`/api/ops` returns
  its changeset; `POST /api/undo`). A fuller history view is still to be designed.

## 5. Screens

- **Graph** (the only screen): all nodes and edges with filters (kinds, hide closed) and **focus**: pick a node to see
  what's reachable from it (down / up / both, with a depth). A side panel creates, edits, and deletes
  nodes and edges.
- **Search:** the pickers (focus, add edge) match titles first, then body text, showing the matching
  line; decision lines are labelled, so typing "decision" lists them.
- **Focus:** the focus task in the top bar is remembered across reloads. While focused, a **Show all** button on
  the canvas returns to the full graph.
- **Order:** a control in the left sidebar sets how side-by-side nodes are ordered in the layout: ready first,
  oldest first, newest first, recently updated, or title. Changing it lays the graph out again; it is remembered.
  dagre may still move a node with children to avoid edge crossings; leaves always follow the order.

## 6. Federation

Two instances can share one subgraph. The rest of each graph stays local. A share has two members.
The instance that created a node is its home: it is the only one that commits an edit to that node.
The other member's edit is a proposal. A stale `version` fails the same check as a local edit, and
the sender stores the home's current copy. There is one share log, written by the home of the root,
not a merge of the two audit logs.

The shared view walks outgoing edges from the root (`needs`, `uses`, `involves`, `waits_on`,
`member_of`, `reports_to`). It does not walk inward, so a task that merely needs the root stays
private. `You` (the local user id) is never sent. An edge that touched `You` is published as an edge
to this instance's own person node. Deleting the edge that brought a node in drops that node from
the other member's copy.

Transport is WebSockets only, so a cloudflared tunnel can carry it. The public address is
`wss://<host>/p2p`. Fastify proxies that upgrade to the libp2p listener. TLS stops at Cloudflare;
the origin speaks plain WebSocket, and the libp2p session inside it stays encrypted. A peer on the
LAN dials `ws://<lan-ip>:<port>/p2p` instead. Set `ARIADNE_PUBLIC_URL` to the https origin and
`ARIADNE_LAN_URL` when this instance has no public address. A ping every 25 seconds keeps an idle
tunnel from closing the socket.

A third instance that can only dial out reaches its peer through the always-on instance, using
libp2p Circuit Relay v2. The relay cannot read that session. When the two are not online together,
the sender leaves a sealed frame in the relay's spool. The relay stores the blob and the peer ids,
and not the share id, titles, or bodies.

`ARIADNE_FEDERATION=off` disables this. `ARIADNE_RELAY` is `off`, `server` (the instance others
reserve on), or `client`. `ARIADNE_FEDERATION_LISTEN=off` means this instance dials out and does
not open a port. The HTTP UI and MCP stay on localhost. Federation authenticates with the peer key.
