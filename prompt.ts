import { getAgentDir, loadProjectContextFiles, loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function promptExtension(cwd: string) {
  const agentDir = getAgentDir();
  const skillPaths = [join(homedir(), ".agents/skills")];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, ".agents/skills");
    if (existsSync(path)) skillPaths.push(path);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir || dir === homedir()) break;
  }
  const skills = loadSkills({ cwd, agentDir, includeDefaults: true, skillPaths });
  const files = loadProjectContextFiles({ cwd, agentDir });
  return { skills: skills.skills, files,
    extension: defineExtension({ name: "instructions", sections: [
      section("role", () => "You are Pi, a general-purpose interactive coding harness. Work in the current project, investigate before editing, use the project's checks, and complete the user's requested scope. Read applicable nested project instructions before edits. Load a relevant skill by reading its SKILL.md. Do not read environment-secret files. Do not commit, push or publish without user authorization. Use foreground bash for finite work, bg_start for servers/watchers. Stop background work when no longer needed. Historical jobs never restart automatically. Subagents have fresh contexts: give each the task and authoritative file paths, not hidden conversation assumptions."),
      section("project_context", () => files.map(f => `File: ${f.path}\n${f.content}`).join("\n\n")),
      section("skills", () => formatSkillsForPrompt(skills.skills)),
      section("cwd", () => cwd),
    ] }) };
}
