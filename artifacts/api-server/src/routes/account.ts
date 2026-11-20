import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetCurrentUserResponse,
  GetEmployeeLinkOptionsResponse,
  LinkCurrentUserEmployeeBody,
} from "@workspace/api-zod";
import {
  appUsersTable,
  auditLogsTable,
  db,
  departmentsTable,
  employeesTable,
  type AppUser,
} from "@workspace/db";
import { currentAppUser } from "../lib/amanAuth";

const router: IRouter = Router();

async function currentUserResponse(user: AppUser) {
  const [employee] = user.employeeId
    ? await db
        .select({
          fullName: employeesTable.fullName,
          departmentId: employeesTable.departmentId,
        })
        .from(employeesTable)
        .where(eq(employeesTable.id, user.employeeId))
        .limit(1)
    : [];
  return GetCurrentUserResponse.parse({
    id: user.id,
    clerkUserId: user.clerkUserId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    departmentId: employee?.departmentId ?? user.departmentId,
    employeeId: user.employeeId,
    employeeName: employee?.fullName ?? null,
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    cause?: { code?: unknown };
  };
  return value.code === "23505" || value.cause?.code === "23505";
}

router.get("/me", async (req, res): Promise<void> => {
  res.json(await currentUserResponse(currentAppUser(req)));
});

router.get("/employee-link-options", async (req, res): Promise<void> => {
  const user = currentAppUser(req);
  const options = await db
    .select({
      id: employeesTable.id,
      employeeCode: employeesTable.employeeCode,
      fullName: employeesTable.fullName,
      jobTitle: employeesTable.jobTitle,
      departmentName: departmentsTable.name,
      linkedUserId: appUsersTable.id,
    })
    .from(employeesTable)
    .innerJoin(
      departmentsTable,
      eq(departmentsTable.id, employeesTable.departmentId),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.employeeId, employeesTable.id),
    )
    .where(
      and(
        eq(employeesTable.active, true),
        eq(departmentsTable.active, true),
        inArray(departmentsTable.code, ["ED", "ICU"]),
        user.employeeId
          ? eq(employeesTable.id, user.employeeId)
          : or(isNull(appUsersTable.id), eq(appUsersTable.id, user.id)),
      ),
    )
    .orderBy(asc(employeesTable.fullName), asc(employeesTable.employeeCode));
  res.json(
    GetEmployeeLinkOptionsResponse.parse(
      options.map(({ linkedUserId: _linkedUserId, ...option }) => option),
    ),
  );
});

router.put("/me/employee", async (req, res): Promise<void> => {
  const parsed = LinkCurrentUserEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const user = currentAppUser(req);
  try {
    const result = await db.transaction(async (tx) => {
      const [employee] = await tx
        .select({
          id: employeesTable.id,
          employeeCode: employeesTable.employeeCode,
          fullName: employeesTable.fullName,
          departmentId: departmentsTable.id,
          departmentName: departmentsTable.name,
          departmentCode: departmentsTable.code,
        })
        .from(employeesTable)
        .innerJoin(
          departmentsTable,
          eq(departmentsTable.id, employeesTable.departmentId),
        )
        .where(
          and(
            eq(employeesTable.id, parsed.data.employeeId),
            eq(employeesTable.active, true),
            eq(departmentsTable.active, true),
            inArray(departmentsTable.code, ["ED", "ICU"]),
          ),
        )
        .limit(1);

      if (!employee) return { kind: "not-found" as const };

      const [current] = await tx
        .select({ employeeId: appUsersTable.employeeId })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, user.id))
        .limit(1);
      if (current?.employeeId) {
        return current.employeeId === employee.id
          ? { kind: "already-linked" as const }
          : { kind: "user-already-linked" as const };
      }

      const [owner] = await tx
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(eq(appUsersTable.employeeId, employee.id))
        .limit(1);
      if (owner && owner.id !== user.id) {
        return { kind: "employee-already-linked" as const };
      }

      const [updated] = await tx
        .update(appUsersTable)
        .set({
          employeeId: employee.id,
          departmentId: employee.departmentId,
          updatedAt: new Date(),
        })
        .where(
          and(eq(appUsersTable.id, user.id), isNull(appUsersTable.employeeId)),
        )
        .returning();
      if (!updated) return { kind: "user-already-linked" as const };

      await tx.insert(auditLogsTable).values({
        actorUserId: user.id,
        action: "account.employee_linked",
        subject: employee.fullName,
        details: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          departmentCode: employee.departmentCode,
          departmentName: employee.departmentName,
        },
      });
      return { kind: "linked" as const, user: updated };
    });

    if (result.kind === "not-found") {
      res.status(404).json({ error: "Select an active employee in ED or ICU." });
      return;
    }
    if (result.kind === "employee-already-linked") {
      res.status(409).json({
        error: "That employee is already linked to another account.",
      });
      return;
    }
    if (result.kind === "user-already-linked") {
      res.status(409).json({
        error: "This account is already linked to a different employee.",
      });
      return;
    }
    const linkedUser = result.kind === "linked" ? result.user : user;
    res.json(await currentUserResponse(linkedUser));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({
        error: "That employee is already linked to another account.",
      });
      return;
    }
    req.log.error({ err: error }, "Could not link Aman account to employee");
    res.status(500).json({ error: "The employee could not be linked." });
  }
});

export default router;
