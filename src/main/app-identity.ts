import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_NAME = "PuckBot";
export const LEGACY_PRODUCT_NAME = "Grokky";

export interface PreparedUserDataDirectory {
  path: string;
  migrated: boolean;
}

export function resolveUserDataOverride(currentPath?: string, legacyPath?: string): string | undefined {
  if (currentPath?.trim()) return currentPath;
  if (legacyPath?.trim()) return legacyPath;
  return undefined;
}

export function preparePuckBotUserDataDirectory(
  appDataDirectory: string,
  explicitPath?: string,
): PreparedUserDataDirectory {
  if (explicitPath?.trim()) return { path: explicitPath, migrated: false };

  const currentPath = join(appDataDirectory, PRODUCT_NAME);
  const legacyPath = join(appDataDirectory, LEGACY_PRODUCT_NAME);
  if (existsSync(currentPath) || !existsSync(legacyPath)) return { path: currentPath, migrated: false };

  try {
    renameSync(legacyPath, currentPath);
    return { path: currentPath, migrated: true };
  } catch {
    // A failed rename must not strand an existing installation. Continue from
    // the legacy directory and let the operator retry the migration later.
    return { path: legacyPath, migrated: false };
  }
}
