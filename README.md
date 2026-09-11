# Muse Terminal Demo

A full-screen, dark, mobile-friendly web terminal with a **real shell backend** — xterm.js in the browser, tmux-backed bash sessions on the server, bridged over a typed RPC action. Sessions persist across page reloads.

This is a demo snapshot exported from a Hatch web artifact (originally the "Terminal" artifact). It runs on the Hatch TypeScript-space runtime via `@hatch/space-sdk`; it is not a standalone app you can `npm start` — the server side executes inside the space runtime.

## How it works

- **Client** (`client/src/`): React + xterm.js + FitAddon. `App.tsx` opens the terminal, polls the backend for new output, and streams keystrokes as raw bytes so Enter/arrows/Ctrl-C behave like a real PTY. The session id is remembered in localStorage so reloading the page reattaches to the same shell.
- **Transport** (`client/src/api.ts`): typed RPC client generated straight from the server's action definitions — no codegen, `createActionClient<typeof Actions>()` POSTs `{action, args}` to `./actions`.
- **Server** (`server/src/`):
  - `actions.ts` — declares one action, `terminal`, with zod-validated request/response. It delegates to a privileged handler.
  - `privileged.ts` — the actual backend. Each session is a tmux session running an interactive bash; output is captured with `pipe-pane` into a per-session log file, and the client reads chunks by byte offset (base64). Supports `start`, `read`, `write`, `resize`, `restart`, `kill`. Also restores the host's network/proxy environment into each new shell.
  - `schema.ts` — intentionally empty: terminal sessions live in tmux, not the database.
- **Migrations** (`drizzle/`): legacy no-op migrations from the space scaffold.

## Layout

```
client/        React + xterm.js frontend (bun build via build.mjs)
server/        Space actions + privileged tmux shell backend
drizzle/       Scaffold migrations (no-op)
space.json     Original artifact manifest (reference only)
```

## Scripts

```sh
bun run typecheck      # tsc --noEmit for client and server
bun run build          # builds server actions bundle + client bundle
bun run build:server   # bun build ./server/src/actions.ts
bun run build:client   # bun ./client/build.mjs
```

Built and type-checked with [Bun](https://bun.sh) 1.3.x, React 19, xterm 5.5.

## Notes

- Requires `tmux` on the host (`/usr/bin/tmux`) and the Hatch space runtime (`@hatch/space-sdk`).
- Session state files live in `/tmp/muse-web-terminal` on the server; nothing sensitive is committed here.
- The original artifact's app database and build caches are intentionally excluded from this snapshot.
