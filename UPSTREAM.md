# Upgrading from upstream

pi-durable is a thin host over maintained upstream building blocks. Upstream owns the UI components, theme, keybindings, auth flows, model runtime, MCP client, codemode sandbox, and search semantics. This repo owns the composition: Durable session ownership, process supervision, subagent and side-fork tools, the search adapter, provider selection, the TUI wiring, and the extra slash commands. Upgrades stay smooth by keeping that boundary explicit.

## Pinned upstream versions

`package.json` pins every upstream dependency. The set validated by the current test suite:

- `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-durable`, `pi-mcp`, `pi-codemode`, `pi-tui`, `chord`: `1.1.0`
- `typebox`: `1.3.27`
- `pi-web-search`: `1.7.0`

Reference points outside npm:

- Codex `/btw` semantics: `openai/codex` commit `2fdf047c9631c9ed01a31b62efb7891718a931a8` (`slash_command.rs`, `tui/src/app/side.rs`).

## Repeatable upgrade

Run from the repo root. No model calls are needed until the final optional smoke.

1. Bump the pinned versions in `package.json` and reinstall:
   ```sh
   bun install --ignore-scripts --no-save
   ```
2. Typecheck first. Upstream API changes surface here, usually in `native-ui.ts`, `search.ts`, or `tui.ts`:
   ```sh
   bun run check
   ```
3. Review the `native-ui.ts` seam. It re-exports deep upstream paths (keybindings, tool renderers, theme, theme controller, status indicator, footer formatter) that are not part of the package root API. Confirm each path still exists at the new version; that file is the only place allowed to import them.
4. Run the suite:
   ```sh
   bun test
   ```
   This covers session locking, delegation, search adapters, process supervision, UI rendering, and the headless terminal test. It invokes no inference.
5. Check upstream for new user-visible behavior to mirror (one-on-one goal): new slash commands, model picker changes, theme tokens, keybindings, auth flows. Add the missing pieces to `ui-commands.ts`/`tui.ts` with tests, or record a deliberate deferral in the task list.
6. Re-verify startup:
   ```sh
   bun main.ts --check
   ```
7. Optional paid smoke afterwards: one `/btw` round trip and one background job lifecycle on each preferred model, then stop. Never claim acceptance from steps 1 to 6 alone.

## Rules for the boundary

- Import upstream UI and runtime helpers only through `native-ui.ts`, except where the existing code already imports a documented package root (for example `@earendil-works/pi-tui` components).
- Never patch `node_modules`. An upstream bug gets a local adapter with a test, plus a link to the upstream issue.
- Keep `pi-web-search` source untouched; the adapter in `search.ts` owns header normalization, usage marking, and route guards.
- Record the new pinned versions and any deferred upstream behavior in the release notes or task list before pushing.
