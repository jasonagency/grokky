import { assessRemoteCompatibility, type RemoteCompatibility } from "../../shared/remote-protocol";

export interface HostUpdateAdapter {
  backup(): Promise<string>;
  install(packagePath: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; protocol: { major: number; minor: number }; detail?: string }>;
  rollback(backupId: string): Promise<void>;
}

export interface HostUpdateResult {
  status: "updated" | "rolled-back" | "incompatible";
  backupId: string;
  compatibility: RemoteCompatibility;
  detail: string;
}

class HostRollbackError extends Error {}

export class HostUpdateService {
  constructor(private readonly adapter: HostUpdateAdapter) {}

  async apply(packagePath: string): Promise<HostUpdateResult> {
    if (!packagePath.trim()) throw new Error("Host update package path is required");
    const backupId = await this.adapter.backup();
    try {
      await this.adapter.install(packagePath);
      const health = await this.adapter.healthCheck();
      if (!health.healthy) throw new Error(health.detail || "Updated host did not become healthy");
      const compatibility = assessRemoteCompatibility(health.protocol);
      if (!compatibility.newJobsAllowed) {
        await this.rollbackOrThrow(backupId, compatibility.reason);
        return { status: "incompatible", backupId, compatibility, detail: `${compatibility.reason} The host backup was restored.` };
      }
      return { status: "updated", backupId, compatibility, detail: "Host update passed its health and protocol checks." };
    } catch (error) {
      if (error instanceof HostRollbackError) throw error;
      const failure = error instanceof Error ? error.message : "Host update failed";
      await this.rollbackOrThrow(backupId, failure);
      const compatibility = assessRemoteCompatibility({ major: -1, minor: 0 });
      return {
        status: "rolled-back",
        backupId,
        compatibility,
        detail: `${failure}. The host backup was restored.`,
      };
    }
  }

  private async rollbackOrThrow(backupId: string, updateFailure: string): Promise<void> {
    try {
      await this.adapter.rollback(backupId);
    } catch (error) {
      const rollbackFailure = error instanceof Error ? error.message : "unknown rollback failure";
      throw new HostRollbackError(`Host update failed: ${updateFailure}. Rollback ${backupId} also failed: ${rollbackFailure}. Restore the backup manually.`);
    }
  }
}
