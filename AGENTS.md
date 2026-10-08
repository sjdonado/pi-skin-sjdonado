# agents.md

Working agreement for agents operating in this repo. This is a personal Pi skin (see `README.md` and `docs/pan-architecture.md`): a thin composition over Pi and Pi Durable, not a product.

## Run this

```sh
bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-skin-sjdonado"
bun run check   # typecheck; must be green before showing work
pss --check     # startup smoke: models, MCP servers, codemode, session
```

Live verification uses `pss` with Luna: delegate a task, run background research while chatting, confirm via `/tasks` and `/agents`. Never use paid turns as exploration; keep live runs to the acceptance script in `README.md`.

## Edit zones

- `skin.ts` is the only file with scheme behavior. That is where changes go.
- Backbone files (`main.ts`, `harness-setup.ts`, `runtime.ts`, `sessions.ts`, `tui.ts`) stay verbatim apart from import retargeting. A behavior change to them is a bug here: port it into `skin.ts` or drop it.
- Never patch `node_modules`. An upstream bug gets a local adapter in `skin.ts` with a link to the upstream issue.

## Boundaries

- No test files. Verify with the ladder above plus the live acceptance run; do not add test infrastructure.
- Never write pi's configuration (settings, credentials, sessions outside the scheme's own directory).
- Never commit, push, open PRs, or merge without explicit user authorization.
- Write commit messages in Conventional Commits format, why over what.
