import type { NotificationRecord } from "../../../../shared/control-plane-contracts";

export function AttentionCenter({ notifications, onSelectTask }: { notifications: NotificationRecord[]; onSelectTask(taskId: string): void }) {
  const pending = notifications.slice(-6).reverse();
  if (!pending.length) return null;
  return (
    <section className="attention-center" aria-label="Attention center">
      <h4>Needs attention</h4>
      {pending.map((notification) => notification.taskId
        ? <button type="button" key={notification.id} onClick={() => onSelectTask(notification.taskId!)}><strong>{notification.title}</strong><span>{notification.body}</span></button>
        : <div key={notification.id}><strong>{notification.title}</strong><span>{notification.body}</span></div>)}
    </section>
  );
}
