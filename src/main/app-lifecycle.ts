import type { Conversation } from "../shared/contracts";
import type { TaskNode } from "../shared/control-plane-contracts";

const BACKGROUND_TASK_STATUSES = new Set<TaskNode["status"]>(["queued", "leased", "running"]);

export interface LocalBackgroundWork {
  conversationIds: string[];
  taskIds: string[];
}

export function localBackgroundWork(
  conversations: ReadonlyArray<Pick<Conversation, "id" | "status">>,
  tasks: ReadonlyArray<Pick<TaskNode, "id" | "status" | "assignment">>,
  localDeviceId: string,
): LocalBackgroundWork {
  return {
    conversationIds: conversations.filter((conversation) => conversation.status === "running").map((conversation) => conversation.id),
    taskIds: tasks
      .filter((task) => BACKGROUND_TASK_STATUSES.has(task.status) && (!task.assignment.targetHostId || task.assignment.targetHostId === localDeviceId))
      .map((task) => task.id),
  };
}
