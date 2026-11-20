import { eq, inArray } from "drizzle-orm";
import {
  appUsersTable,
  auditLogsTable,
  db,
  departmentsTable,
  employeesTable,
} from "@workspace/db";

const SUPPORTED_DEPARTMENTS = [
  { code: "ED", name: "Emergency" },
  { code: "ICU", name: "Intensive Care" },
] as const;

function isHealthcareAssistant(jobTitle: string): boolean {
  return /\bHCA\b|HEALTH\s*CARE\s*ASSISTANT/i.test(jobTitle.trim());
}

/**
 * Keep only ED and ICU active. Existing unsupported rows remain as history.
 * HCA job roles are moved to ED without changing employee or roster identities.
 */
export async function ensureAmanDepartments(): Promise<void> {
  await db.transaction(async (tx) => {
    for (const department of SUPPORTED_DEPARTMENTS) {
      await tx
        .insert(departmentsTable)
        .values({
          ...department,
          timezone: "Asia/Qatar",
          active: true,
        })
        .onConflictDoUpdate({
          target: departmentsTable.code,
          set: {
            name: department.name,
            active: true,
            updatedAt: new Date(),
          },
        });
    }

    const supportedRows = await tx
      .select({ id: departmentsTable.id, code: departmentsTable.code })
      .from(departmentsTable)
      .where(inArray(
        departmentsTable.code,
        SUPPORTED_DEPARTMENTS.map((department) => department.code),
      ));
    const emergencyId = supportedRows.find((department) => department.code === "ED")?.id;
    if (!emergencyId) throw new Error("The Emergency department could not be initialized.");

    const existingDepartments = await tx
      .select({
        id: departmentsTable.id,
        code: departmentsTable.code,
        active: departmentsTable.active,
      })
      .from(departmentsTable);
    const unsupportedIds = existingDepartments
      .filter(
        (department) =>
          department.active &&
          !SUPPORTED_DEPARTMENTS.some((supported) => supported.code === department.code),
      )
      .map((department) => department.id);
    const employees = await tx
      .select({
        id: employeesTable.id,
        jobTitle: employeesTable.jobTitle,
        departmentId: employeesTable.departmentId,
      })
      .from(employeesTable);
    const assistants = employees.filter((employee) => isHealthcareAssistant(employee.jobTitle));
    let reassignedCount = 0;
    for (const employee of assistants) {
      if (
        employee.departmentId !== emergencyId ||
        employee.jobTitle !== "Healthcare Assistant"
      ) {
        await tx
          .update(employeesTable)
          .set({
            departmentId: emergencyId,
            jobTitle: "Healthcare Assistant",
            updatedAt: new Date(),
          })
          .where(eq(employeesTable.id, employee.id));
        reassignedCount += 1;
      }
    }

    if (unsupportedIds.length) {
      await tx
        .update(departmentsTable)
        .set({ active: false, updatedAt: new Date() })
        .where(inArray(departmentsTable.id, unsupportedIds));
    }
    if (unsupportedIds.length || reassignedCount) {
      const [admin] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(eq(appUsersTable.role, "admin"))
        .limit(1);
      if (admin) {
        await tx.insert(auditLogsTable).values({
          actorUserId: admin.id,
          action: "department.configuration_normalized",
          subject: "Emergency and Intensive Care departments",
          details: {
            reassignedHealthcareAssistants: reassignedCount,
            deactivatedUnsupportedDepartments: unsupportedIds.length,
          },
        });
      }
    }
  });
}
