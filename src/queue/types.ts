export type HeavyJobType = "image" | "voice" | "document";

export type QueueJobMessage = {
  version: 1;
  operationId: string;
  userId: string;
  jobType: HeavyJobType;
  metadata?: Record<string, unknown>;
  enqueuedAt: string;
};

export function isQueueJobMessage(value: unknown): value is QueueJobMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.operationId !== "string" || typeof record.userId !== "string") return false;
  if (!["image", "voice", "document"].includes(String(record.jobType))) return false;
  if (typeof record.enqueuedAt !== "string") return false;
  return record.metadata === undefined || (typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata));
}
