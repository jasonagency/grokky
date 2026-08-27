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
        await this.adapter.rollback(backupId);
        return { status: "incompatible", backupId, compatibility, detail: `${compatibility.reason} The host backup was restored.` };
      }
      return { status: "updated", backupId, compatibility, detail: "Host update passed its health and protocol checks." };
    } catch (error) {
      await this.adapter.rollback(backupId);
      const compatibility = assessRemoteCompatibility({ major: -1, minor: 0 });
      return {
        status: "rolled-back",
        backupId,
        compatibility,
        detail: `${error instanceof Error ? error.message : "Host update failed"}. The host backup was restored.`,
      };
    }
  }
}
