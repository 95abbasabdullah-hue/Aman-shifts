import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ConfirmRosterImportBody,
  ConfirmRosterImportParams,
  ConfirmRosterImportResponse,
  ListRosterImportsResponse,
  PreviewRosterImportBody,
  PreviewRosterImportResponse,
  ResolveRosterImportBody,
  ResolveRosterImportParams,
  ResolveRosterImportResponse,
} from "@workspace/api-zod";
import type {
  ImportMapping,
  ImportPreview,
  RosterVersion,
  StagedAssignment,
} from "@workspace/api-zod";
import {
  appUsersTable,
  auditLogsTable,
  db,
  departmentsTable,
  employeeAliasesTable,
  employeesTable,
  importJobsTable,
  rosterVersionsTable,
  shiftAssignmentsTable,
  shiftTypesTable,
} from "@workspace/db";
import { currentAppUser, requireAdmin } from "../lib/amanAuth";
import { writeAuditLog } from "../lib/audit";
import {
  parseRosterWorkbook,
  type DepartmentReference,
  type EmployeeReference,
  type ShiftReference,
} from "../lib/rosterImportParser";
import {
  normalizeEmployeeName,
  validateNewEmployeeRegistrations,
} from "../lib/employeeIdentity";
import { normalizeShiftValue } from "../lib/shiftDefinitions";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const uploadWorkbook: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const message =
      error instanceof Error && error.message.includes("File too large")
        ? "Workbook must be 10 MB or smaller"
        : "The workbook upload is invalid";
    res.status(400).json({ error: message });
  });
};

const mappingJsonSchema = z.object({
  format: z.enum(["auto", "wide", "long"]).default("auto"),
  employeeIdColumn: z.string().nullable().default(null),
  employeeNameColumn: z.string().nullable().default(null),
  employeeRoleColumn: z.string().nullable().default(null),
  departmentColumn: z.string().nullable().default(null),
  dateColumn: z.string().nullable().default(null),
  shiftCodeColumn: z.string().nullable().default(null),
  worksheetName: z.string().nullable().default(null),
});

const emptyMapping: ImportMapping = {
  format: "auto",
  employeeIdColumn: null,
  employeeNameColumn: null,
  employeeRoleColumn: null,
  departmentColumn: null,
  dateColumn: null,
  shiftCodeColumn: null,
  worksheetName: null,
};

type StoredPreview = Pick<
  ImportPreview,
  | "columns"
  | "records"
  | "issues"
  | "periodStart"
  | "periodEnd"
  | "selectedWorksheet"
  | "worksheetChoices"
>;

function periodForMonth(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function periodForVersion(
  version: typeof rosterVersionsTable.$inferSelect,
): { start: string; end: string } {
  const fallback = periodForMonth(version.month);
  return {
    start: version.periodStart ?? fallback.start,
    end: version.periodEnd ?? fallback.end,
  };
}

function periodsOverlap(
  left: { start: string; end: string },
  right: { start: string; end: string },
): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function readStoredPreview(value: Record<string, unknown>): StoredPreview {
  const preview = value as Partial<StoredPreview>;
  return {
    columns: Array.isArray(preview.columns) ? (preview.columns as string[]) : [],
    records: Array.isArray(preview.records)
      ? (preview.records as StagedAssignment[])
      : [],
    issues: Array.isArray(preview.issues)
      ? (preview.issues as ImportPreview["issues"])
      : [],
    periodStart: typeof preview.periodStart === "string" ? preview.periodStart : null,
    periodEnd: typeof preview.periodEnd === "string" ? preview.periodEnd : null,
    selectedWorksheet:
      typeof preview.selectedWorksheet === "string" ? preview.selectedWorksheet : null,
    worksheetChoices: Array.isArray(preview.worksheetChoices)
      ? (preview.worksheetChoices as string[])
      : [],
  };
}

async function importResponse(
  job: typeof importJobsTable.$inferSelect,
  knownUploaderName?: string,
) {
  let uploaderName = knownUploaderName;
  if (!uploaderName) {
    const [uploader] = await db
      .select({ fullName: appUsersTable.fullName })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, job.uploadedBy))
      .limit(1);
    uploaderName = uploader?.fullName;
  }
  return {
    id: job.id,
    month: job.month,
    periodStart: job.periodStart,
    periodEnd: job.periodEnd,
    selectedWorksheet: job.selectedWorksheet,
    status: job.status,
    uploadedByName: uploaderName ?? "Aman admin",
    uploadedAt: job.uploadedAt.toISOString(),
    detectedFormat: job.detectedFormat,
    rowCount: job.rowCount,
    validCount: job.validCount,
    issueCount: job.issueCount,
    createdVersionId: job.createdVersionId,
  };
}

async function previewResponse(
  job: typeof importJobsTable.$inferSelect,
  uploaderName?: string,
): Promise<ImportPreview> {
  return PreviewRosterImportResponse.parse({
    import: await importResponse(job, uploaderName),
    columns: readStoredPreview(job.preview).columns,
    mapping: job.mapping,
    periodStart: job.periodStart ?? readStoredPreview(job.preview).periodStart,
    periodEnd: job.periodEnd ?? readStoredPreview(job.preview).periodEnd,
    selectedWorksheet:
      job.selectedWorksheet ?? readStoredPreview(job.preview).selectedWorksheet,
    worksheetChoices: readStoredPreview(job.preview).worksheetChoices,
    records: readStoredPreview(job.preview).records,
    issues: readStoredPreview(job.preview).issues,
  });
}

type PreviewReferenceData = {
  employees: EmployeeReference[];
  shiftTypes: ShiftReference[];
  departments: DepartmentReference[];
};

export type RosterPreviewRepository = {
  loadReferenceData: () => Promise<PreviewReferenceData>;
  createImportJob: (
    values: typeof importJobsTable.$inferInsert,
  ) => Promise<typeof importJobsTable.$inferSelect>;
  writeAuditLog: (input: Parameters<typeof writeAuditLog>[0]) => Promise<void>;
};

const databaseRosterPreviewRepository: RosterPreviewRepository = {
  async loadReferenceData() {
    const [employees, employeeAliases, shiftTypes, departments] =
      await Promise.all([
        db
          .select({
            id: employeesTable.id,
            employeeCode: employeesTable.employeeCode,
            fullName: employeesTable.fullName,
            departmentId: employeesTable.departmentId,
          })
          .from(employeesTable)
          .where(eq(employeesTable.active, true)),
        db
          .select({
            employeeId: employeeAliasesTable.employeeId,
            alias: employeeAliasesTable.alias,
          })
          .from(employeeAliasesTable),
        db
          .select({
            id: shiftTypesTable.id,
            code: shiftTypesTable.code,
            name: shiftTypesTable.name,
            category: shiftTypesTable.category,
            displayCode: shiftTypesTable.displayCode,
          })
          .from(shiftTypesTable)
          .where(eq(shiftTypesTable.active, true)),
        db
          .select({
            id: departmentsTable.id,
            code: departmentsTable.code,
            name: departmentsTable.name,
          })
          .from(departmentsTable)
          .where(eq(departmentsTable.active, true)),
      ]);
    const aliasesByEmployee = new Map<string, string[]>();
    for (const alias of employeeAliases) {
      const aliases = aliasesByEmployee.get(alias.employeeId) ?? [];
      aliases.push(alias.alias);
      aliasesByEmployee.set(alias.employeeId, aliases);
    }
    return {
      employees: employees.map((employee) => ({
        ...employee,
        aliases: aliasesByEmployee.get(employee.id) ?? [],
      })),
      shiftTypes,
      departments,
    };
  },
  async createImportJob(values) {
    const [job] = await db.insert(importJobsTable).values(values).returning();
    return job;
  },
  writeAuditLog,
};

export function createRosterPreviewRouter(
  options: {
    repository?: RosterPreviewRepository;
    adminMiddleware?: RequestHandler;
  } = {},
): IRouter {
  const previewRouter: IRouter = Router();
  const repository = options.repository ?? databaseRosterPreviewRepository;
  const adminMiddleware = options.adminMiddleware ?? requireAdmin;

  previewRouter.post(
    "/roster-imports/preview",
    adminMiddleware,
    uploadWorkbook,
    async (req, res): Promise<void> => {
      if (!req.file) {
        res.status(400).json({ error: "Choose an .xlsx workbook to preview" });
        return;
      }
      if (!req.file.originalname.toLowerCase().endsWith(".xlsx")) {
        res.status(415).json({
          error: "Only .xlsx workbooks are supported in this version",
        });
        return;
      }
      const fileBytes = new Uint8Array(req.file.buffer);
      const fileCopy = new ArrayBuffer(fileBytes.byteLength);
      new Uint8Array(fileCopy).set(fileBytes);
      const fileBlob = new Blob([fileCopy], {
        type:
          req.file.mimetype ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const parsedBody = PreviewRosterImportBody.safeParse({
        file: fileBlob,
        month: req.body.month,
        mappingJson: req.body.mappingJson,
      });
      if (!parsedBody.success) {
        res.status(400).json({ error: parsedBody.error.message });
        return;
      }

      let mapping = emptyMapping;
      if (parsedBody.data.mappingJson) {
        let rawMapping: unknown;
        try {
          rawMapping = JSON.parse(parsedBody.data.mappingJson);
        } catch {
          res.status(400).json({ error: "Column mapping must be valid JSON" });
          return;
        }
        const mapped = mappingJsonSchema.safeParse(rawMapping);
        if (!mapped.success) {
          res.status(400).json({ error: mapped.error.message });
          return;
        }
        mapping = mapped.data;
      }

      let references: PreviewReferenceData;
      try {
        references = await repository.loadReferenceData();
      } catch (error) {
        req.log.error({ err: error }, "Could not load roster preview references");
        res.status(500).json({
          error: "Roster settings could not be loaded. Retry the preview in a moment.",
        });
        return;
      }

      let parsed: Awaited<ReturnType<typeof parseRosterWorkbook>>;
      try {
        parsed = await parseRosterWorkbook(
          req.file.buffer,
          parsedBody.data.month,
          mapping,
          references.employees,
          references.shiftTypes,
          references.departments,
        );
      } catch (error) {
        req.log.warn({ err: error }, "Could not parse roster workbook");
        res.status(400).json({
          error:
            "Could not read this workbook. Check that it is a valid .xlsx file with recognizable roster and date headers, then retry.",
        });
        return;
      }

      const user = currentAppUser(req);
      const status = parsed.issues.length ? "needs_review" : "ready";
      const periodStart = parsed.periodStart;
      const periodEnd = parsed.periodEnd;
      try {
        const job = await repository.createImportJob({
          month: periodStart?.slice(0, 7) ?? parsedBody.data.month,
          periodStart,
          periodEnd,
          selectedWorksheet: parsed.selectedWorksheet,
          status,
          detectedFormat: parsed.format,
          uploadedBy: user.id,
          rowCount: parsed.records.length,
          validCount: parsed.records.filter((record) => record.valid).length,
          issueCount: parsed.issues.length,
          mapping: { ...parsed.mapping },
          preview: {
            columns: parsed.columns,
            records: parsed.records,
            issues: parsed.issues,
            periodStart,
            periodEnd,
            selectedWorksheet: parsed.selectedWorksheet,
            worksheetChoices: parsed.worksheetChoices,
          },
        });
        await repository.writeAuditLog({
          actorUserId: user.id,
          action: "roster.import_previewed",
          subject: `${periodStart?.slice(0, 7) ?? parsedBody.data.month} · ${parsed.records.length} cells`,
        });
        res.status(201).json(await previewResponse(job, user.fullName));
      } catch (error) {
        req.log.error({ err: error }, "Could not save roster preview");
        res.status(500).json({
          error:
            "The workbook was read, but its preview could not be saved. Your selected file is still available; retry in a moment.",
        });
      }
    },
  );

  return previewRouter;
}

async function findVersionResponse(
  version: typeof rosterVersionsTable.$inferSelect,
): Promise<RosterVersion> {
  const [creator] = await db
    .select({ fullName: appUsersTable.fullName })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, version.createdBy))
    .limit(1);
  const [assignmentCount] = await db
    .select({ count: count(shiftAssignmentsTable.id) })
    .from(shiftAssignmentsTable)
    .innerJoin(
      shiftTypesTable,
      eq(shiftTypesTable.id, shiftAssignmentsTable.shiftTypeId),
    )
    .where(
      and(
        eq(shiftAssignmentsTable.versionId, version.id),
        eq(shiftTypesTable.category, "working"),
      ),
    );
  const period = periodForVersion(version);
  return {
    id: version.id,
    month: version.month,
    periodStart: period.start,
    periodEnd: period.end,
    versionNumber: version.versionNumber,
    status: version.status as RosterVersion["status"],
    sourceImportId: version.sourceImportId,
    createdByName: creator?.fullName ?? "Aman admin",
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    assignmentCount: Number(assignmentCount.count),
  };
}

router.get(
  "/roster-imports",
  requireAdmin,
  async (_req, res): Promise<void> => {
    const jobs = await db
      .select()
      .from(importJobsTable)
      .orderBy(desc(importJobsTable.uploadedAt))
      .limit(50);
    const rows = await Promise.all(jobs.map((job) => importResponse(job)));
    res.json(ListRosterImportsResponse.parse(rows));
  },
);

router.use(createRosterPreviewRouter());

router.post(
  "/roster-imports/:importId/resolve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ResolveRosterImportParams.safeParse(req.params);
    const body = ResolveRosterImportBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const [job] = await db
      .select()
      .from(importJobsTable)
      .where(eq(importJobsTable.id, params.data.importId))
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    if (job.status === "committed" || job.status === "rejected") {
      res.status(409).json({ error: "This import can no longer be changed" });
      return;
    }

    const stored = readStoredPreview(job.preview);
    const sourceByRow = new Map(
      stored.records.map((record) => [record.rowNumber, record]),
    );
    const resolutionRows = [
      ...body.data.employees.map((item) => item.rowNumber),
      ...body.data.newEmployees.map((item) => item.rowNumber),
    ];
    if (new Set(resolutionRows).size !== resolutionRows.length) {
      res.status(400).json({ error: "Resolve each source employee row only once." });
      return;
    }
    const missingRows = resolutionRows.filter((rowNumber) => !sourceByRow.has(rowNumber));
    if (missingRows.length) {
      res.status(400).json({ error: "A selected employee row is not part of this import." });
      return;
    }

    const registrations = body.data.newEmployees.map((entry) => {
      const source = sourceByRow.get(entry.rowNumber)!;
      return {
        rowNumber: entry.rowNumber,
        employeeCode: source.sourceEmployeeId?.trim() ?? "",
        fullName: source.sourceEmployeeName.trim(),
        jobTitle: entry.jobTitle.trim() || source.sourceRole.trim(),
        departmentId: entry.departmentId,
      };
    });
    const allExistingEmployees = await db
      .select({
        id: employeesTable.id,
        employeeCode: employeesTable.employeeCode,
        fullName: employeesTable.fullName,
        departmentId: employeesTable.departmentId,
        active: employeesTable.active,
      })
      .from(employeesTable);
    const allExistingAliases = await db
      .select({ alias: employeeAliasesTable.alias })
      .from(employeeAliasesTable);
    const registrationValidation = validateNewEmployeeRegistrations(
      registrations,
      [
        ...allExistingEmployees,
        ...allExistingAliases.map((item) => ({ employeeCode: "", fullName: item.alias })),
      ],
    );
    if (!registrationValidation.valid) {
      res.status(409).json({ error: registrationValidation.error });
      return;
    }
    for (const entry of body.data.newEmployees) {
      const source = sourceByRow.get(entry.rowNumber)!;
      if (source.employeeId || !source.sourceEmployeeId?.trim()) {
        res.status(400).json({
          error: "Only unmatched roster rows with a source Employee ID can be registered.",
        });
        return;
      }
      if (!source.sourceEmployeeName.trim()) {
        res.status(400).json({ error: "A source employee name is required to register staff." });
        return;
      }
    }

    const manualEmployeeIds = [...new Set(body.data.employees.map((entry) => entry.employeeId))];
    const shiftIds = [...new Set(body.data.shiftCodes.map((entry) => entry.shiftTypeId))];
    const departmentIds = [...new Set(body.data.newEmployees.map((entry) => entry.departmentId))];
    const activeEmployeeRows = manualEmployeeIds.length
      ? await db
          .select({
            id: employeesTable.id,
            employeeCode: employeesTable.employeeCode,
            fullName: employeesTable.fullName,
            departmentId: employeesTable.departmentId,
          })
          .from(employeesTable)
          .where(and(inArray(employeesTable.id, manualEmployeeIds), eq(employeesTable.active, true)))
      : [];
    const shiftRows = shiftIds.length
      ? await db
          .select({
            id: shiftTypesTable.id,
            code: shiftTypesTable.code,
            name: shiftTypesTable.name,
          })
          .from(shiftTypesTable)
          .where(and(inArray(shiftTypesTable.id, shiftIds), eq(shiftTypesTable.active, true)))
      : [];
    const activeDepartmentRows = departmentIds.length
      ? await db
          .select({ id: departmentsTable.id })
          .from(departmentsTable)
          .where(and(inArray(departmentsTable.id, departmentIds), eq(departmentsTable.active, true)))
      : [];
    if (
      activeEmployeeRows.length !== manualEmployeeIds.length ||
      shiftRows.length !== shiftIds.length ||
      activeDepartmentRows.length !== departmentIds.length
    ) {
      res.status(400).json({
        error: "Choose active employees, departments, and shift types.",
      });
      return;
    }

    const employeeMapping = new Map(
      body.data.employees.map((entry) => [entry.rowNumber, entry.employeeId]),
    );
    const shiftMapping = new Map(
      body.data.shiftCodes.map((entry) => [
        normalizeShiftValue(entry.shiftCode),
        entry.shiftTypeId,
      ]),
    );
    const aliasRequests = body.data.employees.filter((entry) => entry.rememberAlias);
    for (const entry of aliasRequests) {
      const source = sourceByRow.get(entry.rowNumber)!;
      if (!normalizeEmployeeName(source.sourceEmployeeName)) {
        res.status(400).json({ error: "This source name cannot be saved as an approved alias." });
        return;
      }
    }

    const user = currentAppUser(req);
    const { updated } = await db.transaction(async (tx) => {
      const newEmployeeRows = registrations.length
        ? await tx
            .insert(employeesTable)
            .values(
              registrations.map((registration) => ({
                employeeCode: registration.employeeCode,
                fullName: registration.fullName,
                jobTitle: registration.jobTitle,
                departmentId: registration.departmentId,
                active: true,
              })),
            )
            .returning({
              id: employeesTable.id,
              employeeCode: employeesTable.employeeCode,
              fullName: employeesTable.fullName,
              departmentId: employeesTable.departmentId,
            })
        : [];
      const employeeById = new Map(
        [...activeEmployeeRows, ...newEmployeeRows].map((employee) => [employee.id, employee]),
      );
      const newEmployeeIdByRow = new Map(
        registrations.map((registration) => [
          registration.rowNumber,
          newEmployeeRows.find(
            (employee) => employee.employeeCode === registration.employeeCode,
          )?.id,
        ]),
      );
      const allSourceRows = new Map(
        [...body.data.employees, ...body.data.newEmployees].map((entry) => [
          entry.rowNumber,
          entry,
        ]),
      );

      const aliasCandidates = new Map<
        string,
        { employeeId: string; alias: string }
      >();
      for (const entry of aliasRequests) {
        const normalizedAlias = normalizeEmployeeName(sourceByRow.get(entry.rowNumber)!.sourceEmployeeName);
        const employee = employeeById.get(entry.employeeId);
        if (!employee) throw new Error("The selected employee is no longer active.");
        if (normalizeEmployeeName(employee.fullName) === normalizedAlias) continue;
        const previous = aliasCandidates.get(normalizedAlias);
        if (previous && previous.employeeId !== employee.id) {
          throw new Error("The same source name cannot be mapped to different employees.");
        }
        aliasCandidates.set(normalizedAlias, {
          employeeId: employee.id,
          alias: sourceByRow.get(entry.rowNumber)!.sourceEmployeeName,
        });
      }
      if (aliasCandidates.size) {
        const aliasKeys = [...aliasCandidates.keys()];
        const [existingAliases, existingCanonicalNames] = await Promise.all([
          tx
            .select({
              normalizedAlias: employeeAliasesTable.normalizedAlias,
              employeeId: employeeAliasesTable.employeeId,
            })
            .from(employeeAliasesTable)
            .where(inArray(employeeAliasesTable.normalizedAlias, aliasKeys)),
          tx
            .select({
              id: employeesTable.id,
              fullName: employeesTable.fullName,
            })
            .from(employeesTable),
        ]);
        for (const [normalizedAlias, candidate] of aliasCandidates) {
          const currentAlias = existingAliases.find((item) => item.normalizedAlias === normalizedAlias);
          if (currentAlias && currentAlias.employeeId !== candidate.employeeId) {
            throw new Error("This approved name is already linked to another employee.");
          }
          const canonicalConflict = existingCanonicalNames.find(
            (item) =>
              item.id !== candidate.employeeId &&
              normalizeEmployeeName(item.fullName) === normalizedAlias,
          );
          if (canonicalConflict) {
            throw new Error("This name matches another employee; choose the correct directory record.");
          }
        }
        for (const [normalizedAlias, candidate] of aliasCandidates) {
          const existing = existingAliases.find((item) => item.normalizedAlias === normalizedAlias);
          if (existing) continue;
          await tx.insert(employeeAliasesTable).values({
            employeeId: candidate.employeeId,
            alias: candidate.alias,
            normalizedAlias,
            createdBy: user.id,
          });
        }
      }

      const records = stored.records.map((record) => {
        const mappedEmployeeId =
          employeeMapping.get(record.rowNumber) ??
          newEmployeeIdByRow.get(record.rowNumber) ??
          undefined;
        const employee = mappedEmployeeId ? employeeById.get(mappedEmployeeId) : undefined;
        const mappedShiftId = shiftMapping.get(normalizeShiftValue(record.shiftCode));
        const shift = mappedShiftId ? shiftRows.find((item) => item.id === mappedShiftId) : undefined;
        return {
          ...record,
          ...(employee
            ? {
                employeeId: employee.id,
                employeeCode: employee.employeeCode,
                employeeName: employee.fullName,
                departmentId: employee.departmentId,
              }
            : {}),
          ...(shift
            ? {
                shiftTypeId: shift.id,
                shiftCode: shift.code,
                shiftName: shift.name,
              }
            : {}),
        };
      });
      const resolvedEmployeeRows = new Set(allSourceRows.keys());
      const resolvedShiftCodes = new Set(shiftMapping.keys());
      const issues = stored.issues.filter((item) => {
        const rowResolved =
          item.rowNumber !== null && resolvedEmployeeRows.has(item.rowNumber);
        if (
          rowResolved &&
          ["unknown_employee", "ambiguous_employee", "missing_employee_id", "unknown_department"].includes(item.code)
        ) {
          return false;
        }
        if (
          item.code === "unknown_shift" &&
          item.value &&
          resolvedShiftCodes.has(normalizeShiftValue(item.value))
        ) {
          return false;
        }
        return true;
      });
      for (const record of records) {
        if (!record.employeeId && (record.employeeCode || record.employeeName)) {
          issues.push({
            code: "unknown_employee",
            message: "The employee does not match the staff directory.",
            rowNumber: record.rowNumber,
            value: record.employeeCode || record.employeeName,
          });
        }
        if (!record.shiftTypeId && record.shiftCode) {
          issues.push({
            code: "unknown_shift",
            message: "The shift code is not configured.",
            rowNumber: record.rowNumber,
            value: record.shiftCode,
          });
        }
      }
      const uniqueIssues = new Map<string, (typeof issues)[number]>();
      for (const item of issues) {
        uniqueIssues.set(
          `${item.code}:${item.rowNumber ?? ""}:${item.value ?? ""}:${item.message}`,
          item,
        );
      }
      const resolvedIssues = [...uniqueIssues.values()];
      const issueRows = new Set(
        resolvedIssues
          .map((item) => item.rowNumber)
          .filter((row): row is number => row !== null),
      );
      for (const record of records) {
        record.valid = Boolean(
          record.employeeId &&
            record.departmentId &&
            record.shiftTypeId &&
            record.date &&
            !issueRows.has(record.rowNumber),
        );
      }
      const status = resolvedIssues.length ? "needs_review" : "ready";
      const [updated] = await tx
        .update(importJobsTable)
        .set({
          status,
          validCount: records.filter((record) => record.valid).length,
          issueCount: resolvedIssues.length,
          preview: {
            columns: stored.columns,
            records,
            issues: resolvedIssues,
            periodStart: stored.periodStart,
            periodEnd: stored.periodEnd,
            selectedWorksheet: stored.selectedWorksheet,
            worksheetChoices: stored.worksheetChoices,
          },
          mapping: job.mapping,
        })
        .where(eq(importJobsTable.id, job.id))
        .returning();
      return { updated };
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not resolve roster employees.";
      if (message.includes("already") || message.includes("matches") || message.includes("linked")) {
        res.status(409).json({ error: message });
      } else {
        req.log.error({ err: error }, "Could not apply roster employee resolutions");
        res.status(400).json({ error: "Could not apply roster employee resolutions." });
      }
      return { updated: null };
    });
    if (!updated) return;
    await writeAuditLog({
      actorUserId: currentAppUser(req).id,
      action: "roster.import_resolved",
      subject: `${job.month} · ${job.id}`,
    });
    res.json(ResolveRosterImportResponse.parse(await previewResponse(updated)));
  },
);

router.post(
  "/roster-imports/:importId/confirm",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ConfirmRosterImportParams.safeParse(req.params);
    const body = ConfirmRosterImportBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const [job] = await db
      .select()
      .from(importJobsTable)
      .where(eq(importJobsTable.id, params.data.importId))
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    if (job.status !== "ready" || job.issueCount !== 0) {
      res.status(409).json({
        error: "Resolve every import issue before confirming this roster",
      });
      return;
    }
    const records = readStoredPreview(job.preview).records;
    if (!records.length || records.some((record) => !record.valid || !record.date || !record.employeeId || !record.shiftTypeId)) {
      res.status(409).json({ error: "The import contains incomplete assignments" });
      return;
    }
    const user = currentAppUser(req);
    const fallbackPeriod = periodForMonth(job.month);
    const importPeriod = {
      start: job.periodStart ?? fallbackPeriod.start,
      end: job.periodEnd ?? fallbackPeriod.end,
    };
    const version = await db.transaction(async (tx) => {
      const activeVersions = await tx
        .select()
        .from(rosterVersionsTable)
        .where(inArray(rosterVersionsTable.status, ["draft", "published"]));
      const overlappingVersions = activeVersions
        .filter((candidate) =>
          periodsOverlap(importPeriod, periodForVersion(candidate)),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const [maxVersion] = await tx
        .select({ number: rosterVersionsTable.versionNumber })
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.month, job.month))
        .orderBy(desc(rosterVersionsTable.versionNumber))
        .limit(1);
      const [created] = await tx
        .insert(rosterVersionsTable)
        .values({
          month: importPeriod.start.slice(0, 7),
          periodStart: importPeriod.start,
          periodEnd: importPeriod.end,
          versionNumber: (maxVersion?.number ?? 0) + 1,
          status: "draft",
          sourceImportId: job.id,
          createdBy: user.id,
        })
        .returning();

      type AssignmentToCopy = {
        employeeId: string;
        shiftTypeId: string;
        date: string;
        sourceEmployeeId: string | null;
        sourceEmployeeName: string | null;
        sourceDepartment: string | null;
        sourceRole: string | null;
        sourceRawShiftValue: string | null;
        notes: string | null;
      };
      const assignmentsByEmployeeDate = new Map<string, AssignmentToCopy>();
      if (overlappingVersions.length) {
        const versionIds = overlappingVersions.map((candidate) => candidate.id);
        const existingAssignments = await tx
          .select({
            versionId: shiftAssignmentsTable.versionId,
            employeeId: shiftAssignmentsTable.employeeId,
            shiftTypeId: shiftAssignmentsTable.shiftTypeId,
            date: shiftAssignmentsTable.date,
            sourceEmployeeId: shiftAssignmentsTable.sourceEmployeeId,
            sourceEmployeeName: shiftAssignmentsTable.sourceEmployeeName,
            sourceDepartment: shiftAssignmentsTable.sourceDepartment,
            sourceRole: shiftAssignmentsTable.sourceRole,
            sourceRawShiftValue: shiftAssignmentsTable.sourceRawShiftValue,
            notes: shiftAssignmentsTable.notes,
          })
          .from(shiftAssignmentsTable)
          .where(inArray(shiftAssignmentsTable.versionId, versionIds));
        const versionRank = new Map(
          overlappingVersions.map((candidate, index) => [candidate.id, index]),
        );
        existingAssignments.sort(
          (a, b) =>
            (versionRank.get(a.versionId) ?? 0) -
            (versionRank.get(b.versionId) ?? 0),
        );
        for (const existing of existingAssignments) {
          const isOutsideImport =
            existing.date < importPeriod.start || existing.date > importPeriod.end;
          if (body.data.mode === "replace" && !isOutsideImport) continue;
          assignmentsByEmployeeDate.set(
            `${existing.employeeId}:${existing.date}`,
            {
              employeeId: existing.employeeId,
              shiftTypeId: existing.shiftTypeId,
              date: existing.date,
              sourceEmployeeId: existing.sourceEmployeeId,
              sourceEmployeeName: existing.sourceEmployeeName,
              sourceDepartment: existing.sourceDepartment,
              sourceRole: existing.sourceRole,
              sourceRawShiftValue: existing.sourceRawShiftValue,
              notes: existing.notes,
            },
          );
        }
      }

      for (const record of records) {
        const incoming: AssignmentToCopy = {
          employeeId: record.employeeId as string,
          shiftTypeId: record.shiftTypeId as string,
          date: record.date as string,
          sourceEmployeeId: record.sourceEmployeeId,
          sourceEmployeeName: record.sourceEmployeeName,
          sourceDepartment: record.sourceDepartment,
          sourceRole: record.sourceRole,
          sourceRawShiftValue: record.rawShiftValue,
          notes: null,
        };
        assignmentsByEmployeeDate.set(
          `${incoming.employeeId}:${incoming.date}`,
          incoming,
        );
      }

      const assignments = [...assignmentsByEmployeeDate.values()];
      if (assignments.length) {
        await tx.insert(shiftAssignmentsTable).values(
          assignments.map((assignment) => ({
            ...assignment,
            versionId: created.id,
          })),
        );
      }

      let finalVersion = created;
      if (body.data.publish) {
        const publishedIds = overlappingVersions
          .filter((candidate) => candidate.status === "published")
          .map((candidate) => candidate.id);
        if (publishedIds.length) {
          await tx
            .update(rosterVersionsTable)
            .set({ status: "archived" })
            .where(inArray(rosterVersionsTable.id, publishedIds));
        }
        [finalVersion] = await tx
          .update(rosterVersionsTable)
          .set({
            status: "published",
            publishedAt: new Date(),
            publishedBy: user.id,
          })
          .where(eq(rosterVersionsTable.id, created.id))
          .returning();
      }
      await tx
        .update(importJobsTable)
        .set({
          status: "committed",
          createdVersionId: created.id,
        })
        .where(eq(importJobsTable.id, job.id));
      await tx.insert(auditLogsTable).values({
        actorUserId: user.id,
        action: "roster.import_confirmed",
        subject: `${importPeriod.start}–${importPeriod.end} · v${created.versionNumber}`,
        details: {
          mode: body.data.mode,
          published: body.data.publish,
          periodStart: importPeriod.start,
          periodEnd: importPeriod.end,
        },
      });
      return finalVersion;
    });

    res
      .status(201)
      .json(ConfirmRosterImportResponse.parse(await findVersionResponse(version)));
  },
);

export default router;
