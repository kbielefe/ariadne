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

**Computed, not stored:** whether a task is ready (open, and everything it needs is closed) and whether
it's a root (no task needs it). When `apply_ops` closes tasks, its answer lists the tasks that just
became ready (`nowReady`), so the next step is never silent.

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
