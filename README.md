# pi-skin-sjdonado

My scheme for running a harness in Pi. `pss` opens it in the current project; `pi-agent` runs the upstream standalone Pi CLI. The only configured dependency is `pi` itself: installed, logged in and running (plus Bun and one `bun install` for the scheme's own libraries). The upstream package-manager-owned binary is not moved or modified.

The backbone is the upstream Durable sample (the `durable/` coding agent and the `vacation/` research pattern in `earendil-works/pi`), kept to one file (`main.ts`, ~1,000 lines): everything the harness runs is a task, and subagents are conversations owned by the task that started them. Log in with pi itself; credentials are shared, so there is no login UI here.

## What the scheme adds

- **Foreground subagents** (`subagent` tool): delegate a bounded task to a fresh child conversation, get its answer back. Same shape as the sample.
- **Background subagents** (`background` tool): the sample's research pattern generalized. A background task owns the child conversation and posts its report back to the main conversation as a follow-up message, so the main run stays free. `/tasks` lists live background work, `/agents` switches to a running child to steer it, and the footer counts background tasks.
- **`/btw` side questions**: an ownerless reference-only fork, the sample's thread pattern. The main run continues independently; `/back` returns.
- **Provider-native web search** (`pi-web-search` adapted to the model, auth and per-conversation identity APIs, no model fallback), **shared skills**, and an **MCP codemode bridge** (all MCP tools through one sandboxed `codemode` tool).
- **Persistent memory**: standardized on `pi-memory`, deferred for now (`pi install npm:pi-memory` when ready). Markdown files the model reads and writes.

## Setup and usage

Needs Bun plus an installed, configured and logged-in `pi`:

```sh
bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-skin-sjdonado"
```

From any project directory:

```sh
pss                       # new scheme session and interactive chat
pss --continue            # reopen the latest scheme session for this project
pss --session <id>        # reopen the exact session shown in the exit hint
pss --check               # ephemeral startup/resource checks, no model calls
pss --check --no-mcp      # check without starting MCP servers
pi-agent                 # upstream CLI, existing extensions intact
```

## Chat commands

- `/settings`, `/model`, `/thinking`, `/theme`: Pi's native pickers. Explicit `/model provider/id` and `/thinking <level>` work inline.
- `/resume`: select a saved conversation for the current project. Closing the harness prints `pss --session <id>` for exact resume.
- `/btw [question]` / `/back`: side fork and return. Ctrl+C on an empty side composer also returns.
- `/agents [id]`: list and switch root/child conversations, including running children.
- `/tasks`: list live background tasks; selecting one opens its conversation.
- `/compact [instructions]`, `/quit`, `/skill:<name>`: as in Pi.

Ask in prose for background work ("research this in the background") and the model calls the `background` tool itself; the report arrives as a `[background report]` message.

## Verification

```sh
bun run check   # typecheck (repo files; upstream source-only drift in node_modules is filtered)
bun test        # session locking, delegation, background report-back, side forks, search adapter, MCP sandbox smoke, UI command list and footer
pss --check     # startup probe: model/thinking/tools/skills/MCP status plus codemode sandbox smoke
```

Sessions live under `~/.pi/harness/<project-hash>/<session>/` with fsync-enabled JSONL storage and a single-owner lock. `--check` uses temporary storage. No paid inference is needed for any of the above; live model turns remain manually verified.
