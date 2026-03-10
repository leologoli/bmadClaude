# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BMAD Claude is an Electron-based desktop application that implements an AI-driven agile development workflow. The app orchestrates a structured development process through distinct roles (intake → brainstorm → analyst → pm → ux-designer → architect → developer → qa → done), with integrated terminal support and multi-AI model coordination.

## Tech Stack

- **Framework**: Electron 33+ with React 18
- **Build System**: electron-vite + Vite 5
- **Package Manager**: pnpm 9.12+ (monorepo with workspaces)
- **Language**: TypeScript 5.7+
- **State Management**: XState 5.28+ (workflow engine)
- **Styling**: Tailwind CSS 4.0
- **Terminal**: xterm.js + node-pty

## Development Commands

```bash
# Install dependencies (from root)
pnpm install

# Development mode (hot reload)
pnpm dev

# Build all packages
pnpm build

# Type checking across all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Package for distribution
cd apps/desktop
pnpm package:mac    # macOS (arm64 + x64)
pnpm package:win    # Windows
pnpm package:linux  # Linux (AppImage + deb)
```

## Architecture

### Monorepo Structure

```
bmad-claude/
├── apps/
│   └── desktop/          # Main Electron app
│       ├── electron/     # Main process (main.ts, preload.ts)
│       └── src/          # Renderer process (React app)
└── packages/
    ├── workflow-engine/  # XState workflow state machine
    ├── ipc-contracts/    # IPC type definitions & constants
    ├── pty-bridge/       # Terminal/PTY integration
    ├── bmad-registry/    # BMAD method registry (YAML parsing)
    └── storage/          # Local storage management
```

### Key Architectural Patterns

1. **Electron IPC Architecture**
   - All IPC channels defined in `@bmad-claude/ipc-contracts`
   - Main process handles: PTY sessions, workflow management, file system, native dialogs
   - Renderer process: React UI with xterm.js terminal
   - Preload script exposes safe IPC APIs to renderer

2. **Workflow State Machine** (`@bmad-claude/workflow-engine`)
   - XState v5 actor-based state machine
   - Manages BMAD role transitions with confidence-based auto-advancement
   - Manual lock mechanism prevents unwanted auto-transitions
   - Each project gets independent workflow instance via `WorkflowManager`
   - State: `active` ↔ `failed` with retry capability

3. **BMAD Role Sequence**
   ```
   intake → brainstorm → analyst → pm → ux-designer →
   architect → developer → qa → done
   ```
   - Each role represents a development phase
   - Transitions logged with timestamp, reason, and confidence
   - Supports manual switching, auto-advancement, and failure recovery

4. **PTY Bridge** (`@bmad-claude/pty-bridge`)
   - Session-based terminal management using node-pty
   - Each project gets isolated PTY session
   - Handles resize, write, kill operations
   - Streams data/exit events to renderer via IPC

## Important Implementation Details

### Workspace Dependencies

All internal packages use `workspace:*` protocol:
```json
"@bmad-claude/workflow-engine": "workspace:*"
```

When adding cross-package imports, always use the package name, not relative paths.

### XState v5 Patterns

- Use `setup()` API for type-safe machines
- Context initialization via `input` parameter (not `context` directly)
- Actions use `assign()` for immutable updates
- Guards for conditional transitions (e.g., `isNotManualLocked`)
- Actors created with `createActor(machine, { input })` and started explicitly

### IPC Communication

All IPC channels follow naming convention: `<domain>:<action>`
```typescript
// Request-response (invoke)
IPC.WORKFLOW_START = "workflow:start"
IPC.PTY_SPAWN = "pty:spawn"

// Event streaming (on/send)
IPC.PTY_DATA = "pty:data"
IPC.PTY_EXIT = "pty:exit"
```

### Native Module Handling

- `node-pty` requires native compilation
- `electron-builder install-app-deps` runs post-install
- Use `@electron/rebuild` if native modules fail to load

## Testing & Debugging

- Electron DevTools available in development mode
- Main process logs to terminal running `pnpm dev`
- Renderer process logs to DevTools console
- XState inspector can be enabled for workflow debugging

## Build Output

- Development: `apps/desktop/out/` (electron-vite output)
- Production: `apps/desktop/dist/` (electron-builder packages)
- TypeScript declarations: `*.d.ts` + `*.d.ts.map` in each package

## Common Pitfalls

1. **Native modules**: Always run `pnpm install` after pulling changes that affect native deps
2. **Workspace resolution**: Use package names, not relative paths for cross-package imports
3. **XState context**: Never mutate context directly; always use `assign()` actions
4. **IPC types**: Keep `ipc-contracts` in sync when adding new IPC channels
5. **PTY sessions**: Always clean up sessions on window close to prevent resource leaks
