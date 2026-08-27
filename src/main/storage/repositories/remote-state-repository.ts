import type { RemoteReconciliationState } from "../../../shared/remote-protocol";
import type { ControlPlaneDatabase } from "../database-types";

const EMPTY: RemoteReconciliationState = { revision: 0, acknowledgedCursor: 0, events: [], leaseEpochs: {}, diagnostics: [] };
export class RemoteStateRepository {
  private state = structuredClone(EMPTY);
  constructor(private readonly database: Pick<ControlPlaneDatabase, "readRemoteState" | "writeRemoteState">) {}
  async initialize(): Promise<void> { const stored = await this.database.readRemoteState(); this.state = stored ? JSON.parse(stored) as RemoteReconciliationState : structuredClone(EMPTY); }
  snapshot(): RemoteReconciliationState { return structuredClone(this.state); }
  async replace(state: RemoteReconciliationState): Promise<void> { const next = structuredClone(state); next.revision = this.state.revision + 1; await this.database.writeRemoteState(JSON.stringify(next)); this.state = next; }
}
