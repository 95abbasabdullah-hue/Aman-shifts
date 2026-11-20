import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import express, { type RequestHandler } from "express";
import type { ImportPreview } from "@workspace/api-zod";
import {
  db,
  importJobsTable,
  rosterVersionsTable,
  shiftAssignmentsTable,
} from "@workspace/db";
import { DEFAULT_SHIFT_DEFINITIONS } from "../lib/shiftDefinitions";
import { requireAdmin, type AmanRequest } from "../lib/amanAuth";
import {
  createRosterPreviewRouter,
  type RosterPreviewRepository,
} from "./imports";

const referenceWorkbook = process.env.AMAN_REFERENCE_WORKBOOK
  ? path.resolve(process.env.AMAN_REFERENCE_WORKBOOK)
  : null;
const sheetNames = ["ED-ICU", "EDrev"];

function createTestRepository() {
  const jobs: Array<typeof importJobsTable.$inferSelect> = [];
  let auditCount = 0;
  const departments = [
    { id: randomUUID(), code: "ED", name: "Emergency Department" },
    { id: randomUUID(), code: "ICU", name: "Intensive Care Unit" },
    { id: randomUUID(), code: "HCA", name: "Health Care Assistant" },
  ];
  const repository: RosterPreviewRepository = {
    async loadReferenceData() {
      return {
        employees: [],
        departments,
        shiftTypes: DEFAULT_SHIFT_DEFINITIONS.map((definition) => ({
          id: randomUUID(),
          code: definition.code,
          name: definition.name,
          category: definition.category,
          displayCode: definition.displayCode,
        })),
      };
    },
    async createImportJob(values) {
      const job = {
        id: randomUUID(),
        month: values.month,
        periodStart: values.periodStart ?? null,
        periodEnd: values.periodEnd ?? null,
        status: values.status ?? "needs_review",
        detectedFormat: values.detectedFormat ?? "unknown",
        selectedWorksheet: values.selectedWorksheet ?? null,
        uploadedBy: values.uploadedBy,
        uploadedAt: new Date(),
        rowCount: values.rowCount ?? 0,
        validCount: values.validCount ?? 0,
        issueCount: values.issueCount ?? 0,
        mapping: values.mapping ?? {},
        preview: values.preview ?? {},
        createdVersionId: values.createdVersionId ?? null,
      } satisfies typeof importJobsTable.$inferSelect;
      jobs.push(job);
      return job;
    },
    async writeAuditLog() {
      auditCount += 1;
    },
  };
  return {
    repository,
    jobs,
    get auditCount() {
      return auditCount;
    },
  };
}

async function makeCompetingWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const name of sheetNames) {
    const worksheet = workbook.addWorksheet(name);
    const header = worksheet.getRow(5);
    header.getCell(2).value = "Employee Name";
    header.getCell(3).value = "Employee ID";
    header.getCell(4).value = "Role";
    const employee = worksheet.getRow(6);
    employee.getCell(2).value = "Preview Test Employee";
    employee.getCell(3).value = `TEST-${name}`;
    employee.getCell(4).value = "RN";
    for (let day = 0; day < 10; day += 1) {
      const date = new Date(Date.UTC(2026, 10, 20 + day));
      header.getCell(5 + day).value = date;
      employee.getCell(5 + day).value = "D";
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function makeForm(
  fileBytes: Buffer,
  fileName: string,
  mapping?: Record<string, unknown>,
): FormData {
  const form = new FormData();
  const fileData = new Uint8Array(fileBytes.byteLength);
  fileData.set(fileBytes);
  form.append(
    "file",
    new Blob([fileData.buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    fileName,
  );
  form.append("month", "2026-11");
  if (mapping) form.append("mappingJson", JSON.stringify(mapping));
  return form;
}

async function scheduleSnapshot() {
  const [versions, assignments] = await Promise.all([
    db
      .select({
        id: rosterVersionsTable.id,
        month: rosterVersionsTable.month,
        periodStart: rosterVersionsTable.periodStart,
        periodEnd: rosterVersionsTable.periodEnd,
        versionNumber: rosterVersionsTable.versionNumber,
        status: rosterVersionsTable.status,
        sourceImportId: rosterVersionsTable.sourceImportId,
        publishedAt: rosterVersionsTable.publishedAt,
        publishedBy: rosterVersionsTable.publishedBy,
      })
      .from(rosterVersionsTable)
      .orderBy(rosterVersionsTable.id),
    db
      .select({
        id: shiftAssignmentsTable.id,
        versionId: shiftAssignmentsTable.versionId,
        employeeId: shiftAssignmentsTable.employeeId,
        shiftTypeId: shiftAssignmentsTable.shiftTypeId,
        date: shiftAssignmentsTable.date,
        sourceEmployeeId: shiftAssignmentsTable.sourceEmployeeId,
        sourceDepartment: shiftAssignmentsTable.sourceDepartment,
        sourceRole: shiftAssignmentsTable.sourceRole,
        sourceRawShiftValue: shiftAssignmentsTable.sourceRawShiftValue,
      })
      .from(shiftAssignmentsTable)
      .orderBy(shiftAssignmentsTable.id),
  ]);
  const digest = createHash("sha256")
    .update(JSON.stringify({ versions, assignments }))
    .digest("hex");
  return {
    versionCount: versions.length,
    assignmentCount: assignments.length,
    digest,
  };
}

test("authenticated multipart roster previews are repeatable and read-only", async (t) => {
  const app = express();
  const testPrincipal: RequestHandler = (req, _res, next) => {
    Object.assign(req, { log: { warn() {}, error() {} } });
    if (req.header("x-preview-test-auth") === "admin") {
      (req as AmanRequest).amanUser = {
        id: randomUUID(),
        clerkUserId: "test-preview-admin",
        email: "preview-admin@example.invalid",
        fullName: "Preview Test Admin",
        role: "admin",
        departmentId: null,
        employeeId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    next();
  };
  const testData = createTestRepository();
  app.use(testPrincipal);
  app.use(
    "/api",
    createRosterPreviewRouter({
      repository: testData.repository,
      adminMiddleware: requireAdmin,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/roster-imports/preview`;
  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

  try {
    await t.test("rejects requests without an authenticated admin", async () => {
      const denied = await fetch(endpoint, {
        method: "POST",
        body: makeForm(await makeCompetingWorkbook(), "competing.xlsx"),
      });
      assert.equal(denied.status, 403);
      const result = (await denied.json()) as { error?: string };
      assert.match(result.error ?? "", /administrator/i);
    });

    await t.test("returns a clear format error without losing server context", async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "x-preview-test-auth": "admin" },
        body: makeForm(Buffer.from("not an Excel file"), "roster.csv"),
      });
      assert.equal(response.status, 415);
      const result = (await response.json()) as { error?: string };
      assert.match(result.error ?? "", /\.xlsx/i);
    });

    await t.test("lets an admin choose between competing latest sheets", async () => {
      const workbook = await makeCompetingWorkbook();
      const unresolvedResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "x-preview-test-auth": "admin" },
        body: makeForm(workbook, "competing.xlsx"),
      });
      assert.equal(unresolvedResponse.status, 201);
      const unresolved = (await unresolvedResponse.json()) as ImportPreview;
      assert.deepEqual([...unresolved.worksheetChoices].sort(), [...sheetNames].sort());
      assert.equal(unresolved.selectedWorksheet, null);
      assert.equal(unresolved.records.length, 0);
      assert.ok(unresolved.issues.some((issue) => issue.code === "competing_schedules"));

      const selectedResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "x-preview-test-auth": "admin" },
        body: makeForm(workbook, "competing.xlsx", {
          format: "auto",
          employeeIdColumn: null,
          employeeNameColumn: null,
          employeeRoleColumn: null,
          departmentColumn: null,
          dateColumn: null,
          shiftCodeColumn: null,
          worksheetName: "ED-ICU",
        }),
      });
      assert.equal(selectedResponse.status, 201);
      const selected = (await selectedResponse.json()) as ImportPreview;
      assert.equal(selected.selectedWorksheet, "ED-ICU");
      assert.equal(selected.records.length, 10);
    });

    await t.test(
      "previews and retries the real ED-ICU workbook without schedule writes",
      { skip: !referenceWorkbook },
      async () => {
        const fileBytes = await readFile(referenceWorkbook!);
        const before = await scheduleSnapshot();

        const firstResponse = await fetch(endpoint, {
          method: "POST",
          headers: { "x-preview-test-auth": "admin" },
          body: makeForm(
            fileBytes,
            "ED- ICU 20 Nov to 19 Dec (1) - Copy.xlsx",
          ),
        });
        assert.equal(firstResponse.status, 201);
        const first = (await firstResponse.json()) as ImportPreview;
        assert.equal(first.selectedWorksheet, "ED-ICU");
        assert.equal(first.periodStart, "2026-11-20");
        assert.equal(first.periodEnd, "2026-12-19");
        assert.equal(first.records.length, 600);
        assert.equal(first.import.rowCount, 600);
        assert.equal(first.import.createdVersionId, null);
        assert.deepEqual(await scheduleSnapshot(), before);

        const retryResponse = await fetch(endpoint, {
          method: "POST",
          headers: { "x-preview-test-auth": "admin" },
          body: makeForm(
            fileBytes,
            "ED- ICU 20 Nov to 19 Dec (1) - Copy.xlsx",
          ),
        });
        assert.equal(retryResponse.status, 201);
        const retry = (await retryResponse.json()) as ImportPreview;
        assert.equal(retry.records.length, 600);
        assert.notEqual(retry.import.id, first.import.id);
        assert.deepEqual(await scheduleSnapshot(), before);
      },
    );
  } finally {
    await closeServer();
  }
});
