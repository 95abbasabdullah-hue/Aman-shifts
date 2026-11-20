import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import express, { type RequestHandler } from "express";
import ExcelJS from "exceljs";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  appUsersTable,
  auditLogsTable,
  db,
  departmentsTable,
  employeesTable,
  importJobsTable,
  rosterVersionsTable,
  shiftAssignmentsTable,
  shiftTypesTable,
  type AppUser,
} from "@workspace/db";
import type { ScheduleResponse, RosterVersion } from "@workspace/api-zod";
import { type AmanRequest } from "../lib/amanAuth";
import { normalizeShiftValue } from "../lib/shiftDefinitions";
import accountRouter from "./account";
import catalogRouter from "./catalog";
import { scheduleReadFailure, withScheduleReadErrors } from "./schedule";
import importsRouter from "./imports";
import scheduleRouter from "./schedule";

const rosterPeriod = {
  start: "2027-11-20",
  end: "2027-12-19",
  month: "2027-11",
};
const shiftCodes = ["D", "N", "AL", "OFF", "/"];

type TestSeed = {
  department: typeof departmentsTable.$inferSelect;
  employees: Array<typeof employeesTable.$inferSelect>;
  admin: AppUser;
  staff: AppUser;
  sourceVersion: typeof rosterVersionsTable.$inferSelect;
  importJob: typeof importJobsTable.$inferSelect;
  importedEmployeeIds: string[];
  importedShiftTypeIds: string[];
};

type ScheduleResult = {
  status: number;
  data: unknown;
};

function rosterDates(): string[] {
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(2027, 10, 20 + index));
    return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
  });
}

async function scheduleTableCounts() {
  const [versions, assignments, imports] = await Promise.all([
    db.select({ value: count() }).from(rosterVersionsTable),
    db.select({ value: count() }).from(shiftAssignmentsTable),
    db.select({ value: count() }).from(importJobsTable),
  ]);
  return {
    versions: Number(versions[0]?.value ?? 0),
    assignments: Number(assignments[0]?.value ?? 0),
    imports: Number(imports[0]?.value ?? 0),
  };
}

async function assignmentFingerprint(versionId: string): Promise<string> {
  const rows = await db
    .select({
      employeeId: shiftAssignmentsTable.employeeId,
      shiftTypeId: shiftAssignmentsTable.shiftTypeId,
      date: shiftAssignmentsTable.date,
      sourceRawShiftValue: shiftAssignmentsTable.sourceRawShiftValue,
    })
    .from(shiftAssignmentsTable)
    .where(eq(shiftAssignmentsTable.versionId, versionId))
    .orderBy(
      shiftAssignmentsTable.date,
      shiftAssignmentsTable.employeeId,
    );
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function seedSyntheticRoster(suffix: string): Promise<TestSeed> {
  const [department] = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.code, "ED"))
    .limit(1);
  assert.ok(department, "The Emergency department must be configured for tests");
  const references = await db
    .select({
      id: shiftTypesTable.id,
      code: shiftTypesTable.code,
      name: shiftTypesTable.name,
      category: shiftTypesTable.category,
      color: shiftTypesTable.color,
      displayCode: shiftTypesTable.displayCode,
      displayInCalendar: shiftTypesTable.displayInCalendar,
    })
    .from(shiftTypesTable)
    .where(
      and(
        inArray(shiftTypesTable.code, shiftCodes),
        eq(shiftTypesTable.active, true),
      ),
    );
  const shiftByCode = new Map(references.map((shift) => [shift.code, shift]));
  assert.ok(shiftCodes.every((code) => shiftByCode.has(code)), "required demo shift types must be configured");

  return db.transaction(async (tx) => {
    const employees = await tx
      .insert(employeesTable)
      .values([
        {
          employeeCode: `TEST-${suffix}-A`,
          fullName: `Synthetic Nurse Alpha ${suffix}`,
          jobTitle: "Registered Nurse",
          departmentId: department.id,
          active: true,
        },
        {
          employeeCode: `TEST-${suffix}-B`,
          fullName: `Synthetic Nurse Beta ${suffix}`,
          jobTitle: "Registered Nurse",
          departmentId: department.id,
          active: true,
        },
      ])
      .returning();
    const [admin] = await tx
      .insert(appUsersTable)
      .values({
        clerkUserId: `schedule-test-admin-${suffix}`,
        email: `schedule-admin-${suffix}@example.invalid`,
        fullName: "Synthetic Schedule Admin",
        role: "admin",
      })
      .returning();
    const [staff] = await tx
      .insert(appUsersTable)
      .values({
        clerkUserId: `schedule-test-staff-${suffix}`,
        email: `schedule-staff-${suffix}@example.invalid`,
        fullName: "Synthetic Schedule Staff",
        role: "staff",
        employeeId: employees[0]!.id,
        departmentId: department.id,
      })
      .returning();

    const [sourceVersion] = await tx
      .insert(rosterVersionsTable)
      .values({
        month: rosterPeriod.month,
        periodStart: rosterPeriod.start,
        periodEnd: rosterPeriod.end,
        versionNumber: 1,
        status: "published",
        createdBy: admin.id,
        publishedAt: new Date(),
        publishedBy: admin.id,
      })
      .returning();

    const oldCodes = ["N", "D", "OFF", "/", "AL"];
    const sourceAssignments = employees.flatMap((employee, employeeIndex) =>
      rosterDates().map((date, dayIndex) => {
        const code = oldCodes[(dayIndex + employeeIndex * 2) % oldCodes.length]!;
        const shift = shiftByCode.get(code)!;
        return {
          versionId: sourceVersion.id,
          employeeId: employee.id,
          shiftTypeId: shift.id,
          date,
          sourceEmployeeId: employee.employeeCode,
          sourceEmployeeName: employee.fullName,
          sourceDepartment: department.code,
          sourceRole: employee.jobTitle,
          sourceRawShiftValue: code,
          notes: null,
        };
      }),
    );
    await tx.insert(shiftAssignmentsTable).values(sourceAssignments);

    const records = employees.flatMap((employee, employeeIndex) =>
      rosterDates().map((date, dayIndex) => {
        const code = shiftCodes[(dayIndex + employeeIndex) % shiftCodes.length]!;
        const shift = shiftByCode.get(code)!;
        return {
          rowNumber: employeeIndex + 7,
          date,
          sourceEmployeeId: employee.employeeCode,
          sourceEmployeeName: employee.fullName,
          sourceDepartment: department.code,
          sourceRole: employee.jobTitle,
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          departmentId: department.id,
          shiftTypeId: shift.id,
          shiftCode: shift.displayCode ?? shift.code,
          rawShiftValue: code,
          shiftName: shift.name,
          valid: true,
        };
      }),
    );
    const [importJob] = await tx
      .insert(importJobsTable)
      .values({
        month: rosterPeriod.month,
        periodStart: rosterPeriod.start,
        periodEnd: rosterPeriod.end,
        status: "ready",
        detectedFormat: "wide",
        selectedWorksheet: "Synthetic cross-month schedule",
        uploadedBy: admin.id,
        rowCount: records.length,
        validCount: records.length,
        issueCount: 0,
        mapping: {
          format: "wide",
          employeeIdColumn: "C",
          employeeNameColumn: "B",
          employeeRoleColumn: "D",
        },
        preview: {
          columns: ["B", "C", "D"],
          records,
          issues: [],
          periodStart: rosterPeriod.start,
          periodEnd: rosterPeriod.end,
          selectedWorksheet: "Synthetic cross-month schedule",
          worksheetChoices: ["Synthetic cross-month schedule"],
        },
      })
      .returning();
    return {
      department,
      employees,
      admin,
      staff,
      sourceVersion,
      importJob,
      importedEmployeeIds: [],
      importedShiftTypeIds: [],
    };
  });
}

async function cleanupSyntheticRoster(seed: TestSeed): Promise<void> {
  const userIds = [seed.admin.id, seed.staff.id];
  await db.transaction(async (tx) => {
    await tx
      .delete(auditLogsTable)
      .where(inArray(auditLogsTable.actorUserId, userIds));
    await tx
      .delete(rosterVersionsTable)
      .where(eq(rosterVersionsTable.createdBy, seed.admin.id));
    await tx
      .delete(importJobsTable)
      .where(eq(importJobsTable.uploadedBy, seed.admin.id));
    await tx
      .delete(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    await tx
      .delete(employeesTable)
      .where(
        inArray(
          employeesTable.id,
          [...seed.employees.map((employee) => employee.id), ...seed.importedEmployeeIds],
        ),
      );
    if (seed.importedShiftTypeIds.length) {
      await tx
        .delete(shiftTypesTable)
        .where(inArray(shiftTypesTable.id, seed.importedShiftTypeIds));
    }
  });
}

function makeTestServer(seed: TestSeed) {
  const users = new Map<string, AppUser>([
    [seed.admin.id, seed.admin],
    [seed.staff.id, seed.staff],
  ]);
  const app = express();
  app.use(express.json());
  const testAuthentication: RequestHandler = async (req, res, next) => {
    Object.assign(req, { log: { warn() {}, error() {} } });
    const userId = req.header("x-synthetic-user");
    const user = userId ? users.get(userId) : undefined;
    if (!user) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    const [currentUser] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.id, user.id))
      .limit(1);
    (req as AmanRequest).amanUser = currentUser ?? user;
    next();
  };
  app.use(testAuthentication);
  app.use("/api", accountRouter);
  app.use("/api", importsRouter);
  app.use("/api", catalogRouter);
  app.use("/api", scheduleRouter);
  app.get(
    "/api/test/database-unavailable",
    withScheduleReadErrors(async () => {
      throw Object.assign(new Error("synthetic database outage"), { code: "08006" });
    }),
  );
  app.get(
    "/api/test/unexpected-runtime-error",
    withScheduleReadErrors(async () => {
      throw new TypeError("synthetic runtime failure");
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  return { server };
}

async function sendJson(
  baseUrl: string,
  path: string,
  userId: string | null,
  method = "GET",
  body?: unknown,
): Promise<ScheduleResult> {
  const headers: Record<string, string> = {};
  if (userId) headers["x-synthetic-user"] = userId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json(),
  };
}

async function sendWorkbook(
  baseUrl: string,
  userId: string,
  filename: string,
  content: Buffer,
): Promise<ScheduleResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(content)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
  const response = await fetch(`${baseUrl}/roster-imports/automatic`, {
    method: "POST",
    headers: { "x-synthetic-user": userId },
    body: form,
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json(),
  };
}

test("schedule reads and publication lifecycle preserve cross-month history", async (t) => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Schedule lifecycle tests must never run against production.");
  }
  const baseline = await scheduleTableCounts();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  let seed: TestSeed | null = null;
  let server: ReturnType<typeof makeTestServer>["server"] | null = null;

  try {
    seed = await seedSyntheticRoster(suffix);
    const listening = makeTestServer(seed);
    server = listening.server;
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    await t.test("links a signed-in account to one available employee", async () => {
      const [directoryOnlyEmployee] = await db
        .insert(employeesTable)
        .values({
          employeeCode: `TEST-${suffix}-NO-ROSTER`,
          fullName: `Directory-only employee ${suffix}`,
          jobTitle: "Registered Nurse",
          departmentId: seed!.department.id,
          active: true,
        })
        .returning({ id: employeesTable.id });
      seed!.importedEmployeeIds.push(directoryOnlyEmployee!.id);

      const options = await sendJson(
        baseUrl,
        "/employee-link-options",
        seed!.admin.id,
      );
      assert.equal(options.status, 200);
      const employees = options.data as Array<{
        id: string;
        fullName: string;
        departmentName: string;
      }>;
      assert.deepEqual(
        employees.map((employee) => employee.id),
        [seed!.employees[1]!.id],
        "only unlinked employees from the latest published workbook are offered",
      );
      assert.ok(
        !employees.some((employee) => employee.id === directoryOnlyEmployee!.id),
        "employees not present in the published Excel roster are not offered",
      );

      const alreadyClaimed = await sendJson(
        baseUrl,
        "/me/employee",
        seed!.admin.id,
        "PUT",
        { employeeId: seed!.employees[0]!.id },
      );
      assert.equal(alreadyClaimed.status, 409);

      const linked = await sendJson(
        baseUrl,
        "/me/employee",
        seed!.admin.id,
        "PUT",
        { employeeId: seed!.employees[1]!.id },
      );
      assert.equal(linked.status, 200);
      assert.equal(
        (linked.data as { employeeId: string }).employeeId,
        seed!.employees[1]!.id,
      );
      assert.equal(
        (linked.data as { employeeName: string }).employeeName,
        seed!.employees[1]!.fullName,
      );
      const linkedOptions = await sendJson(
        baseUrl,
        "/employee-link-options",
        seed!.admin.id,
      );
      assert.deepEqual(
        (linkedOptions.data as Array<{ id: string }>).map((option) => option.id),
        [seed!.employees[1]!.id],
      );
      const repeatedLink = await sendJson(
        baseUrl,
        "/me/employee",
        seed!.admin.id,
        "PUT",
        { employeeId: seed!.employees[1]!.id },
      );
      assert.equal(repeatedLink.status, 200);
      const differentLink = await sendJson(
        baseUrl,
        "/me/employee",
        seed!.admin.id,
        "PUT",
        { employeeId: seed!.employees[0]!.id },
      );
      assert.equal(differentLink.status, 409);

      const myNovemberShifts = await sendJson(
        baseUrl,
        "/schedule/mine?month=2027-11",
        seed!.admin.id,
      );
      assert.equal(myNovemberShifts.status, 200);
      const personalAssignments = (myNovemberShifts.data as ScheduleResponse).assignments;
      assert.equal(personalAssignments.length, 11);
      assert.ok(personalAssignments.every(
        (assignment) => assignment.employeeId === seed!.employees[1]!.id,
      ));

      const linkAudit = await db
        .select({ id: auditLogsTable.id })
        .from(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.actorUserId, seed!.admin.id),
            eq(auditLogsTable.action, "account.employee_linked"),
          ),
        );
      assert.ok(linkAudit.length > 0);
    });

    await t.test("distinguishes auth, empty periods, invalid months, and service failures", async () => {
      const unauthenticated = await sendJson(
        baseUrl,
        "/schedule/month?month=2098-04",
        null,
      );
      assert.equal(unauthenticated.status, 401);

      const empty = await sendJson(
        baseUrl,
        "/schedule/month?month=2098-04",
        seed!.staff.id,
      );
      assert.equal(empty.status, 200);
      const emptySchedule = empty.data as ScheduleResponse;
      assert.equal(emptySchedule.versionId, null);
      assert.deepEqual(emptySchedule.assignments, []);

      const invalid = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-13",
        seed!.staff.id,
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        (invalid.data as { code?: string }).code,
        "invalid_schedule_period",
      );
      assert.deepEqual(
        scheduleReadFailure(Object.assign(new Error("DB unavailable"), { code: "08006" })),
        {
          status: 503,
          body: {
            error: "Schedule data is temporarily unavailable. Try again shortly.",
            code: "schedule_database_unavailable",
          },
        },
      );
      assert.equal(
        scheduleReadFailure(new TypeError("unexpected runtime error")).body.code,
        "schedule_load_failed",
      );

      const databaseFailure = await sendJson(
        baseUrl,
        "/test/database-unavailable",
        seed!.staff.id,
      );
      assert.equal(databaseFailure.status, 503);
      assert.equal(
        (databaseFailure.data as { code?: string }).code,
        "schedule_database_unavailable",
      );
      const runtimeFailure = await sendJson(
        baseUrl,
        "/test/unexpected-runtime-error",
        seed!.staff.id,
      );
      assert.equal(runtimeFailure.status, 500);
      assert.equal(
        (runtimeFailure.data as { code?: string }).code,
        "schedule_load_failed",
      );
    });

    await t.test("exposes only Emergency and Intensive Care departments", async () => {
      const response = await sendJson(
        baseUrl,
        "/departments",
        seed!.staff.id,
      );
      assert.equal(response.status, 200);
      const rows = response.data as Array<{ code: string; name: string }>;
      assert.deepEqual(
        rows.map((department) => [department.code, department.name]),
        [
          ["ED", "Emergency"],
          ["ICU", "Intensive Care"],
        ],
      );
      const unsupported = await sendJson(
        baseUrl,
        "/departments",
        seed!.admin.id,
        "POST",
        { code: "HCA", name: "HCA", timezone: "Asia/Qatar" },
      );
      assert.equal(unsupported.status, 400);
    });

    await t.test("keeps a reviewed import as a draft until Admin publishes it", async () => {
      const confirm = await sendJson(
        baseUrl,
        `/roster-imports/${seed!.importJob.id}/confirm`,
        seed!.admin.id,
        "POST",
        { mode: "replace", publish: false },
      );
      assert.equal(confirm.status, 201);
      const draft = confirm.data as RosterVersion;
      assert.equal(draft.status, "draft");
      assert.equal(draft.periodStart, rosterPeriod.start);
      assert.equal(draft.periodEnd, rosterPeriod.end);

      const staffPublishAttempt = await sendJson(
        baseUrl,
        `/roster-versions/${draft.id}/publish`,
        seed!.staff.id,
        "POST",
      );
      assert.equal(staffPublishAttempt.status, 403);

      const staffView = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.staff.id,
      );
      assert.equal(staffView.status, 200);
      assert.equal(
        (staffView.data as ScheduleResponse).versionId,
        seed!.sourceVersion.id,
      );
      const adminView = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.admin.id,
      );
      assert.equal((adminView.data as ScheduleResponse).versionId, draft.id);

      const duplicate = await sendJson(
        baseUrl,
        `/roster-versions/${draft.id}/assignments`,
        seed!.admin.id,
        "POST",
        {
          date: rosterPeriod.start,
          employeeId: seed!.employees[0]!.id,
          shiftTypeId: (await db
            .select({ id: shiftTypesTable.id })
            .from(shiftTypesTable)
            .where(eq(shiftTypesTable.code, "D"))
            .limit(1))[0]!.id,
        },
      );
      assert.equal(duplicate.status, 409);

      const fullDraft = await sendJson(
        baseUrl,
        `/roster-versions/${draft.id}/schedule`,
        seed!.admin.id,
      );
      assert.equal(fullDraft.status, 200);
      const draftSchedule = fullDraft.data as ScheduleResponse;
      assert.equal(draftSchedule.assignments.length, 60);
      assert.equal(new Set(draftSchedule.assignments.map((item) => item.date)).size, 30);
      assert.ok(
        draftSchedule.assignments.some(
          (item) =>
            item.shiftCode === "OFF" &&
            item.shiftName === "Off Day" &&
            item.shiftColor === "#E0E0E0" &&
            item.category === "attendance" &&
            !item.isWorking,
        ),
      );
      const slashSource = await db
        .select({ id: shiftAssignmentsTable.id })
        .from(shiftAssignmentsTable)
        .where(
          and(
            eq(shiftAssignmentsTable.versionId, draft.id),
            eq(shiftAssignmentsTable.sourceRawShiftValue, "/"),
          ),
        )
        .limit(1);
      assert.ok(slashSource.length > 0, "the original slash remains stored for auditing");
      assert.ok(
        draftSchedule.assignments.some(
          (item) =>
            item.id === slashSource[0]!.id &&
            item.shiftCode === "/" &&
            item.shiftName === "Unresolved attendance status" &&
            item.shiftColor === "#E0E0E0",
        ),
        "slash attendance remains a separate non-working status",
      );
      assert.ok(
        draftSchedule.assignments.some(
          (item) => item.shiftCode === "OFF" && item.category === "attendance" && !item.isWorking,
        ),
      );
      assert.ok(
        draftSchedule.assignments.some(
          (item) => item.shiftCode === "D" && item.category === "working" && item.isWorking,
        ),
      );
    });

    await t.test("publishes and rolls back without losing month slices or history", async () => {
      const draftVersion = await db
        .select()
        .from(rosterVersionsTable)
        .where(
          and(
            eq(rosterVersionsTable.createdBy, seed!.admin.id),
            eq(rosterVersionsTable.status, "draft"),
          ),
        )
        .orderBy(rosterVersionsTable.createdAt);
      assert.equal(draftVersion.length, 1);
      const draftId = draftVersion[0]!.id;
      const originalAssignments = await assignmentFingerprint(seed!.sourceVersion.id);

      const publishedResult = await sendJson(
        baseUrl,
        `/roster-versions/${draftId}/publish`,
        seed!.admin.id,
        "POST",
      );
      assert.equal(publishedResult.status, 200);
      const published = publishedResult.data as RosterVersion;
      assert.equal(published.status, "published");

      const editableSchedule = await sendJson(
        baseUrl,
        `/roster-versions/${published.id}/schedule`,
        seed!.admin.id,
      );
      assert.equal(editableSchedule.status, 200);
      const editableAssignment = (editableSchedule.data as ScheduleResponse).assignments[0];
      assert.ok(editableAssignment);
      const manualEdit = await sendJson(
        baseUrl,
        `/roster-versions/${published.id}/assignments/${editableAssignment.id}`,
        seed!.admin.id,
        "PATCH",
        { notes: "Synthetic manual edit audit test" },
      );
      assert.equal(manualEdit.status, 200);
      const manualEditAudit = await db
        .select({ id: auditLogsTable.id })
        .from(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.actorUserId, seed!.admin.id),
            eq(auditLogsTable.action, "shift_assignment.updated"),
          ),
        );
      assert.ok(manualEditAudit.length > 0);

      const novemberResult = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.staff.id,
      );
      const decemberResult = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-12",
        seed!.staff.id,
      );
      const november = novemberResult.data as ScheduleResponse;
      const december = decemberResult.data as ScheduleResponse;
      assert.equal(november.versionId, published.id);
      assert.equal(december.versionId, published.id);
      assert.equal(november.assignments.length, 22);
      assert.equal(december.assignments.length, 38);
      assert.ok(november.assignments.every((item) => item.date.startsWith("2027-11-")));
      assert.ok(december.assignments.every((item) => item.date.startsWith("2027-12-")));

      const oldVersionAfterPublish = await db
        .select({ status: rosterVersionsTable.status })
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.id, seed!.sourceVersion.id))
        .limit(1);
      assert.equal(oldVersionAfterPublish[0]?.status, "archived");
      assert.equal(
        await assignmentFingerprint(seed!.sourceVersion.id),
        originalAssignments,
      );

      const rollbackResult = await sendJson(
        baseUrl,
        `/roster-versions/${seed!.sourceVersion.id}/rollback`,
        seed!.admin.id,
        "POST",
        { reason: "Synthetic schedule rollback check" },
      );
      assert.equal(rollbackResult.status, 201);
      const rollbackDraft = rollbackResult.data as RosterVersion;
      assert.equal(rollbackDraft.status, "draft");
      assert.equal(rollbackDraft.periodStart, rosterPeriod.start);
      assert.equal(rollbackDraft.periodEnd, rosterPeriod.end);
      assert.equal(
        await assignmentFingerprint(rollbackDraft.id),
        originalAssignments,
      );

      const rollbackPublishedResult = await sendJson(
        baseUrl,
        `/roster-versions/${rollbackDraft.id}/publish`,
        seed!.admin.id,
        "POST",
      );
      assert.equal(rollbackPublishedResult.status, 200);
      const rollbackPublished = rollbackPublishedResult.data as RosterVersion;
      assert.equal(rollbackPublished.status, "published");
      const historicalVersions = await db
        .select({ id: rosterVersionsTable.id, status: rosterVersionsTable.status })
        .from(rosterVersionsTable)
        .where(inArray(rosterVersionsTable.id, [
          seed!.sourceVersion.id,
          published.id,
          rollbackPublished.id,
        ]));
      assert.equal(historicalVersions.length, 3);
      assert.ok(
        historicalVersions.some(
          (version) => version.id === seed!.sourceVersion.id && version.status === "archived",
        ),
      );
      assert.ok(
        historicalVersions.some(
          (version) => version.id === published.id && version.status === "archived",
        ),
      );
      assert.ok(
        historicalVersions.some(
          (version) => version.id === rollbackPublished.id && version.status === "published",
        ),
      );
      assert.equal(
        await assignmentFingerprint(seed!.sourceVersion.id),
        originalAssignments,
      );

      const restoredNovember = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.staff.id,
      );
      const restoredDecember = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-12",
        seed!.staff.id,
      );
      assert.equal((restoredNovember.data as ScheduleResponse).versionId, rollbackPublished.id);
      assert.equal((restoredDecember.data as ScheduleResponse).versionId, rollbackPublished.id);
      assert.equal((restoredNovember.data as ScheduleResponse).assignments.length, 22);
      assert.equal((restoredDecember.data as ScheduleResponse).assignments.length, 38);
    });

    await t.test("deletes drafts and archived versions but protects the active roster", async () => {
      const [activeVersion] = await db
        .select()
        .from(rosterVersionsTable)
        .where(
          and(
            eq(rosterVersionsTable.createdBy, seed!.admin.id),
            eq(rosterVersionsTable.status, "published"),
          ),
        )
        .orderBy(rosterVersionsTable.createdAt);
      assert.ok(activeVersion);
      const activeFingerprint = await assignmentFingerprint(activeVersion.id);

      const staffAttempt = await sendJson(
        baseUrl,
        `/roster-versions/${activeVersion.id}`,
        seed!.staff.id,
        "DELETE",
      );
      assert.equal(staffAttempt.status, 403);
      const activeAttempt = await sendJson(
        baseUrl,
        `/roster-versions/${activeVersion.id}`,
        seed!.admin.id,
        "DELETE",
      );
      assert.equal(activeAttempt.status, 409);
      assert.equal(
        await assignmentFingerprint(activeVersion.id),
        activeFingerprint,
      );

      const archivedDelete = await sendJson(
        baseUrl,
        `/roster-versions/${seed!.sourceVersion.id}`,
        seed!.admin.id,
        "DELETE",
      );
      assert.equal(archivedDelete.status, 204);
      assert.equal(
        (await db
          .select({ id: rosterVersionsTable.id })
          .from(rosterVersionsTable)
          .where(eq(rosterVersionsTable.id, seed!.sourceVersion.id))).length,
        0,
      );
      assert.equal(
        (await db
          .select({ id: shiftAssignmentsTable.id })
          .from(shiftAssignmentsTable)
          .where(eq(shiftAssignmentsTable.versionId, seed!.sourceVersion.id))).length,
        0,
      );
      const deletionAudit = await db
        .select({ action: auditLogsTable.action, details: auditLogsTable.details })
        .from(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.actorUserId, seed!.admin.id),
            eq(auditLogsTable.action, "roster.version_deleted"),
          ),
        );
      assert.ok(
        deletionAudit.some(
          (entry) =>
            (entry.details as { versionId?: string }).versionId ===
            seed!.sourceVersion.id,
        ),
      );

      const draft = await sendJson(
        baseUrl,
        "/roster-versions",
        seed!.admin.id,
        "POST",
        { month: rosterPeriod.month, copyPublished: true },
      );
      assert.equal(draft.status, 201);
      const draftVersion = draft.data as RosterVersion;
      const draftAssignmentsBefore = await db
        .select({ id: shiftAssignmentsTable.id })
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.versionId, draftVersion.id));
      assert.equal(draftAssignmentsBefore.length, 60);
      const draftDelete = await sendJson(
        baseUrl,
        `/roster-versions/${draftVersion.id}`,
        seed!.admin.id,
        "DELETE",
      );
      assert.equal(draftDelete.status, 204);
      assert.equal(
        (await db
          .select({ id: shiftAssignmentsTable.id })
          .from(shiftAssignmentsTable)
          .where(eq(shiftAssignmentsTable.versionId, draftVersion.id))).length,
        0,
      );

      const activeSchedule = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.staff.id,
      );
      assert.equal(
        (activeSchedule.data as ScheduleResponse).versionId,
        activeVersion.id,
      );
      assert.equal(
        await assignmentFingerprint(activeVersion.id),
        activeFingerprint,
      );
    });

    await t.test("automatically imports, publishes, deduplicates, and safely rejects bad uploads", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
      const mysteryCode = `MYSTERY-${suffix}`;
      const workbook = new ExcelJS.Workbook();
      const history = workbook.addWorksheet("EDrev (3)");
      history.getCell("B4").value = "Employee Name";
      history.getCell("C4").value = "Employee ID";
      history.getCell("D4").value = "Role";
      for (let index = 0; index < 3; index += 1) {
        history.getCell(5, 5 + index).value = new Date(Date.UTC(2027, 9, 1 + index));
      }
      history.getCell("B7").value = "Historical test worker";
      history.getCell("C7").value = `HIST-${suffix}`;
      history.getCell("D7").value = "RN";
      history.getCell("E7").value = "D";

      const latest = workbook.addWorksheet("Current ED ICU");
      latest.getCell("B4").value = "Employee Name";
      latest.getCell("C4").value = "Employee ID";
      latest.getCell("D4").value = "Role";
      for (let index = 0; index < 3; index += 1) {
        latest.getCell(5, 5 + index).value = new Date(Date.UTC(2027, 10, 20 + index));
      }
      latest.getCell("A6").value = seed!.department.code;
      const rosterRows = [
        {
          row: 7,
          name: seed!.employees[0]!.fullName,
          id: seed!.employees[0]!.employeeCode,
          codes: ["D*", "N", "AL"],
        },
        {
          row: 8,
          name: seed!.employees[1]!.fullName,
          id: seed!.employees[1]!.employeeCode,
          codes: ["N*", "/", mysteryCode],
        },
        {
          row: 9,
          name: `Synthetic Nurse New ${suffix}`,
          id: `NEW-${suffix}`,
          codes: ["D1", "", "OFF"],
        },
      ];
      for (const person of rosterRows) {
        latest.getCell(person.row, 2).value = person.name;
        latest.getCell(person.row, 3).value = person.id;
        latest.getCell(person.row, 4).value = "Registered Nurse";
        person.codes.forEach((code, index) => {
          latest.getCell(person.row, 5 + index).value = code || null;
        });
      }
      const file = Buffer.from(await workbook.xlsx.writeBuffer());

      const uploaded = await sendWorkbook(
        baseUrl,
        seed!.admin.id,
        `automatic-${suffix}.xlsx`,
        file,
      );
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
      const imported = uploaded.data as {
        version: RosterVersion;
        employeeCount: number;
        newEmployeeCount: number;
        dateCount: number;
        assignmentCount: number;
        alreadyImported: boolean;
        import: { selectedWorksheet: string };
      };
      assert.equal(imported.version.status, "published");
      assert.equal(imported.employeeCount, 3);
      assert.equal(imported.newEmployeeCount, 1);
      assert.equal(imported.dateCount, 3);
      assert.equal(imported.assignmentCount, 9);
      assert.equal(imported.import.selectedWorksheet, "Current ED ICU");
      assert.equal(imported.alreadyImported, false);

      const importedEmployees = await db
        .select({ id: employeesTable.id, employeeCode: employeesTable.employeeCode })
        .from(employeesTable)
        .where(eq(employeesTable.employeeCode, `NEW-${suffix}`));
      assert.equal(importedEmployees.length, 1);
      seed!.importedEmployeeIds.push(importedEmployees[0]!.id);
      const autoAccounts = await db
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(eq(appUsersTable.employeeId, importedEmployees[0]!.id));
      assert.equal(autoAccounts.length, 0);

      const savedRows = (await db
        .select({
          date: shiftAssignmentsTable.date,
          employeeId: shiftAssignmentsTable.employeeId,
          shiftTypeId: shiftAssignmentsTable.shiftTypeId,
          raw: shiftAssignmentsTable.sourceRawShiftValue,
        })
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.versionId, imported.version.id)))
        .filter((row) => row.date <= "2027-11-22");
      assert.equal(savedRows.length, 9);
      assert.ok(savedRows.some((row) => row.raw === "D*"));
      assert.ok(savedRows.some((row) => row.raw === "N*"));
      assert.ok(savedRows.some((row) => row.raw === ""));

      const visible = await sendJson(
        baseUrl,
        `/roster-versions/${imported.version.id}/schedule`,
        seed!.admin.id,
      );
      assert.equal(visible.status, 200);
      const visibleSchedule = visible.data as ScheduleResponse;
      const uploadedPeriodAssignments = visibleSchedule.assignments.filter(
        (assignment) => assignment.date <= "2027-11-22",
      );
      assert.equal(uploadedPeriodAssignments.length, 9);
      assert.ok(uploadedPeriodAssignments.some((assignment) => assignment.shiftCode === "D"));
      assert.ok(uploadedPeriodAssignments.some((assignment) => assignment.shiftCode === "N"));
      const mysteryAssignment = uploadedPeriodAssignments.find(
        (assignment) => assignment.shiftCode === mysteryCode,
      );
      assert.ok(mysteryAssignment);
      assert.equal(mysteryAssignment.category, "attendance");
      assert.equal(mysteryAssignment.isWorking, false);
      const blankAssignment = uploadedPeriodAssignments.find(
        (assignment) => assignment.employeeCode === `NEW-${suffix}` &&
          assignment.date === "2027-11-21",
      );
      assert.ok(blankAssignment);
      assert.equal(blankAssignment.shiftCode, "OFF");
      const slashAssignment = uploadedPeriodAssignments.find(
        (assignment) =>
          assignment.employeeCode === seed!.employees[1]!.employeeCode &&
          assignment.date === "2027-11-21",
      );
      assert.ok(slashAssignment);
      assert.equal(slashAssignment.shiftCode, "/");
      assert.equal(slashAssignment.shiftName, "Unresolved attendance status");
      assert.equal(slashAssignment.shiftColor, "#E0E0E0");
      assert.ok(savedRows.some((row) => row.raw === "/"));
      const unknownType = await db
        .select({ id: shiftTypesTable.id })
        .from(shiftTypesTable)
        .where(eq(shiftTypesTable.displayCode, mysteryCode));
      seed!.importedShiftTypeIds.push(...unknownType.map((shift) => shift.id));

      const repeated = await sendWorkbook(
        baseUrl,
        seed!.admin.id,
        `automatic-${suffix}.xlsx`,
        file,
      );
      assert.equal(repeated.status, 200);
      const duplicate = repeated.data as { version: RosterVersion; alreadyImported: boolean };
      assert.equal(duplicate.alreadyImported, true);
      assert.equal(duplicate.version.id, imported.version.id);
      assert.equal(
        (
          await db
            .select({ id: rosterVersionsTable.id })
            .from(rosterVersionsTable)
            .where(eq(rosterVersionsTable.sourceImportId, imported.version.sourceImportId!))
        ).length,
        1,
      );

      const invalidUpload = await sendWorkbook(
        baseUrl,
        seed!.admin.id,
        `invalid-${suffix}.xlsx`,
        Buffer.from("not an Excel workbook"),
      );
      assert.equal(invalidUpload.status, 422);
      const stillActive = await sendJson(
        baseUrl,
        "/schedule/month?month=2027-11",
        seed!.staff.id,
      );
      assert.equal((stillActive.data as ScheduleResponse).versionId, imported.version.id);
    });
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (seed) await cleanupSyntheticRoster(seed);
    assert.deepEqual(await scheduleTableCounts(), baseline, "synthetic schedule rows must be removed after the test");
  }
});

test(
  "activates the reference workbook in development when explicitly authorized",
  { skip: process.env.AMAN_ACTIVATE_REFERENCE_WORKBOOK !== "1" },
  async () => {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Reference workbook activation tests must never run against production.");
    }
    const workbookPath = process.env.AMAN_ROSTER_WORKBOOK;
    assert.ok(workbookPath, "Set AMAN_ROSTER_WORKBOOK to the attached reference workbook.");
    const file = await readFile(workbookPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sourceSheet = workbook.getWorksheet("ED-ICU");
    assert.ok(sourceSheet, "The reference workbook must contain ED-ICU.");
    const [admin] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.role, "admin"))
      .limit(1);
    assert.ok(admin, "A development admin account is required to activate the reference roster.");
    const priorPublished = (await db
      .select()
      .from(rosterVersionsTable)
      .where(eq(rosterVersionsTable.status, "published")))
      .filter(
        (version) =>
          Boolean(version.periodStart && version.periodEnd) &&
          version.periodStart! <= "2026-12-19" &&
          version.periodEnd! >= "2026-11-20",
      );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { log: { warn() {}, error() {} } });
      (req as AmanRequest).amanUser = admin;
      next();
    });
    app.use("/api", importsRouter);
    app.use("/api", scheduleRouter);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    try {
      const uploaded = await sendWorkbook(
        baseUrl,
        admin.id,
        "ED-ICU-20-Nov-to-19-Dec.xlsx",
        file,
      );
      assert.ok(
        uploaded.status === 201 || uploaded.status === 200,
        JSON.stringify(uploaded.data),
      );
      const imported = uploaded.data as {
        version: RosterVersion;
        import: { id: string; selectedWorksheet: string };
        employeeCount: number;
        newEmployeeCount: number;
        dateCount: number;
        assignmentCount: number;
        alreadyImported: boolean;
        departmentCounts: Array<{
          departmentCode: string;
          departmentName: string;
          employeeCount: number;
        }>;
      };
      assert.equal(imported.version.status, "published");
      assert.equal(imported.import.selectedWorksheet, "ED-ICU");
      assert.equal(imported.employeeCount, 20);
      assert.equal(imported.dateCount, 30);
      assert.equal(imported.assignmentCount, 600);
      assert.equal(imported.alreadyImported, uploaded.status === 200);
      assert.deepEqual(
        imported.departmentCounts.map((department) => [
          department.departmentCode,
          department.departmentName,
          department.employeeCount,
        ]),
        [
          ["ED", "Emergency", 14],
          ["ICU", "Intensive Care", 6],
        ],
      );

      const targetRows = (await db
        .select({
          date: shiftAssignmentsTable.date,
          sourceEmployeeId: shiftAssignmentsTable.sourceEmployeeId,
          sourceEmployeeName: shiftAssignmentsTable.sourceEmployeeName,
          raw: shiftAssignmentsTable.sourceRawShiftValue,
          normalizedCode: shiftTypesTable.code,
          displayCode: shiftTypesTable.displayCode,
        })
        .from(shiftAssignmentsTable)
        .innerJoin(
          shiftTypesTable,
          eq(shiftTypesTable.id, shiftAssignmentsTable.shiftTypeId),
        )
        .where(eq(shiftAssignmentsTable.versionId, imported.version.id)))
        .filter((assignment) =>
          assignment.date >= "2026-11-20" && assignment.date <= "2026-12-19",
        );
      assert.equal(targetRows.length, 600);
      const cellByIdentityAndDate = new Map(
        targetRows.map((assignment) => [
          `${assignment.sourceEmployeeId || assignment.sourceEmployeeName}|${assignment.date}`,
          assignment,
        ]),
      );
      const dates = Array.from({ length: 30 }, (_, index) => {
        const value = sourceSheet.getRow(5).getCell(5 + index).value;
        assert.ok(value instanceof Date);
        return value.toISOString().slice(0, 10);
      });
      const sourceRows = [
        ...Array.from({ length: 13 }, (_, index) => 7 + index),
        ...Array.from({ length: 6 }, (_, index) => 24 + index),
        34,
      ];
      const sourceRawCounts = new Map<string, number>();
      const normalizedCounts = new Map<string, number>();
      const rawText = (value: ExcelJS.CellValue): string => {
        if (value == null) return "";
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return String(value);
        }
        if (typeof value === "object") {
          if ("result" in value) return rawText(value.result as ExcelJS.CellValue);
          if ("text" in value && typeof value.text === "string") return value.text;
          if ("richText" in value && Array.isArray(value.richText)) {
            return value.richText.map((part) => part.text).join("");
          }
        }
        return "";
      };
      for (const rowNumber of sourceRows) {
        const sourceId = rawText(sourceSheet.getRow(rowNumber).getCell(3).value).trim();
        const sourceName = rawText(sourceSheet.getRow(rowNumber).getCell(2).value);
        const identity = sourceId || sourceName;
        for (let index = 0; index < dates.length; index += 1) {
          const raw = rawText(sourceSheet.getRow(rowNumber).getCell(5 + index).value);
          const assignment = cellByIdentityAndDate.get(`${identity}|${dates[index]}`);
          assert.ok(
            assignment,
            `Imported cell at source row ${rowNumber}, ${dates[index]} exists.`,
          );
          assert.equal(assignment.raw, raw);
          sourceRawCounts.set(raw, (sourceRawCounts.get(raw) ?? 0) + 1);
          const normalized = normalizeShiftValue(raw);
          normalizedCounts.set(
            normalized,
            (normalizedCounts.get(normalized) ?? 0) + 1,
          );
          if (raw === "D*") {
            assert.equal(assignment.normalizedCode, "D");
            assert.equal(assignment.displayCode, "D");
          }
          if (raw === "N*") {
            assert.equal(assignment.normalizedCode, "N");
            assert.equal(assignment.displayCode, "N");
          }
          if (!raw.trim()) {
            assert.equal(assignment.normalizedCode, "OFF");
            assert.equal(assignment.displayCode, "OFF");
          }
        }
      }
      assert.equal(
        targetRows.filter((assignment) => assignment.raw?.trim()).length,
        496,
      );
      assert.equal(targetRows.filter((assignment) => !assignment.raw?.trim()).length, 104);

      const completeVersion = await sendJson(
        baseUrl,
        `/roster-versions/${imported.version.id}/schedule`,
        admin.id,
      );
      assert.equal(completeVersion.status, 200);
      const importedAssignments = (completeVersion.data as ScheduleResponse).assignments
        .filter(
          (assignment) =>
            assignment.date >= "2026-11-20" &&
            assignment.date <= "2026-12-19",
        );
      assert.equal(importedAssignments.length, 600);
      assert.equal(new Set(importedAssignments.map((item) => item.date)).size, 30);
      for (const date of dates) {
        const dailyAssignments = importedAssignments.filter(
          (item) => item.date === date,
        );
        assert.equal(
          dailyAssignments.length,
          20,
          `all 20 employees remain available on ${date}`,
        );
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(
              dailyAssignments.reduce<Record<string, number>>((counts, item) => {
                counts[item.departmentName] =
                  (counts[item.departmentName] ?? 0) + 1;
                return counts;
              }, {}),
            ).sort(([left], [right]) => left.localeCompare(right)),
          ),
          { Emergency: 14, "Intensive Care": 6 },
        );
      }
      assert.equal(
        importedAssignments.filter((item) => item.shiftCode === "OFF").length,
        (sourceRawCounts.get("") ?? 0) +
          (sourceRawCounts.get("OFF") ?? 0),
      );
      assert.ok((sourceRawCounts.get("/") ?? 0) > 0);
      assert.ok(
        importedAssignments.some(
          (item) =>
            item.shiftCode === "/" &&
            item.category === "attendance" &&
            !item.isWorking,
        ),
        "slash values remain a separate non-working status",
      );
      assert.equal(
        importedAssignments.filter((item) => item.shiftCode === "/").length,
        sourceRawCounts.get("/") ?? 0,
      );
      const attendanceDefinitions = new Map([
        ["EL", ["Educational Leave", "#D1C4E9"]],
        ["AL", ["Annual Leave", "#C5E1A5"]],
        ["CL", ["Casual Leave", "#FFF59D"]],
        ["R", ["Requested Off", "#616161"]],
        ["OFF", ["Off Day", "#E0E0E0"]],
        ["/", ["Unresolved attendance status", "#E0E0E0"]],
      ]);
      for (const [code, [description, color]] of attendanceDefinitions) {
        const assignment = importedAssignments.find(
          (item) => item.shiftCode === code,
        );
        assert.ok(assignment, `${code} is available in the imported schedule`);
        assert.equal(assignment.shiftName, description);
        assert.equal(assignment.shiftColor, color);
        assert.equal(assignment.category, "attendance");
        assert.equal(assignment.isWorking, false);
      }
      assert.ok(
        importedAssignments
          .filter((assignment) => assignment.category === "attendance")
          .every((assignment) => !assignment.isWorking),
        "leave, unresolved, and off-day codes do not count as on duty",
      );
      for (const [code, color] of [
        ["D", "#1976D2"],
        ["N", "#FBC02D"],
        ["M", "#43A047"],
      ]) {
        const assignment = importedAssignments.find(
          (item) => item.shiftCode === code,
        );
        assert.ok(assignment);
        assert.equal(assignment.shiftColor, color);
        assert.equal(assignment.isWorking, true);
      }

      const departmentRows = await db
        .select({
          departmentCode: departmentsTable.code,
          employeeId: employeesTable.id,
          jobTitle: employeesTable.jobTitle,
          sourceRole: shiftAssignmentsTable.sourceRole,
          date: shiftAssignmentsTable.date,
        })
        .from(shiftAssignmentsTable)
        .innerJoin(
          employeesTable,
          eq(employeesTable.id, shiftAssignmentsTable.employeeId),
        )
        .innerJoin(
          departmentsTable,
          eq(departmentsTable.id, employeesTable.departmentId),
        )
        .where(eq(shiftAssignmentsTable.versionId, imported.version.id));
      const departmentStaff = new Map<string, Set<string>>();
      for (const row of departmentRows) {
        if (
          row.date >= "2026-11-20" &&
          row.date <= "2026-12-19" &&
          (row.departmentCode === "ED" || row.departmentCode === "ICU")
        ) {
          const employees = departmentStaff.get(row.departmentCode) ?? new Set<string>();
          employees.add(row.employeeId);
          departmentStaff.set(row.departmentCode, employees);
        }
      }
      assert.deepEqual(
        Object.fromEntries(
          [...departmentStaff.entries()].map(([code, employees]) => [code, employees.size]),
        ),
        { ED: 14, ICU: 6 },
      );
      assert.equal(
        [...departmentStaff.values()].reduce((total, employees) => total + employees.size, 0),
        20,
      );
      const hcaEmployeeRows = departmentRows.filter(
        (row) =>
          row.date >= "2026-11-20" &&
          row.date <= "2026-12-19" &&
          row.sourceRole === "HCA",
      );
      assert.equal(new Set(hcaEmployeeRows.map((row) => row.employeeId)).size, 1);
      assert.ok(hcaEmployeeRows.every((row) => row.departmentCode === "ED"));
      assert.ok(hcaEmployeeRows.every((row) => row.jobTitle === "Healthcare Assistant"));

      const november = await sendJson(
        baseUrl,
        "/schedule/month?month=2026-11",
        admin.id,
      );
      const december = await sendJson(
        baseUrl,
        "/schedule/month?month=2026-12",
        admin.id,
      );
      assert.equal((november.data as ScheduleResponse).versionId, imported.version.id);
      assert.equal((december.data as ScheduleResponse).versionId, imported.version.id);
      assert.equal(
        (november.data as ScheduleResponse).assignments.filter(
          (assignment) => assignment.date >= "2026-11-20",
        ).length,
        220,
      );
      assert.equal(
        (december.data as ScheduleResponse).assignments.filter(
          (assignment) => assignment.date <= "2026-12-19",
        ).length,
        380,
      );

      if (!imported.alreadyImported) {
        for (const previous of priorPublished) {
          const [archived] = await db
            .select({ status: rosterVersionsTable.status })
            .from(rosterVersionsTable)
            .where(eq(rosterVersionsTable.id, previous.id))
            .limit(1);
          assert.equal(archived?.status, "archived");
        }
      }

      const repeated = await sendWorkbook(
        baseUrl,
        admin.id,
        "ED-ICU-20-Nov-to-19-Dec.xlsx",
        file,
      );
      assert.equal(repeated.status, 200);
      assert.equal(
        (repeated.data as { version: RosterVersion; alreadyImported: boolean }).alreadyImported,
        true,
      );
      assert.equal(
        (repeated.data as { version: RosterVersion }).version.id,
        imported.version.id,
      );

      const invalid = await sendWorkbook(
        baseUrl,
        admin.id,
        "invalid-reference.xlsx",
        Buffer.from("invalid workbook data"),
      );
      assert.equal(invalid.status, 422);
      const stillPublished = await sendJson(
        baseUrl,
        "/schedule/month?month=2026-11",
        admin.id,
      );
      assert.equal(
        (stillPublished.data as ScheduleResponse).versionId,
        imported.version.id,
      );
      console.log(
        "REFERENCE_AUTO_IMPORT_RESULT",
        JSON.stringify({
          result: "PASS",
          sheet: imported.import.selectedWorksheet,
          employees: imported.employeeCount,
          departments: Object.fromEntries(
            [...departmentStaff.entries()].map(([code, employees]) => [code, employees.size]),
          ),
          dates: imported.dateCount,
          cells: targetRows.length,
          all20StaffPerDate: true,
          nonempty: 496,
          blank: 104,
          rawCodes: Object.fromEntries(
            [...sourceRawCounts.entries()]
              .filter(([code]) => code.trim())
              .sort((a, b) => a[0].localeCompare(b[0])),
          ),
          normalizedCodes: Object.fromEntries(
            [...normalizedCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
          ),
          repeatUpload: "no duplicate",
          invalidUpload: "previous version preserved",
        }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
