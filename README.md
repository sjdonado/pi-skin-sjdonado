# pi-skin-sjdonado

A personal Pi skin. `pss` opens my day-to-day harness in the current project. The only dependency is `pi` itself: installed, configured and logged in.

A skin sits on top of Pi. It does not replace Pi, and it is not an out-of-the-box experience for everyone, a distro, a fork, or something maintained for everyone. It takes the building blocks I need, from Pi and Pi Durable plus my dotfiles (skills, `agents.md` and the rest), and composes them into the configuration for my harness. The hope is to inspire more skins, the way people build their own Neovim configurations: personal, small, and upstream-faithful.

The backbone is copied from the upstream Durable sample (`durable/` coding agent plus the `vacation/` research pattern in `earendil-works/pi`), file for file:

| file | role |
| --- | --- |
| `main.ts` | arguments, open, run, close (plus `--check`) |
| `harness-setup.ts` | HTTP setup, settings, the registry, the initial model |
| `runtime.ts` | Harness and the `DurableView`/`DurableController` |
| `sessions.ts` | session directories and the lock |
| `tui.ts` | rendering with pi's interactive components |
| `skin.ts` | the skin: prompt, subagents, search, MCP (was `vacation.ts`) |

Only import paths are retargeted from the monorepo to the installed packages; there is deliberately no other cleverness in the backbone. Everything the harness runs is a task, and subagents are conversations owned by the task that started them. Log in with pi itself; credentials are shared, so there is no login UI here. See `docs/pan-architecture.md` for the full picture.

## What the skin adds

`skin.ts` is the single place where this skin differs from the sample:

- **Foreground subagents** (`subagent` tool): one general-purpose delegate, same as the parent unless asked. The task carries the instructions and the parent picks the model. `/agents` switches to a running child to steer it.
- **Background terminals** (`bg_start` and friends): shell processes owned by the conversation, for servers, watchers and long commands while you keep working. `/ps` lists them with recent output, `/stop` stops them all. Completions notify the main conversation; deliberate stops and owner-exit cleanup stay quiet.
- **Side questions** (`btw` tool): the question runs as a task in an ownerless reference-only fork and its answer returns as the tool result, never touching the parent.
- **Provider-native web search** (`pi-web-search` adapted to the model, auth and per-conversation identity APIs, no model fallback).
- **Shared skills and MCP**: pi's prompt sections, skills and context files, plus all MCP servers through one lazily-connected `codemode` tool (servers connect on first use, never at startup).

## Setup and usage

Needs Bun plus an installed, configured and logged-in `pi`:

```sh
bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-skin-sjdonado"
```

From any project directory:

```sh
pss                       # new skin session and interactive chat
pss --continue            # reopen the newest skin session for this project
pss --check               # ephemeral startup/resource checks, no model calls
pi                        # upstream CLI directly
```

## Chat commands

`/model`, `/tasks`, `/agents`, `/compact` come from the sample; `/copy`, `/name`, `/session`, `/resume`, `/reload`, `/quit`, `/mcp`, `/settings`, `/thinking`, `/new`, `/debug`, `/changelog`, `/hotkeys`, `/export`, `/import`, `/share`, `/ps` and `/stop` are skin additions (`/mcp` and `/settings` redirect to pi). Exit with Ctrl+D or Ctrl+C. Typing `/` completes slash commands and discovered skills with live model names, like pi's message bar. Ask in prose to run shells in the background and the model calls `bg_start` itself; check output later with `/ps`.

## Verification

```sh
bun run check   # typecheck (repo files; upstream source-only drift in node_modules is filtered)
pss --check     # startup probe: models, notices, MCP servers, codemode sandbox smoke, session
```

There are no tests in this repo on purpose: the backbone is upstream's code, and the skin is verified live. The acceptance run is `pss` with Luna selected: ask it to delegate a task to a subagent, then to start a server in the background while chatting about something else, and confirm via `/ps` that the terminal runs with live output. Pi's own configuration (settings, credentials) is never written by the skin.

Sessions live under `~/.pi/agent/experimental/pss-sessions/<cwd-hash>/<session>/session.sqlite` with a proper lockfile. `--check` uses temporary storage.
