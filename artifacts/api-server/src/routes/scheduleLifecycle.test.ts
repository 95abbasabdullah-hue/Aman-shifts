import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express, { type RequestHandler } from "express";
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
    const [department] = await tx
      .insert(departmentsTable)
      .values({
        code: `TEST-${suffix}`,
        name: `Synthetic test team ${suffix}`,
        timezone: "Asia/Qatar",
        active: true,
      })
      .returning();
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
    return { department, employees, admin, staff, sourceVersion, importJob };
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
      .where(inArray(employeesTable.id, seed.employees.map((employee) => employee.id)));
    await tx
      .delete(departmentsTable)
      .where(eq(departmentsTable.id, seed.department.id));
  });
}

function makeTestServer(seed: TestSeed) {
  const users = new Map<string, AppUser>([
    [seed.admin.id, seed.admin],
    [seed.staff.id, seed.staff],
  ]);
  const app = express();
  app.use(express.json());
  const testAuthentication: RequestHandler = (req, res, next) => {
    Object.assign(req, { log: { warn() {}, error() {} } });
    const userId = req.header("x-synthetic-user");
    const user = userId ? users.get(userId) : undefined;
    if (!user) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    (req as AmanRequest).amanUser = user;
    next();
  };
  app.use(testAuthentication);
  app.use("/api", importsRouter);
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
          (item) => item.shiftCode === "/" && item.category === "attendance" && !item.isWorking,
        ),
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
