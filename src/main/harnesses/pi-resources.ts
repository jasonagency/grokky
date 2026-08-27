import { resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

function within(pathname: string, root: string): boolean {
  const candidate = resolve(pathname);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}/`);
}

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
      skills: base.skills.filter((skill) => selected.some((root) => within(skill.filePath, root))),
    }),
  });
  await loader.reload();
  return loader;
}
