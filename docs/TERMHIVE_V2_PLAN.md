# Termhive v2 — Planning Document

> Status: planning · Last updated: 2026-05
> v1 = "tmux for coding agents" (dashboard). v2 = "the control plane for your coding agent team".

---

## 1. Vision & Positioning

```
v1:  A dashboard to watch multiple coding agents.
v2:  A command center — you give one brain plain-language orders, it dispatches
     to your project teams, collects the work, and proactively tells you when
     something needs you.
```

Pitch:

> **Termhive v2 — JARVIS for your coding agent team.**
> Command one brain in plain language. It dispatches to your project teams,
> collects the work, and proactively surfaces what needs you.

Still **human-driven**: you give the order, you see every step, you make the
final call. The orchestrator is a chief-of-staff, not an unsupervised swarm.

---

## 2. Competitive Survey (early 2026)

| Tool | Mode | Orchestration | Runtime | Scale |
|------|------|--------------|---------|-------|
| OpenHands | multi | hierarchical delegation | daemon/sandbox | 70k★ |
| Aider | single | none | CLI | 42k★ |
| Paperclip | multi | company sim | self-host | 38k★ |
| Claude Flow (ruflo) | swarm | **"Queen" hierarchy** | framework | 31k★ |
| Multica | multi | task board (task runner) | **daemon** | 9.1k★ |
| Claude Squad | multi | manual | **tmux** | 7k★ |
| Conductor | multi | manual + diff review | Mac app + worktree | closed, $22M |
| Vibe Kanban | multi | drag cards | worktree + dashboard | free |
| **Termhive (v1)** | multi | **manual** | **PTY tied to web server** | — |

### Three findings

1. **The "central brain" concept has precedent — but Termhive's exact niche is open.**
   Claude Flow already uses "Queen" (so that name is taken). Claude Code's
   native Agent Teams has a "team lead" but it is an ephemeral, per-task
   session, not a standing brain. **Nobody combines**: a persistent
   conversational brain + long-lived, human-organized, named project teams +
   proactive surfacing of stuck agents.

2. **The delegation mechanism is mature.** LangGraph / CrewAI / AutoGen all use
   the supervisor pattern: a brain with a `delegate_to(agent, task)` tool that
   decides who to route to, collects results, and synthesizes. Termhive's
   orchestrator copies this — proven, not novel risk.

3. **"JARVIS for coding" positioning is unclaimed.** No shipped product owns it.
   Proactive monitoring ("your orchestrator pings you when agent X is stuck") is
   the strongest unclaimed differentiator.

---

## 3. Billing Reality — the June 15 2026 constraint (CRITICAL)

This rewrites the optimal architecture. **Read before designing anything.**

### Claude `-p` / Agent SDK — moves to metered billing

| | |
|--|--|
| Announced | 2026-05-14 |
| Effective | **2026-06-15** |
| Affected | `claude -p` (headless), Claude Agent SDK, Claude Code GitHub Actions, 3rd-party agent apps |
| Billing | Removed from subscription pool → new **"Agent SDK Credit pool"**, charged at **full API rates**, no rollover |
| Free monthly credit | Pro $20 / Max 5x $100 / Max 20x $200 |
| **NOT affected** (still subscription) | Interactive `claude` terminal TUI, Claude.ai chat, Claude Cowork |

Real workload: ~one PR review per push × 4 pushes/day ≈ **$25/mo** at Sonnet 4.6
rates — burns the $20 Pro credit in three weeks, then full API price.

### Codex `codex exec` — still subscription-covered

| | |
|--|--|
| ChatGPT auth mode (default) | `codex exec` / non-interactive / scripted use → **draws from plan limits, no extra charge** |
| API-key mode | per-token billed |
| Covered plans | ChatGPT Plus / Pro / Business / Edu / Enterprise |

### What this means for v2

| Use | Pre Jun 15 | Post Jun 15 (v2 strategy) |
|-----|-----------|--------------------------|
| Orchestrator brain itself | Claude `-p` or Codex | **Default Codex** (programmatic free); Claude allowed via PTY |
| `ask_agent` → a Claude agent | `claude -p --resume` | **PTY injection** (interactive = subscription-covered) |
| `ask_agent` → a Codex agent | `codex exec` | `codex exec` / app-server (still free) |
| Raw headless `claude -p` | use freely | **use sparingly** — drains Agent SDK credit; UI must show cost |

**Key inversion:** PTY injection for Claude went from "fallback" to "the correct
default" — a Claude process running in a PTY is *interactive mode* even when
Termhive injects the input programmatically, so it stays subscription-covered.
This also makes precise status detection (§6) a hard prerequisite, because we
need it to know when an injected Claude turn has finished.

**Division of labor:** Claude = human-driven interactive work (its strength,
and interactive billing is free). Codex = the programmatic engine (orchestrator
brain + background tasks; programmatic use is free).

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────┐
│  Web UI (React)            ← restart freely, thin client │
│  + new Command conversation panel                     │
└────────────────────┬─────────────────────────────────┘
                     │ local socket / WS
┌────────────────────▼─────────────────────────────────┐
│  termhive-daemon  ★ v2 core — long-lived process       │
│                                                       │
│  ┌─────────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │ Orchestrator    │ │ Agent Runtime│ │ Watchdog  │ │
│  │ ("the brain")   │ │              │ │ proactive │ │
│  │ - persistent    │ │ Claude→PTY   │ │ monitor   │ │
│  │   session       │ │ Codex→app-srv│ │           │ │
│  │ - delegate tools│ │              │ │           │ │
│  └─────────────────┘ └──────────────┘ └───────────┘ │
│  ┌──────────────────────────────────────────────────┐│
│  │ Status Engine — hooks + JSONL tailing            ││
│  └──────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────┘
```

### Why a daemon is the foundation

| v1 pain | daemon fix |
|---------|-----------|
| web server restart kills agents | agents live in the daemon — web restart is transparent |
| Windows window-close orphans processes | daemon is independent + long-lived |
| port 3200 stuck | daemon owns the port with a proper shutdown path |
| `npm run dev` rebuild kills agents | web and agents are decoupled |

The daemon is also the home of the orchestrator and watchdog — one architecture,
three wins.

### Runtime per CLI

- **Claude agents** → PTY owned by the daemon (interactive, typeable, free).
  Status comes from hooks + JSONL tailing.
- **Codex agents** → `codex app-server` (JSON-RPC 2.0, one process / many
  threads, structured events, restart-resumable). Native structured status.
- Web UI is a thin client over a local socket / WebSocket to the daemon.

**This is not a rewrite.** PTY logic is largely reused — it just "moves house"
into the daemon. The Hive Dashboard redesign, MCP messaging, wiki, shared
content all carry over.

---

## 5. The Orchestrator ("the brain")

A long-lived agent inside the daemon, with its own session/memory, loaded with
a **Hive Orchestrator MCP** toolset:

| Tool | Purpose |
|------|---------|
| `list_projects()` / `list_agents(project)` | know the teams |
| `get_project_overview(project)` | read the project wiki to know what it does |
| `ask_agent(project, agent, msg)` | **core** — dispatch, await reply, return |
| `broadcast(msg, filter)` | ask many agents at once |
| `get_agent_status(project, agent)` | check status |
| `read_wiki / read_shared` | read knowledge bases |

### 5.1 Brain selection — Claude ⇄ Codex toggle

A first-class setting: **which CLI powers the orchestrator brain**.

```
Settings → Orchestrator
  Brain engine:   ( ) Claude      (•) Codex   [default — recommended]
```

| | **Codex brain** (default) | **Claude brain** (option) |
|--|--------------------------|--------------------------|
| Runtime | `codex app-server` — persistent, multi-thread, structured | PTY-hosted interactive `claude`; Termhive injects prompts, reads replies via hooks/JSONL |
| Cost | **Subscription-covered** (programmatic Codex is free) | Subscription-covered *if* run interactively in PTY |
| Structured events | Native (JSON-RPC) | Derived from hooks + JSONL tailing |
| Multi-turn / resume | Native threads, restart-resumable | Session resume via `-c` / `--resume` |
| Best when | Default — cheapest + cleanest for programmatic orchestration | User prefers Claude's planning/reasoning style |

Rules for the toggle:

- **Default = Codex.** After 2026-06-15 it is the only brain whose programmatic
  use is fully subscription-covered, and `codex app-server` gives structured
  events for free.
- **Claude brain runs in a daemon-owned PTY** (interactive mode) so it stays
  subscription-covered. Termhive drives it by injecting prompts and detecting
  turn completion via the Status Engine (§6).
- An advanced sub-option may allow the Claude brain to run headless via
  `claude -p` — but the UI must show a **cost warning** ("draws from Agent SDK
  credit, billed at API rates after Jun 15") and surface per-command spend.
- The toggle is also exposed per-instance, so a user on a Claude-heavy plan or a
  ChatGPT-heavy plan can pick whichever subscription they already pay for.

### 5.2 `ask_agent` dispatch mechanics

When the brain calls `ask_agent("DexlessAI", "Backend", "progress?")`:

- **Target is a Claude agent** → inject the prompt into its daemon-owned PTY
  (the existing `message_agent` mechanism), then use the Status Engine to detect
  the turn finished and extract the reply. Subscription-covered.
- **Target is a Codex agent** → `codex exec --json` resuming its thread, or an
  app-server `turn/start`. Subscription-covered.
- Reply flows back to the brain → it synthesizes → reports to the user.
- Avoid raw `claude -p` for dispatch — it would meter the Agent SDK credit.

### 5.3 Example

```
You:    DexlessAI backend progress?
Brain:  ⏺ list_agents("DexlessAI") → Backend (codex), Frontend, QA
        ⏺ ask_agent("DexlessAI","Backend","current progress?")

        DexlessAI backend:
        • /api/orders done, tests pass
        • WebSocket push expected done today
        • Blocked on a migration race condition — needs you to pick lock vs queue

        Want me to have Backend do something else meanwhile, or decide now?
```

### 5.4 Safety valve (keeps it human-driven)

- **Read** (progress / status / inspect code) → allowed freely.
- **Write** (have an agent change code / deploy) → plan-approve: the brain first
  states "I plan to have A do X and B do Y", you confirm, then it executes.
- All brain actions go to an **audit log**.

---

## 6. Status Engine — precise agent status

On agent start, inject a per-agent hook config (`claude --settings <path>`).
Each hook posts to a daemon endpoint:

```
running / thinking / awaiting_input / awaiting_permission / idle / error / stopped
```

- Claude: hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`,
  `Stop`, `SessionEnd`) + JSONL tailing for the "streaming" sub-state.
- Codex: native app-server turn lifecycle events.
- Floor: process-alive = at least `running`, process-gone = `stopped`.

UI surfaces: sidebar status dots, pane-header chips, status-bar counts, browser
tab title. **Solves "which of my 5 agents is waiting for me".** Also a hard
prerequisite for §5.2 — detecting when an injected Claude turn has finished.

---

## 7. Watchdog — proactive monitoring (top differentiator)

The least-shipped capability in the market. The watchdog continuously reads the
Status Engine + activity feed and proactively pushes:

- "Backend has been awaiting your input for 8 minutes"
- "QA produced 3 failing tests"
- "Frontend has been idle 2 hours — stuck, or done?"
- Daily briefing: "what the hive shipped yesterday"

Delivery: in-UI notifications + browser notifications + (future) Telegram.

---

## 8. Roadmap

| Version | Scope | Status |
|---------|-------|--------|
| **v2.0 Daemonize** | Standalone `termhive-daemon` owns PTYs; web is a client | ✅ done + tested |
| **v2.1 Precise status** | Claude lifecycle hooks → running/awaiting_input/idle/stopped | ✅ done + tested |
| **v2.2 Codex precise status** | Codex hooks → same status engine (see §8.1) | deferred — secondary CLI |
| **v2.3 Orchestrator** | Hive Orchestrator MCP + brain agent + Claude/Codex brain toggle + Command panel | **next — the JARVIS core** |
| **v2.4 Watchdog** | Proactive monitoring + notifications + daily briefing | after v2.3 |
| **v2.5 Action + safety** | Brain can dispatch write-actions + plan-approve + audit | after v2.4 |

Each version ships independently. v2.0 + v2.1 are live on `feat/v2`.

### 8.1 v2.2 Codex status — design note

v2.1's Claude approach (per-agent `claude --settings <path>`) does **not** map
to Codex: Codex hooks are discovered only by directory (`~/.codex/hooks.json`
or `<repo>/.codex/hooks.json`) — there is no CLI flag, `-c` override, or env
var to point at a per-agent hook file.

Chosen approach (per user): a **single global `~/.codex/hooks.json`** is
acceptable. Make it per-agent by resolution rather than by config:

1. Daemon writes/merges global `~/.codex/hooks.json` once. Each hook posts its
   stdin JSON (which includes `session_id` and `cwd`) to the daemon.
2. When the daemon spawns a Codex agent it reads the newest rollout file under
   `~/.codex/sessions/` to learn that agent's `session_id`, and binds
   `session_id ↔ agentId`.
3. Incoming Codex hooks carry `session_id` → daemon routes status to the right
   agent. cwd is a fallback match.

This keeps Codex on a real typeable PTY (manual operation preserved) and reuses
the v2.1 status engine. Deferred because Codex is the secondary CLI and Claude
status already works.

### 8.2 v2.3 — implementation starting points

Build on what exists on `feat/v2`:

- **Daemon** (`src/daemon/daemon.ts`) — host the brain here; it is long-lived.
- **DaemonClient** (`src/daemon/client.ts`) — extend the protocol with brain ops.
- **Status engine** (daemon) — `ask_agent` to a Claude agent = PTY-inject the
  prompt (existing `injectMessage`) then watch the status engine for the
  agent returning to `awaiting_input` = turn done; then read the reply from
  the agent's session JSONL tail.
- **MCP server pattern** — `src/mcp-server.ts` already shows how to build one
  (`message_agent`, `list_teammates`). The Hive Orchestrator MCP is the same
  shape with org-level tools (§5).
- **Brain runtime** — Codex default: `codex exec --json` resuming the brain's
  own thread (programmatic Codex is subscription-covered — see §3). Claude
  option: a daemon-owned PTY.
- **UI** — a new Command panel; `⌘J` to open. The Messages panel
  (`MessagesPanel.tsx`) is a reference for a chat-style panel.

---

## 9. Keep / Change / Add

| Keep unchanged | Change | Add |
|----------------|--------|-----|
| PTY interactive terminals (manual operation) | PTY moves from Express into the daemon | `termhive-daemon` process |
| 5 layouts / Canvas / Grid | Codex runtime → `codex app-server` | Orchestrator brain + brain toggle |
| Wiki / Shared Content | status enum extended | Hive Orchestrator MCP |
| MCP agent messaging | — | Watchdog |
| Existing UI visual system | — | Command conversation panel |
| Agent / Project data model | — | hook injection mechanism + Status Engine |

Not a rewrite — existing parts move into a sturdier architecture, with the brain
layered on top.

---

## 10. Naming

"Queen" is taken by Claude Flow — do not use it.

| Candidate | Feel |
|-----------|------|
| **The Keeper** / Hive Keeper | beekeeper directing the hive — on-brand |
| Steward | chief-of-staff, professional |
| **Hive Command** (feature name) | most direct as a UI label |
| Foreman | plain, blunt |

Recommendation: feature = **"Command"** (UI button, `⌘J`); the brain itself =
**"The Keeper"**. Market it as **"JARVIS for your coding agent team"** (JARVIS is
a Marvel trademark — use only as a descriptor, never as the product name).

---

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| Claude hook schema changes | stable 1+ yr; keep process-alive as fallback |
| Daemon autostart on Windows | Windows Service / Task Scheduler, or a tray app |
| `claude -p` metered cost (post Jun 15) | default brain = Codex; `--max-budget-usd` caps; show spend in UI |
| Concurrent session-append conflicts | interactive agents → PTY injection; only idle agents use headless |
| Brain drifting too autonomous | plan-approve gate + audit log keep it human-driven |
| 6-7 weeks is a lot | each version ships independently; v2.0+v2.1 land value in 2 weeks |

---

## One-line summary

**v2 = a solid daemon foundation + precise status + a brain you can talk to
(Codex by default, Claude optional) + a watchdog that proactively reports.**
From "a dashboard that shows agents" to "a command center that directs an agent
team" — still 100% human-driven, and a market niche nobody else occupies.
