// Drop-in skill system (hermes/openclaw/agentskills.io style).
// skills/<name>/SKILL.md with `name:` + `description:` frontmatter.
// The bot injects the catalog into fresh sessions; the agent reads full
// skill files with its file tools when a task matches.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Skill {
  name: string;
  description: string;
  file: string;
}

function parseFrontmatter(raw: string): { name: string; description: string } | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return undefined;
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1].trim();
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1].trim();
  if (!name || !description) return undefined;
  return { name, description };
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  for (const entry of entries.sort()) {
    const file = path.join(skillsDir, entry, "SKILL.md");
    try {
      const raw = await readFile(file, "utf8");
      const fm = parseFrontmatter(raw);
      if (fm) skills.push({ ...fm, file });
    } catch {
      // Missing/unreadable skill — skip.
    }
  }
  return skills;
}

/** Compact catalog for the system prompt. */
export function skillsCatalog(skills: Skill[], skillsDir: string): string {
  if (skills.length === 0) return "(no skills installed)";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `SKILLS_DIR: ${skillsDir}\n${lines.join("\n")}\n(Read the full SKILL.md with your file tools when a task matches a skill — then FOLLOW it.)`;
}
