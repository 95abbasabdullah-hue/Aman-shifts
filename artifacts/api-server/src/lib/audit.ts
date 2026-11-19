import { db, auditLogsTable } from "@workspace/db";

export async function writeAuditLog(input: {
  actorUserId: string;
  action: string;
  subject: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogsTable).values({
    actorUserId: input.actorUserId,
    action: input.action,
    subject: input.subject,
    details: input.details ?? {},
  });
}
