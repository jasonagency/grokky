import { useState } from "react";
import type { UpdateSnapshot } from "../../../../shared/contracts";

interface UpdateBannerProps {
  update?: UpdateSnapshot;
  onDownload?: () => Promise<void>;
  onInstall?: () => Promise<string[]>;
  onCheck?: () => Promise<void>;
  onOpenDetails?: (url: string) => Promise<void>;
  onError?: (message: string) => void;
}

export function UpdateBanner({ update, onDownload, onInstall, onCheck, onOpenDetails, onError }: UpdateBannerProps) {
  const [busy, setBusy] = useState(false);
  if (!update || update.status === "idle" || update.status === "checking") return null;

  const title = update.status === "available" ? `Grokky ${update.info?.version} is available`
    : update.status === "downloading" ? `Downloading Grokky ${update.info?.version ?? "update"}`
      : update.status === "downloaded" ? `Grokky ${update.info?.version} is ready`
        : update.status === "blocked" ? "Update is ready when work reaches a safe checkpoint"
          : "Grokky could not verify the update";
  const action = update.status === "available" ? { label: "Download", run: onDownload }
    : update.status === "downloaded" || update.status === "blocked" ? { label: "Restart to update", run: onInstall }
      : update.status === "error" ? { label: "Check again", run: onCheck }
        : undefined;

  async function runAction() {
    if (!action?.run || busy) return;
    setBusy(true);
    try { await action.run(); }
    catch (error) { onError?.(error instanceof Error ? error.message : "The update action failed"); }
    finally { setBusy(false); }
  }

  return (
    <aside className={`update-banner update-${update.status}`} aria-live="polite" data-update-status={update.status}>
      <div>
        <strong>{title}</strong>
        {update.status === "downloading" && <span>{Math.round(update.progress?.percent ?? 0)}% downloaded</span>}
        {update.status === "downloaded" && <span>The signed installer and SHA-512 checksum were verified. Your context stays open until you choose to restart.</span>}
        {update.status === "blocked" && <ul>{update.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        {update.status === "error" && <span>{update.error}</span>}
      </div>
      <nav aria-label="Update actions">
        {update.info?.releaseUrl && <button type="button" onClick={() => void onOpenDetails?.(update.info!.releaseUrl!)}>Release details</button>}
        {action && <button className="primary" type="button" disabled={busy} onClick={() => void runAction()}>{busy ? "Working…" : action.label}</button>}
      </nav>
    </aside>
  );
}
