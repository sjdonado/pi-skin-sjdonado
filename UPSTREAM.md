# Upgrading from upstream

pi-skin-sjdonado is one file (`main.ts`) over maintained upstream building blocks, following the upstream Durable sample (`durable/` coding agent, `vacation/` research pattern) as the backbone. Upstream owns the UI components, theme, keybindings, auth flows, model runtime, MCP client, codemode sandbox, and search semantics. This repo owns the composition: session ownership, the `subagent`/`background` tools and task, the side fork, the search adapter, the TUI wiring, and the slash commands. Upgrades stay smooth by keeping that boundary explicit.

## Pinned upstream versions

`package.json` pins every upstream dependency. The set validated by the current test suite:

- `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-durable`, `pi-mcp`, `pi-codemode`, `pi-tui`, `chord`: `1.1.0`
- `typebox`: `1.3.27`
- `pi-web-search`: `1.7.0`

Reference points outside npm:

- Pi Durable design: `https://earendil.com/posts/pi-durable/`
- Sample sources: `earendil-works/pi`, `packages/coding-agent/src/experimental/{durable,vacation}`

## Repeatable upgrade

Run from the repo root. No model calls are needed until the final optional smoke.

1. Bump the pinned versions in `package.json` and reinstall:
   ```sh
   bun install --ignore-scripts --no-save
   ```
2. Typecheck first. Upstream API changes surface here, usually in the native UI seam, the search adapter, or the TUI section:
   ```sh
   bun run check
   ```
3. Review the native UI seam (the deep upstream imports at the top of `main.ts`, not part of the package root API). Confirm each path still exists at the new version.
4. Run the suite:
   ```sh
   bun test
   ```
   This covers session locking, delegation, background report-back, side forks, search adapters, and the MCP sandbox smoke. It invokes no inference.
5. Check upstream for new user-visible behavior to mirror (model picker changes, theme tokens, keybindings, auth flows). Add the missing pieces with tests, or record a deliberate deferral in the task list.
6. Re-verify startup:
   ```sh
   bun main.ts --check
   ```
7. Optional paid smoke afterwards: one background round trip and one `/btw` round trip, then stop. Never claim acceptance from steps 1 to 6 alone.

## Rules for the boundary

- Import upstream UI and runtime helpers only through the seam block at the top of `main.ts`, except where the code already imports a documented package root (for example `@earendil-works/pi-tui` components).
- Never patch `node_modules`. An upstream bug gets a local adapter with a test, plus a link to the upstream issue.
- Keep `pi-web-search` source untouched; the adapter in the search section owns header normalization, usage marking, and route guards.
- Record the new pinned versions and any deferred upstream behavior in the release notes or task list before pushing.
