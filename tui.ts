import { CombinedAutocompleteProvider, Container, ProcessTerminal, SelectList, SettingsList, Spacer, Text, TuiAltScreen, setKeybindings, type Component } from "@earendil-works/pi-tui";
import { CustomEditor, LoginDialogComponent, ModelSelectorComponent, OAuthSelectorComponent, ThemeSelectorComponent, ThinkingSelectorComponent, getSelectListTheme, getSettingsListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ApiKeyAuth, AuthCheck, AuthEvent, AuthPrompt, OAuthAuth } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { MODEL_IDS, THINKING_LEVELS, slashCommands } from "./ui-commands.ts";
import { DurableTranscript } from "./transcript.ts";
import { DurableFooter } from "./footer.ts";
import { InteractiveThemeController, KeybindingsManager, WorkingStatusIndicator, createChatViewport, getAvailableThemes, getEditorTheme, theme } from "./native-ui.ts";
import { modelChoices, modelReference } from "./providers.ts";
import type { Host } from "./host.ts";

export async function runTui(host: Host) {
  let nextSession: string | undefined;
  initTheme();
  const tui = new TuiAltScreen(new ProcessTerminal());
  const chat = new DurableTranscript(tui, host.session.cwd, host.settings.getHideThinkingBlock());
  const notices = new Container();
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: host.session.cwd, stderr: "ignore" }).stdout.toString().trim();
  const footer = new DurableFooter(host.session.cwd, branch);
  const editorArea = new Container();
  const keys = KeybindingsManager.create(); setKeybindings(keys);
  const editor = new CustomEditor(tui, getEditorTheme(), keys, { paddingX: host.settings.getEditorPaddingX(), embedWorkingStatus: true });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(host.prompt.skills, modelChoices(host.models).map(m => `${m.provider}/${m.id}`)), host.session.cwd));
  editorArea.addChild(editor);
  let selector: (Component & { dispose?: () => void }) | undefined;
  let exit!: () => void;
  const done = new Promise<void>(resolve => exit = resolve);
  let unsubscribe = () => {};
  let mounted: Awaited<ReturnType<typeof host.conversation.viewState>> | undefined;
  let indicator: WorkingStatusIndicator | undefined;
  let lastStatus = "";
  let expanded = false;
  const note = (message: string) => { host.notices.push(message); render(); };
  function render() {
    const view = mounted?.value;
    if (view) chat.apply(view);
    const live = view?.docs["pi.live"] as any;
    notices.clear();
    for (const notice of host.notices.slice(-3)) notices.addChild(new Text(theme.fg("muted", notice), 1, 0));
    const agent = view?.docs["pi.agent"] as any;
    editor.borderColor = theme.getThinkingBorderColor(agent?.thinkingLevel ?? "medium");
    const tool = live?.tools?.find((slot: any) => slot.status === "running");
    const status = live?.compactions?.length ? "Compacting..." : tool ? `Running ${tool.name}... (esc to abort)` : live?.run ? "Working... (esc to abort)" : "";
    if (status !== lastStatus) {
      lastStatus = status; indicator?.dispose();
      indicator = status ? new WorkingStatusIndicator(tui, status, undefined, editor.borderColor) : undefined;
      editor.setWorkingStatusIndicator(indicator);
    }
    footer.view = view; footer.running = host.processes.list().filter(j => ["starting", "running"].includes(j.status)).length;
    footer.contextWindow = agent?.model ? host.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow ?? 0 : 0;
    footer.autoCompact = host.settings.getCompactionEnabled();
    footer.side = host.sideParentId !== undefined;
    tui.requestRender();
  }
  async function mount() {
    unsubscribe(); mounted?.dispose(); chat.reset(); mounted = await host.conversation.viewState(ctx);
    unsubscribe = mounted.subscribe(render); render();
  }
  function restoreEditor() {
    selector?.dispose?.(); selector = undefined;
    editorArea.clear(); editorArea.addChild(editor); tui.setFocus(editor); tui.requestRender();
  }
  function showSelector(component: Component & { dispose?: () => void }, focus: Component = component) {
    selector?.dispose?.(); selector = component;
    editorArea.clear(); editorArea.addChild(component); tui.setFocus(focus); tui.requestRender();
  }
  async function selectModel() {
    const agent = await host.conversation.agent(ctx);
    const current = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId);
    const scoped = modelChoices(host.models).map(model => ({ model }));
    showSelector(new ModelSelectorComponent(tui, current, host.models, scoped,
      model => {
        restoreEditor();
        void host.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, ctx).catch(error => note(String(error)));
      }, restoreEditor, undefined,
      model => {
        host.settings.setDefaultModelAndProvider(model.provider, model.id); restoreEditor();
        void host.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, ctx).catch(error => note(String(error)));
      }, { provider: host.settings.getDefaultProvider() ?? "openai-codex", id: host.settings.getDefaultModel() ?? "gpt-6-luna" }));
  }
  async function selectThinking() {
    const agent = await host.conversation.agent(ctx);
    const model = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId);
    showSelector(new ThinkingSelectorComponent(agent.thinkingLevel, model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS],
      level => { restoreEditor(); void host.conversation.configure({ thinkingLevel: level }, ctx).catch(error => note(String(error))); }, restoreEditor,
      level => {
        if (agent.model) host.settings.setModelThinkingLevel(agent.model.provider, agent.model.modelId, level);
        restoreEditor(); void host.conversation.configure({ thinkingLevel: level }, ctx).catch(error => note(String(error)));
      }, agent.model ? host.settings.getModelThinkingLevel(agent.model.provider, agent.model.modelId) ?? host.settings.getDefaultThinkingLevel() : undefined));
  }
  async function selectSettings() {    const agent = await host.conversation.agent(ctx);
    const list = new SettingsList([
      { id: "model", label: "Model", currentValue: `${agent.model?.provider}/${agent.model?.modelId}`, values: modelChoices(host.models).map(m => `${m.provider}/${m.id}`) },
      { id: "thinking", label: "Thinking level", currentValue: agent.thinkingLevel, values: [...THINKING_LEVELS] },
      { id: "hideThinking", label: "Hide thinking", currentValue: String(host.settings.getHideThinkingBlock()), values: ["false", "true"] },
      { id: "compaction", label: "Auto-compaction", currentValue: String(host.settings.getCompactionEnabled()), values: ["true", "false"] },
      { id: "autocomplete", label: "Command suggestions", currentValue: String(host.settings.getAutocompleteMaxVisible()), values: ["5", "10", "15"] },
      { id: "theme", label: "Theme", currentValue: host.settings.getTheme() ?? "system", values: getAvailableThemes() },
    ], 10, getSettingsListTheme(), (id, value) => {
      if (id === "model" || id === "thinking") void command(`/${id} ${value}`).catch(error => note(String(error)));
      if (id === "hideThinking") { host.settings.setHideThinkingBlock(value === "true"); chat.setHideThinking(value === "true"); render(); }
      if (id === "compaction") host.settings.setCompactionEnabled(value === "true");
      if (id === "autocomplete") { host.settings.setAutocompleteMaxVisible(Number(value)); editor.setAutocompleteMaxVisible(Number(value)); }
      if (id === "theme") { host.settings.setTheme(value); themes.applyFromSettings(); }
    }, restoreEditor);
    showSelector(list);
  }
  type LoginOption = { id: string; name: string; authType: "oauth" | "api_key"; method?: ApiKeyAuth | OAuthAuth; status?: AuthCheck; subscription: boolean };
  function loginOptions(): LoginOption[] {
    const options: LoginOption[] = [];
    for (const provider of host.models.getProviders()) {
      const authStatus = host.models.getProviderAuthStatus(provider.id);
      const status = authStatus.configured ? { ...authStatus, type: (host.models.isUsingOAuth(provider.id) ? "oauth" : "api_key") as "oauth" | "api_key" } : undefined;
      if (provider.auth.oauth) options.push({ id: provider.id, name: provider.name, authType: "oauth", method: provider.auth.oauth, status, subscription: (provider.auth.oauth as { isSubscription?: boolean }).isSubscription === true });
      if (provider.auth.apiKey) options.push({ id: provider.id, name: provider.name, authType: "api_key", method: provider.auth.apiKey, status, subscription: false });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }
  function refreshModelAutocomplete() {
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(host.prompt.skills, modelChoices(host.models).map(m => `${m.provider}/${m.id}`)), host.session.cwd));
  }
  async function pickAuthType(): Promise<"oauth" | "api_key" | undefined> {
    return new Promise(resolve => {
      const list = new SelectList([
        { value: "oauth", label: "Sign in with an account", description: "OAuth subscription where available" },
        { value: "api_key", label: "Sign in with an API key", description: "Stored key for metered providers" },
      ], 8, getSelectListTheme());
      list.onSelect = item => { restoreEditor(); resolve(item.value as "oauth" | "api_key"); };
      list.onCancel = () => { restoreEditor(); resolve(undefined); };
      showSelector(list);
    });
  }
  async function pickLoginOption(options: LoginOption[]): Promise<LoginOption | undefined> {
    return new Promise(resolve => {
      showSelector(new OAuthSelectorComponent("login", options,
        (providerId: string, authType: string) => { const found = options.find(o => o.id === providerId && o.authType === authType); restoreEditor(); resolve(found); },
        () => { restoreEditor(); resolve(undefined); }));
    });
  }
  function findLoginOptions(providerRef: string): LoginOption[] {
    const needle = providerRef.trim().toLowerCase();
    return loginOptions().filter(o => o.id.toLowerCase() === needle || o.name.toLowerCase() === needle);
  }
  async function runProviderLogin(choice: LoginOption) {
    // Ambient-only providers omit login and are configured outside Pi.
    if (choice.authType === "api_key" && !(choice.method as ApiKeyAuth | undefined)?.login) {
      const dialog = new LoginDialogComponent(tui, choice.id, () => restoreEditor(), choice.name, `${choice.name} setup`);
      dialog.showInfo(`${(choice.method as { name?: string })?.name ?? "Authentication"} is configured outside Pi.`, [], true);
      showSelector(dialog);
      return;
    }
    const dialog = new LoginDialogComponent(tui, choice.id, () => {}, choice.name);
    showSelector(dialog);
    const withCancel = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
      if (!signal) return work;
      if (signal.aborted) { work.catch(() => {}); return Promise.reject(new Error("Login cancelled")); }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("Login cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(v => { signal.removeEventListener("abort", onAbort); resolve(v); },
          e => { signal.removeEventListener("abort", onAbort); reject(e); });
      });
    };
    try {
      await host.models.login(choice.id, choice.authType, {
        signal: dialog.signal,
        prompt: async (prompt: AuthPrompt) => {
          if (prompt.type === "manual_code") return withCancel(dialog.showManualInput(prompt.message), prompt.signal);
          if (prompt.type === "select") {
            const answer = await withCancel(dialog.showPrompt(`${prompt.message}\n${prompt.options.map(o => `- ${o.label}`).join("\n")}`), prompt.signal);
            return prompt.options.find(o => o.label === answer.trim() || o.id === answer.trim())?.id ?? answer.trim();
          }
          return withCancel(dialog.showPrompt(prompt.message, prompt.placeholder), prompt.signal);
        },
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
          else if (event.type === "device_code") { dialog.showDeviceCode(event); dialog.showWaiting("Waiting for authentication..."); }
          else if (event.type === "info") dialog.showInfo(event.message, event.links);
          else dialog.showProgress(event.message);
        },
      }, { getDeviceId: () => host.settings.getOrCreateDeviceId() });
      restoreEditor();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const result = await host.models.refresh({ providers: [choice.id], signal: controller.signal });
        if (result.aborted) note(`Signed in to ${choice.name}; catalog refresh timed out, using cached models.`);
        else if (result.errors.size > 0) note(`Signed in to ${choice.name}; catalog could not be refreshed, using cached models.`);
        else note(`Signed in to ${choice.name}. Use /model to select a model.`);
      } catch (error) {
        note(`Signed in to ${choice.name}; catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally { clearTimeout(timeout); }
      refreshModelAutocomplete();
    } catch (error) {
      restoreEditor();
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Login cancelled") return;
      if (error instanceof Error && error.name === "CredentialSynchronizationError") {
        note(`Saved credential for ${choice.name}, but local model state could not be synchronized: ${message}`);
        return;
      }
      throw new Error(`Failed to sign in to ${choice.name}: ${message}`);
    }
  }
  async function startLogin(providerRef?: string) {
    if (providerRef) {
      const matches = findLoginOptions(providerRef);
      if (!matches.length) throw new Error(`Unknown provider: ${providerRef}`);
      if (matches.length === 1) { await runProviderLogin(matches[0]); return; }
      if (new Set(matches.map(m => m.id)).size > 1) {
        const choice = await pickLoginOption(matches);
        if (!choice) return;
        await runProviderLogin(choice);
        return;
      }
      const authType = await pickAuthType();
      if (!authType) return;
      const choice = matches.find(o => o.authType === authType);
      if (!choice) throw new Error(`No ${authType} login for ${matches[0].name}`);
      await runProviderLogin(choice);
      return;
    }
    const authType = await pickAuthType();
    if (!authType) return;
    const options = loginOptions().filter(o => o.authType === authType);
    if (!options.length) throw new Error(authType === "oauth" ? "No account providers available." : "No API key providers available.");
    const choice = await pickLoginOption(options);
    if (!choice) return;
    await runProviderLogin(choice);
  }
  async function startLogout(providerRef?: string) {
    const stored = await host.models.listCredentials({ signal: AbortSignal.timeout(15000) });
    if (!stored.length) { note("No stored credentials to remove. /logout only removes credentials saved by /login; environment variables are unchanged."); return; }
    const options: LoginOption[] = stored.map(({ providerId, type }) => {
      const provider = host.models.getProvider(providerId);
      return { id: providerId, name: provider?.name ?? providerId, authType: type as "oauth" | "api_key", method: undefined, status: { type: type as "oauth" | "api_key", source: "stored credential" } as AuthCheck, subscription: (provider?.auth.oauth as { isSubscription?: boolean } | undefined)?.isSubscription === true };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const needle = providerRef?.trim().toLowerCase();
    const filtered = needle ? options.filter(o => o.id.toLowerCase() === needle || o.name.toLowerCase() === needle) : options;
    if (providerRef && !filtered.length) throw new Error(`No stored credential for: ${providerRef}`);
    const choice = filtered.length === 1 ? filtered[0] : await new Promise<LoginOption | undefined>(resolve => {
      showSelector(new OAuthSelectorComponent("logout", filtered,
        (providerId: string) => { const found = filtered.find(o => o.id === providerId); restoreEditor(); resolve(found); },
        () => { restoreEditor(); resolve(undefined); }));
    });
    if (!choice) return;
    try {
      await host.models.logout(choice.id, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      if (error instanceof Error && error.name === "CredentialSynchronizationError") {
        note(`Credentials removed for ${choice.name}, but local model state could not be synchronized: ${error.message}`);
        return;
      }
      throw error;
    }
    note(choice.authType === "oauth" ? `Logged out of ${choice.name}` : `Removed stored API key for ${choice.name}. Environment variables are unchanged.`);
    refreshModelAutocomplete();
  }
  async function command(text: string, whenBusy: "steer" | "followUp" = "steer") {
    const [name, ...rest] = text.split(/\s+/); const arg = rest.join(" ");
    if (name === "/quit") return exit();
    if (name === "/resume") {
      const sessions = host.sessions();
      const list = new SelectList(sessions.map(s => ({ value: s.id, label: s.title, description: `${new Date(s.createdAt).toLocaleString()}${s.id === host.session.id ? " (current)" : ""}` })), 10, getSelectListTheme());
      list.onSelect = item => { restoreEditor(); if (item.value !== host.session.id) { nextSession = item.value; exit(); } };
      list.onCancel = restoreEditor; showSelector(list); return;
    }
    if (name === "/btw") {
      const submission = await host.btw(arg || undefined); await mount();
      if (submission) void submission.wait(ctx).then(result => { if (result.status !== "done") note(`Side question ended: ${result.status}`); }).catch(error => note(String(error)));
      return;
    }
    if (name === "/back") { await host.back(); await mount(); return; }
    if (name === "/settings") return selectSettings();
    if (name === "/theme") {
      const picker = new ThemeSelectorComponent(host.settings.getTheme() ?? "system",
        name => { host.settings.setTheme(name); restoreEditor(); themes.applyFromSettings(); },
        () => { restoreEditor(); themes.applyFromSettings(); }, name => themes.preview(name));
      showSelector(picker, picker.getSelectList()); return;
    }
    if (name === "/ps") { await host.localTool("bg_list", {}, () => host.processes.list()); return; }
    if (name === "/logs") {
      if (!arg) throw new Error("Usage: /logs <id>");
      await host.localTool("bg_logs", { id: arg }, () => host.processes.logs(arg)); return;
    }
    if (name === "/stop") {
      if (!arg) throw new Error("Usage: /stop <id>");
      await host.localTool("bg_stop", { id: arg }, () => host.processes.stop(arg)); return;
    }
    if (name === "/restart") {
      if (!arg) throw new Error("Usage: /restart <id>");
      await host.localTool("bg_restart", { id: arg }, () => host.processes.restart(arg)); return;
    }
    if (name === "/login") { await startLogin(arg || undefined); return; }
    if (name === "/logout") { await startLogout(arg || undefined); return; }
    if (name === "/model") {
      if (!arg) return selectModel();
      await host.conversation.configure({ model: modelReference(arg, modelChoices(host.models)) }, ctx); return;
    }
    if (name === "/thinking") {
      if (!arg) return selectThinking();
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) throw new Error("Choose off, low, medium, high, xhigh or max");
      await host.conversation.configure({ thinkingLevel: arg as any }, ctx); return;
    }
    if (name === "/agents") {
      if (arg) { await host.switchConversation(Number(arg)); await mount(); }
      else {
        const agents = await host.conversations();
        const list = new SelectList(agents.map(c => ({ value: String(c.id), label: c.label, description: `Conversation ${c.id}` })), 8, getSelectListTheme());
        list.onSelect = item => { restoreEditor(); void host.switchConversation(Number(item.value)).then(mount).catch(error => note(String(error))); };
        list.onCancel = restoreEditor; showSelector(list);
      }
      return;
    }
    if (name === "/compact") { await host.conversation.compact(arg || undefined, ctx); return; }
    if (name === "/help") return note("/settings /model /login /logout /thinking /agents /compact /ps /logs ID /stop ID /restart ID /quit. Ctrl+L selects model; Ctrl+P cycles models; Shift+Tab cycles thinking; Ctrl+O expands tools. Esc closes a picker or aborts; Ctrl+C clears (press twice while empty to exit).");
    if (name.startsWith("/skill:")) {
      const skill = host.prompt.skills.find(s => s.name === name.slice(7));
      if (!skill) throw new Error("Unknown skill");
      text = `${readFileSync(skill.filePath, "utf8")}\n\nSkill location: ${skill.filePath}\n\n${arg}`;
    } else
    if (name.startsWith("/")) throw new Error("Unknown command; use /help");
    const submitted = await host.submit(text, whenBusy);
    void submitted.wait(ctx).then(result => { if (result.status !== "done") note(`Run ended: ${JSON.stringify(result)}`); }).catch(error => note(String(error)));
  }
  editor.onSubmit = text => {
    if (!text.trim()) return;
    editor.addToHistory(text); editor.setText("");
    void command(text.trim()).catch(error => note(String(error)));
  };
  editor.onEscape = () => { void host.abort().catch(error => note(String(error))); };
  editor.onCtrlD = exit;
  let lastClear = 0;
  editor.onAction("app.clear", () => {
    if (editor.getText()) { editor.setText(""); return; }
    if (host.sideParentId !== undefined) { void host.back().then(mount).catch(error => note(String(error))); return; }
    if (Date.now() - lastClear < 1000) return exit();
    lastClear = Date.now(); note("Press Ctrl+C again to exit, or /quit.");
  });
  editor.onAction("app.model.select", () => void selectModel().catch(error => note(String(error))));
  const cycleModel = (direction: number) => void host.conversation.agent(ctx).then(agent => {
    const models = modelChoices(host.models); if (!models.length) throw new Error("No configured models");
    const current = models.findIndex(m => m.provider === agent.model?.provider && m.id === agent.model.modelId);
    const next = models[(current + direction + models.length) % models.length];
    return host.conversation.configure({ model: { provider: next.provider, modelId: next.id } }, ctx);
  }).catch(error => note(String(error)));
  editor.onAction("app.model.cycleForward", () => cycleModel(1));
  editor.onAction("app.model.cycleBackward", () => cycleModel(-1));
  editor.onAction("app.thinking.cycle", () => void host.conversation.agent(ctx).then(agent => host.conversation.configure({ thinkingLevel: THINKING_LEVELS[(THINKING_LEVELS.indexOf(agent.thinkingLevel as any) + 1) % THINKING_LEVELS.length] }, ctx)).catch(error => note(String(error))));
  editor.onAction("app.tools.expand", () => { expanded = !expanded; chat.setExpanded(expanded); });
  editor.onAction("app.thinking.toggle", () => { const hidden = !host.settings.getHideThinkingBlock(); host.settings.setHideThinkingBlock(hidden); chat.setHideThinking(hidden); render(); });
  editor.onAction("app.message.followUp", () => { const text = editor.getText(); if (text.trim()) { editor.setText(""); void command(text, "followUp").catch(error => note(String(error))); } });
  editor.onAction("app.editor.external", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-editor-")), file = join(dir, "prompt.txt");
    writeFileSync(file, editor.getText(), { mode: 0o600 });
    tui.stop();
    try {
      const quoted = `'${file.replaceAll("'", "'\\''")}'`;
      const result = spawnSync(`${host.settings.getExternalEditorCommand()} ${quoted}`, { shell: "/bin/sh", stdio: "inherit", cwd: host.session.cwd });
      if (result.status !== 0) throw new Error("External editor failed");
      editor.setText(readFileSync(file, "utf8"));
    } catch (error) { note(String(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); tui.start(); themes.rebindTui(); tui.requestRender(true); }
  });
  tui.addChild(chat); tui.addChild(notices); tui.addChild(editorArea); tui.addChild(footer); tui.setFocus(editor);
  // Reuse the upstream viewport/dock instead of approximating its spacing.
  const viewport = createChatViewport({ document: chat, pendingMessages: new Container(),
    status: notices, widgetsAbove: new Spacer(1), editor: editorArea, footer,
    scrollbar: host.settings.getFullscreenScrollbar(),
    scrollbarTrackStyle: text => theme.fg("scrollbarTrack", text),
    scrollbarThumbStyle: text => theme.fg("scrollbarThumb", text) });
  tui.setLayoutRoot(viewport.root);
  await mount(); tui.start();
  const themes = new InteractiveThemeController(tui, { getSettingsManager: () => host.settings,
    showError: note, onChanged: () => { chat.invalidate(); render(); } });
  themes.applyFromSettings();
  const clock = setInterval(render, 1000);
  try { await done; } finally { clearInterval(clock); selector?.dispose?.(); indicator?.dispose(); themes.dispose(); chat.reset(); unsubscribe(); mounted?.dispose(); tui.stop(); }
  return nextSession;
}
