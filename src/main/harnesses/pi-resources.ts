import { resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { isPathWithin } from "../path-boundary";

export async function createPiResourceLoader(options: {
  cwd: string;
  agentDir: string;
  selectedSkillPaths?: string[];
}) {
  const selected = options.selectedSkillPaths?.map((pathname) => resolve(pathname)) ?? [];
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noExtensions: true,
    noSkills: selected.length === 0,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: selected,
    skillsOverride: (base) => ({
      diagnostics: base.diagnostics,
      skills: base.skills.filter((skill) => selected.some((root) => isPathWithin(root, resolve(skill.filePath)))),
    }),
  });
  await loader.reload();
  return loader;
}
