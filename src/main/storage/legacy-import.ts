import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";

export interface LegacyStateSource {
  pathname: string;
  raw: unknown;
  backupPath: string;
}

export async function readLegacyState(pathname: string): Promise<LegacyStateSource | null> {
  let text: string;
  try {
    text = await readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = JSON.parse(text) as unknown;
  const backupPath = `${pathname}.legacy-v2-backup`;
  try {
    await copyFile(pathname, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { pathname, raw, backupPath };
}
