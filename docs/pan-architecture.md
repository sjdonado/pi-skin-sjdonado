# Pan-architecture

The panoramic view of this skin: what sits where, what talks to what, and why the pieces are shaped this way. For the project pitch, see `README.md`; for the agent working agreement, see `agents.md`.

## Layers

```
pi (installed, configured, logged in)
  auth, settings, models, skills, MCP servers, sessions dir
      ^
pi-durable libraries (pinned npm packages, never patched)
  harness, tasks, conversations, storage, codemode sandbox
      ^
backbone copy (upstream sample, verbatim apart from import paths)
  main.ts, harness-setup.ts, runtime.ts, sessions.ts, tui.ts
      ^
skin.ts (the only file with scheme behavior)
  prompt, subagent, background, btw, search, MCP
      ^
pss (bin/pss launcher) + my dotfiles (skills, agents.md)
```

Nothing flows downward past configuration: the skin never writes pi's settings, credentials, or sessions. It reads them and adds behavior on top.

## Everything is a task

One ownership tree of tasks and conversations runs the whole show:

- A **model request**, a **tool call**, and a **compaction** are built-in tasks.
- A **foreground subagent** is a child conversation owned by the tool call that started it. The parent waits for the answer; aborting the call aborts the child.
- A **background subagent** is a task owned by the conversation plus a child owned by that task. The main run stays free while it works; the task posts its report back as a follow-up message. Crash-safe via `requestId`s on both the child submission and the report.
- A **side question** is a task in an ownerless reference-only fork. It reads parent history, answers once, and never writes back.
- `/tasks` renders the live task graph: every task, what it waits on, and the conversations it owns. `/agents` switches between the conversations.

## Registry composition

`harness-setup.ts` builds one registry per session directory: pi's `CodingTools`, the skin prompt (pi's own section order over project context, skills, and cwd), the skin tools (`subagent`, `background`, `btw`) plus the background task, the `web_search` adapter, and one lazily-connected `codemode` tool fronting every configured MCP server. MCP servers connect on first tool use, never at startup, so a dead server cannot break startup and `--check` stays offline-clean.

## Sessions and storage

Sessions live under `~/.pi/agent/experimental/pss-sessions/<cwd-hash>/<session>/session.sqlite`, opened through a proper lockfile (a stale lock from a crash resolves itself). Storage is SQLite through the upstream backend, so an interrupted turn resumes with `--continue` from its last checkpoint. `--check` opens a throwaway session in a temp dir and removes it afterwards.

## Search and memory

Web search goes through the selected provider's native search route (`pi-web-search` adapted, no model fallback); models without a verified route are rejected before dispatch. Persistent memory is standardized on `pi-memory` but deferred: install it with `pi install npm:pi-memory` when ready.

## Upgrading

The backbone is a copy, so upgrades are a re-copy plus a diff:

```sh
for f in main.ts harness-setup.ts runtime.ts sessions.ts tui.ts; do
  curl -fsSL "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/experimental/vacation/$f" -o "$f.new"
  diff "$f" "$f.new"
done
```

(`tui.ts` is shared with `durable/`; check both folders when it changes.) Then re-apply the documented deviations: import retargeting, skin registry composition with `cwd`/`env`, no vacation-only extension pin, `pss-sessions`, `--check`/`--help`. Bump pins in `package.json`, run `bun run check` and `pss --check`, and finish with one paid smoke (a delegation, a background round trip, a `btw`) on Luna.

## Deliberate omissions

No login UI (pi owns auth), no process supervisor (background work is durable tasks, not shell jobs), no test suite (the backbone is upstream's; the skin is verified live), no exact-resume picker (`--continue` reopens newest), no model allowlist (the picker shows the live catalog). Each omission keeps the diff against upstream reviewable; anything missed becomes visible the moment someone needs it.
