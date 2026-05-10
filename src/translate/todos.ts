import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { sanitizeTextForAcp } from "./safety.ts";

export function todoPhasesToPlanUpdate(value: unknown): SessionUpdate | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tasks = extractTodoTasks(value);
  return {
    sessionUpdate: "plan",
    entries: tasks.map((task) => ({
      content: sanitizeTextForAcp(task.content),
      priority: "medium",
      status: normalizeTodoPlanStatus(task.status),
    })),
  } as SessionUpdate;
}

function extractTodoTasks(value: unknown): Array<{ content: string; status: unknown }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const tasks: Array<{ content: string; status: unknown }> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (Array.isArray(item.tasks)) {
      tasks.push(...extractTodoTasks(item.tasks));
      continue;
    }
    const content = firstNonEmptyString(item.content, item.task, item.title, item.text);
    if (content !== undefined) {
      tasks.push({ content, status: item.status });
    }
  }
  return tasks;
}

function normalizeTodoPlanStatus(status: unknown): "pending" | "in_progress" | "completed" {
  switch (status) {
    case "in_progress":
    case "running":
      return "in_progress";
    case "completed":
    case "done":
    case "abandoned":
    case "cancelled":
    case "canceled":
      return "completed";
    default:
      return "pending";
  }
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
