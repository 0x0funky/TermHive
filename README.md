# Termhive

A web-based management platform for coding CLI agents (Claude Code, Codex CLI, Gemini CLI). Think of it as **tmux for coding agents** with a web UI, project organization, and shared content.

![Termhive Demo](demo_page.png)

## Why

When running multiple coding agents simultaneously across different projects:
- Too many terminal windows, can't find which is which
- No easy way to share context between agents
- No overview of what each agent is working on
- Can't manage agents from mobile/remote

Termhive solves this with a browser-based dashboard.

## Features

- **Multi-vendor** — Claude Code, Codex CLI, Gemini CLI in one UI
- **Project organization** — Group agents by project, each with its own config
- **Terminal streaming** — Real xterm.js terminals with live PTY via WebSocket
- **Split view** — Tmux-like recursive splitting with draggable dividers, per-project persistent layouts
- **Shared content** — Centralized file store (`~/.termhive/shared_content/[project]/`) with auto `--add-dir` / `--include-directories` for all supported CLIs
- **Auto CLAUDE.md** — Automatically generates CLAUDE.md in each agent's working directory with shared content instructions
- **Activity feed** — Real-time file watcher on shared content + agent lifecycle events
- **Agent flags** — `--dangerously-skip-permissions`, `--remote-control` for Claude Code
- **Start/Stop All** — Batch control per project
- **Lightweight** — JSON file storage, no database needed

## Quick Start

```bash
git clone https://github.com/0x0funky/TermHive.git
cd termhive
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

### Prerequisites

- Node.js 20+
- `node-pty` requires native build tools:
  - **Windows**: `npm install -g windows-build-tools` or install Visual Studio Build Tools
  - **macOS**: `xcode-select --install`
  - **Linux**: `sudo apt install build-essential`

### Production

```bash
npm run build
npm start
```

Server runs on `http://localhost:3200` (serves both API and frontend).

## Architecture

```
┌─────────────────────────────────────────────┐
│              Web UI (React)                  │
│  ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │ Project  │ │ Agent   │ │   Shared     │  │
│  │ Sidebar  │ │Terminals│ │  Content     │  │
│  └─────────┘ └─────────┘ └──────────────┘  │
└──────────────────┬──────────────────────────┘
                   │ REST + WebSocket
┌──────────────────▼──────────────────────────┐
│           Express Server (:3200)             │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ PTY Mgr  │ │ Content  │ │  Activity   │ │
│  │(terminals)│ │  Store   │ │   Feed      │ │
│  └──────────┘ └──────────┘ └─────────────┘ │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express, TypeScript |
| Frontend | React, Vite, xterm.js |
| PTY | node-pty |
| Communication | WebSocket (terminal I/O) + REST (CRUD) |
| File watching | chokidar |
| Storage | JSON files (`~/.termhive/`) |
| Build | tsup (backend) + Vite (frontend) |

## Shared Content

Shared content files are stored centrally in `~/.termhive/shared_content/[project-name]/`. When an agent starts, the shared directory is automatically passed to the CLI:

| CLI | Flag |
|-----|------|
| Claude Code | `--add-dir` |
| Codex CLI | `--add-dir` |
| Gemini CLI | `--include-directories` |

For Claude Code agents, a `CLAUDE.md` is also auto-generated in the agent's working directory with shared content instructions.

All agents can read/write shared files, and the Termhive web UI reflects changes in real-time via file watching.

## Data Storage

```
~/.termhive/
├── projects/
│   └── <project-id>/
│       └── project.json        # Project metadata + agents
└── shared_content/
    └── <project-name>/         # Shared files (real markdown)
        ├── README.md
        ├── api-spec.md
        └── ...
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (backend + frontend with HMR) |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run dev:server` | Backend only (watch mode) |
| `npm run dev:client` | Frontend only (Vite dev server) |

## License

MIT
