# pi-durable

`pi` opens this general-purpose coding harness in the current project. It targets one-on-one UI and capability parity with the upstream Pi agent, plus the Durable additions: owned background processes, reference-only `/btw` side forks, and exact session resume. `pi-agent` runs the upstream standalone Pi CLI. The upstream package-manager-owned binary is not moved or modified; managed launchers in `~/.local/bin` provide the split.

## Setup and usage

`bin/` ships self-contained compiled binaries (`pi-<os>-<arch>`, `pi-worker-<os>-<arch>`), so daily use needs no `node_modules`: `bin/pi` runs the matching binary when present and falls back to source otherwise. Rebuild for the current machine with `bun run build:binary` (or `PI_BUILD_TARGET=bun-linux-x64 sh scripts/build-binary.sh`); a future release pipeline runs the same script once per architecture.

The host uses pinned Pi 1.1.0 libraries in this directory and Bun. Install local dependencies without lifecycle scripts:

```sh
bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-durable"
```

From any project directory:

```sh
pi                       # new Durable session and interactive chat
pi --continue            # reopen the latest Durable session for this project
pi --session <id>        # reopen the exact session shown in the exit hint
pi --check               # ephemeral startup/resource checks, no model calls
pi --check --no-mcp      # check without starting MCP servers
pi --models              # list configured provider catalog choices, no inference
pi-agent                 # upstream CLI, existing extensions intact
pi-agent --upstream-path # locate its underlying executable
pi-agent --version
```

Use `pi-agent`'s `/login` if ChatGPT subscription authentication is needed. The custom host uses Pi's native `openai-codex` OAuth provider, not a Codex CLI process adapter. Credentials are not copied into dotfiles or printed by checks. Luna is the default with medium thinking. Preferred Codex choices are GPT-6.1 Sol, GPT-6 Luna and the latest Astra entry in the installed provider catalog (currently GPT-6 Astra). The upstream CLI remains installed at its own version; the custom host's library version does not upgrade that binary.

OpenCode Go uses the built-in Pi provider. If Pi has no configured Go credential, the host passes the existing OpenCode Go key from OpenCode's private auth store into the model runtime in memory. It does not rewrite the source store or persist the key in configuration. The model picker includes all configured Go catalog entries. Catalog listing is not a live entitlement or inference probe: provider errors remain visible if a particular model is unavailable to the account. `pi-agent` retains its independent auth setup.

## Chat commands

- `/settings`: open supported display/runtime settings.
- `/model`: open Pi's native searchable model picker. Explicit choices accept Codex IDs or qualified provider/model IDs, such as `/model opencode-go/deepseek-v4.1-flash`.
- `/login` or `/login <provider>`: sign in through the upstream provider selector and OAuth/API-key dialog, same flow as the upstream agent. `/logout [provider]` removes a stored credential.
- `/thinking`: open Pi's native thinking selector; `/thinking medium` sets a level directly.
- `/theme`: open the native theme picker with preview. System themes follow terminal light/dark changes.
- `/resume`: select a saved conversation for the current project. Closing the harness prints `pi --session <id>` for exact resume.
- `/btw [question]`: open a reference-context side fork without interrupting the main conversation. `/back` closes it and returns. Ctrl+C on an empty side composer also returns.
- `/agents`: list root/child conversations. `/agents <id>` switches the chat to a child, including a running one.
- `/compact [instructions]`: compact the shown conversation.
- `/ps`: list active and historical background processes as a native tool-call card.
- `/logs <id>`, `/stop <id>`, `/restart <id>`: inspect, stop or explicitly restart a process, each recorded as a tool call so output uses the existing expandable tool renderers.
- `/quit` or Ctrl+D: close the host and clean up owned processes. Ctrl+C clears the composer; press it twice while empty to exit. Esc closes a picker or aborts the shown conversation and its owned jobs.

The UI reuses Pi's native editor, keybindings, user/assistant message components, expandable tool renderers, theme controller and fullscreen viewport/dock. It preserves Pi-agent's gaps between user turns and above the composer, rather than rendering tool output as plain chat text. Slash completion includes supported commands and shared `/skill:<name>` commands. Ctrl+L opens the model picker, Ctrl+P cycles configured choices, Shift+Tab cycles thinking, Ctrl+O expands/collapses tool output, and the native external-editor shortcut edits the draft. Input during a run steers that conversation; the follow-up shortcut queues a follow-up. The footer shows per-conversation usage, context estimate, model/thinking and managed background status. Internal UI helpers are isolated in `native-ui.ts` and pinned to Pi 1.1.0; run UI checks before upgrading that compatibility seam.

## Provider-native web search

`pi-web-search@1.7.0` is adapted directly to Durable's model, auth and per-conversation identity APIs. The `web_search` tool inherits the current thinking level and uses the selected provider's native search route. The package's explicit dedicated-search configuration remains available for supported routes; there is no automatic model fallback. OpenCode Go Responses-backed models have a verified request adapter. Go chat-completion models have no native search tool; its Anthropic gateway route remains unverified and is rejected before dispatch in this host. Select a supported model explicitly or use browser MCP tools instead.

The plugin does not report search-request usage. Durable records an unknown-usage marker before dispatch, and the footer states that displayed cost/token totals exclude those requests. Unsupported-model and provider errors are propagated, not counted as successful searches. Mock tests cover Codex/Go request bodies, thinking, nullable-header normalization, stable Go session headers and no-fallback behavior; live search calls have not been used as acceptance evidence.

## Side conversations

Codex's `/btw` aliases `/side` and uses an ephemeral fork with a reference-only boundary. This host follows that design using Durable forks, not fresh-context implementation subagents. The fork inherits committed parent history and its current model/thinking, but hides inherited history from the side UI. It cannot continue the parent's work: side tools are read/search only, with no edits, shell, MCP mutation, processes or delegation. The main run continues independently. Side answers are not appended to the parent. `/back` aborts/closes the side; closed sides are hidden from the agent picker and are not automatically resumed. Storage retains their history for audit, so this is logical ephemerality rather than physical deletion.

Source checked at Codex commit `2fdf047c9631c9ed01a31b62efb7891718a931a8`:

- https://github.com/openai/codex/blob/2fdf047c9631c9ed01a31b62efb7891718a931a8/codex-rs/tui/src/slash_command.rs
- https://github.com/openai/codex/blob/2fdf047c9631c9ed01a31b62efb7891718a931a8/codex-rs/tui/src/app/side.rs

## Architecture and resources

Durable owns the model/tool loop, persisted conversation state, queued input, cancellation and compaction. `host.ts` composes its public APIs with Pi's model runtime, coding tools, a direct MCP/code-mode bridge, subagents and process supervision. The host is not the upstream experimental Durable TUI and does not rely on its unsupported extension loading.

Shared instructions come from `~/.pi/agent/AGENTS.md` and project context discovery. Skills load from shared `~/.agents/skills/`, Pi's conventional locations and project `.agents/skills/` directories up to the repository root. The model gets skill descriptions and reads `SKILL.md` as needed. Applicable nested project instructions must be read before editing.

Global `~/.pi/agent/mcp.json` and project `.pi/mcp.json` supply MCP servers. The managed global definitions match OpenCode: agent-browser, chrome-devtools, ios-simulator and git-bug. All MCP tools are reachable through `codemode`. Scripts use `searchTools`, `describeTool` and `tools.<name>` in Pi's QuickJS sandbox. Nested MCP intent/outcome records are committed to Durable storage. Local coding tools and MCP operations run with the user's authority; the script sandbox itself has no ambient filesystem/network/process APIs.

Subagents are Durable-owned child conversations with fresh transcripts. A parent call waits for the child answer, and parent cancellation aborts its child work. Child model choices are explicit: Codex parents default workers to Luna, while Go parents keep their provider/model instead of silently switching subscriptions. A qualified model or `inherit` can be requested explicitly. Children default to medium thinking. Recursive delegation is removed from their tool set. This host uses its own Durable integration, not the regular CLI's `pi-subagents` extension.

Running subagents stay visible without new UI: `/agents` lists root/child conversations (running children included) and switches between them, the footer shows managed background-process counts, and `/ps` renders owned jobs as tool cards. The upstream `pi-subagents` FleetView and `/subagents-fleet` live inspector remain the reference pattern for a persistent fleet view; no equivalent dock is built here.

## Verification

Automated, no inference:

```sh
bun run check   # typecheck (repo files; upstream source-only drift in node_modules is filtered)
bun test        # 21 tests: session locking, delegation, search adapters, MCP sandbox smoke, local tool-call cards, UI rendering, headless terminal
pi --check      # startup probe: model/thinking/tools/skills/MCP status plus codemode sandbox smoke (`"codemode": "ok"`)
bun run build:binary  # refresh bin/pi-<os>-<arch> + bin/pi-worker-<os>-<arch> for this machine
```

`mcp.test.ts` executes a real `CodemodeSandbox` script, so a broken install (for example a missing `quickjs-wasi/quickjs.wasm` after a stale checkout or pruned `node_modules`) fails there and in `pi --check` with a reinstall hint instead of surfacing mid-turn as `Cannot find module 'quickjs-wasi/quickjs.wasm'`. Reinstall with `bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-durable"`.

Manual TUI cases (terminal, no paid calls except where noted):

- `/login` with no arg shows account vs API-key choice, then the native provider picker; `/login anthropic` jumps straight to Anthropic; ambient-only providers explain they are configured outside Pi. `/logout` lists and removes stored credentials.
- `/model` lists every available catalog entry after login; Ctrl+P cycles the same set.
- `/btw [question]` forks a read-only side conversation hiding inherited history; `/back` (or Ctrl+C on an empty side composer) returns. Main run continues independently.
- `/agents` lists Main/Side/Agent conversations; `/agents <id>` switches, including to a running child.
- `/ps`, `/logs <id>`, `/stop <id>`, `/restart <id>` render as expandable tool cards in the transcript (paid model turn needed only to exercise a full background lifecycle, not for the rendering itself).
- `/resume` and the exit hint print the exact `pi --session <id>` for reopen.
- Compiled-binary check: `bin/pi --check` dispatches to `bin/pi-<os>-<arch>` with no `node_modules` needed; background start/stop/log output verified against `bin/pi-worker-<os>-<arch>` (echo completes, logs match, stop reports `owner-exited`).

## Process lifecycle

The agent uses `bg_start`, `bg_list`, `bg_logs`, `bg_stop` and `bg_restart`. Jobs belong to a conversation: root services stay available between turns, while delegated child jobs are cleaned up when their subagent call finishes. Four active jobs are allowed; output is capped at 20 MiB, log reads at 50 KiB, and default lifetime is one hour with an explicit maximum of 24 hours.

Each job runs beneath a separate supervisor. The host holds its stdin pipe open; normal close or abrupt host death closes that pipe, causing the supervisor to terminate the shell process group, escalate if needed, drain output and record the outcome. Finite command completion also cleans remaining descendants in that group. Completed/failed jobs notify the root conversation; deliberate stop and owner-exit cleanup do not automatically invoke another model turn.

Launch details, status and logs persist under the session directory. On reopen, unverified running records become interrupted. The host never signals a saved PID or blindly relaunches a command. Explicit restart creates a new job identity. Detached descendants that deliberately escape the managed process group and supervisor failure itself are not covered by this prototype. Background jobs are noninteractive shell processes, not PTYs.

## Persistence and checks

Sessions live under `~/.pi/harness/<project-hash>/<session>/`. The host uses fsync-enabled JSONL storage and a single-owner session lock. Reopen resumes Durable's unfinished work; interrupted unsafe tool calls do not silently replay. Background OS processes follow the separate reconciliation policy above. `--check` uses temporary storage and does not replace the latest real session.

```sh
bun run check
bun test
```

Offline tests cover session locking/exact reopen, canonical project identity, shared skills, fresh child delegation, parent-preserving side forks, provider/search adapters, sandboxed dependent MCP calls, process capture/cancellation and owner-SIGKILL cleanup. An actual macOS terminal test exercises command completion, model/settings selection, session selection, composer spacing and the exact exit resume hint without inference. Unique ignored `results-ui-*` directories retain terminal logs and results, including failed capture attempts. Live MCP discovery connected all four managed servers. No fresh paid coding/search turn has been used to claim full daily-driver acceptance.

An existing eval code-mode fixture remains blocked after the command rename: its isolated PATH cannot locate upstream Pi through `pi-agent`. Retained failures are under `evals/harness/results-codemode-*`. The Durable host tests pass independently. Full platform provisioning remains unverified because sudo and Docker checks are unavailable.

Regular `pi-agent` keeps the earlier pinned background-task/subagent packages and code-mode configuration as a fallback. Those extensions are not loaded into the custom Durable host. General tree navigation is intentionally omitted; `/btw` provides the requested side-question workflow. Arbitrary upstream extension commands, direct image attachments and interactive PTYs are not yet ported.
