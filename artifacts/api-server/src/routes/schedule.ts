import {
  Router,
  type IRouter,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
} from "drizzle-orm";
import {
  CreateRosterAssignmentBody,
  CreateRosterAssignmentParams,
  CreateRosterAssignmentResponse,
  CreateRosterVersionBody,
  CreateRosterVersionResponse,
  DeleteRosterAssignmentParams,
  GetDashboardSummaryQueryParams,
  GetDashboardSummaryResponse,
  GetMonthlyScheduleQueryParams,
  GetMonthlyScheduleResponse,
  GetMyScheduleQueryParams,
  GetMyScheduleResponse,
  GetRecentActivityQueryParams,
  GetRecentActivityResponse,
  GetRosterVersionScheduleParams,
  GetRosterVersionScheduleResponse,
  ListRosterVersionsQueryParams,
  ListRosterVersionsResponse,
  PublishRosterVersionParams,
  PublishRosterVersionResponse,
  RollbackRosterVersionBody,
  RollbackRosterVersionParams,
  RollbackRosterVersionResponse,
  UpdateRosterAssignmentBody,
  UpdateRosterAssignmentParams,
  UpdateRosterAssignmentResponse,
} from "@workspace/api-zod";
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
} from "@workspace/db";
import { currentAppUser, requireAdmin } from "../lib/amanAuth";
import { writeAuditLog } from "../lib/audit";

const router: IRouter = Router();

function periodForMonth(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function isValidScheduleMonth(month: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return false;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  return year > 0 && monthNumber >= 1 && monthNumber <= 12;
}

export function scheduleReadFailure(error: unknown): {
  status: 500 | 503;
  body: { error: string; code: string };
} {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  const databaseUnavailable =
    typeof code === "string" &&
    (/^(08|53|57|58)/i.test(code) ||
      /^(ECONN|EHOST|ETIMEDOUT)/i.test(code));
  if (databaseUnavailable) {
    return {
      status: 503,
      body: {
        error: "Schedule data is temporarily unavailable. Try again shortly.",
        code: "schedule_database_unavailable",
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "A server error prevented the schedule from loading. Try again.",
      code: "schedule_load_failed",
    },
  };
}

export function withScheduleReadErrors(handler: RequestHandler): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (error) {
      req.log.error({ err: error }, "Could not load schedule data");
      const failure = scheduleReadFailure(error);
      res.status(failure.status).json(failure.body);
    }
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

async function versionsForMonth(month: string) {
  const requestedPeriod = periodForMonth(month);
  const versions = await db
    .select()
    .from(rosterVersionsTable)
    .orderBy(desc(rosterVersionsTable.createdAt));
  return versions.filter((version) =>
    periodsOverlap(requestedPeriod, periodForVersion(version)),
  );
}

async function visibleVersion(month: string, admin: boolean) {
  const versions = await versionsForMonth(month);
  return (
    (admin ? versions.find((version) => version.status === "draft") : undefined) ??
    versions.find((version) => version.status === "published") ??
    null
  );
}

async function scheduleAssignments(
  versionId: string,
  departmentId?: string,
  employeeId?: string,
  month?: string,
) {
  const conditions = [eq(shiftAssignmentsTable.versionId, versionId)];
  if (month) {
    const period = periodForMonth(month);
    conditions.push(
      gte(shiftAssignmentsTable.date, period.start),
      lte(shiftAssignmentsTable.date, period.end),
    );
  }
  if (departmentId) {
    conditions.push(eq(employeesTable.departmentId, departmentId));
  }
  if (employeeId) {
    conditions.push(eq(employeesTable.id, employeeId));
  }

  return db
    .select({
      id: shiftAssignmentsTable.id,
      date: shiftAssignmentsTable.date,
      employeeId: employeesTable.id,
      employeeCode: employeesTable.employeeCode,
      employeeName: employeesTable.fullName,
      departmentId: departmentsTable.id,
      departmentName: departmentsTable.name,
      shiftTypeId: shiftTypesTable.id,
      shiftCode: shiftTypesTable.displayCode,
      fallbackShiftCode: shiftTypesTable.code,
      shiftName: shiftTypesTable.name,
      shiftColor: shiftTypesTable.color,
      category: shiftTypesTable.category,
      displayInCalendar: shiftTypesTable.displayInCalendar,
      notes: shiftAssignmentsTable.notes,
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
    .innerJoin(
      shiftTypesTable,
      eq(shiftTypesTable.id, shiftAssignmentsTable.shiftTypeId),
    )
    .where(and(...conditions))
    .orderBy(asc(shiftAssignmentsTable.date), asc(employeesTable.fullName))
    .then((rows) =>
      rows.map(({ fallbackShiftCode, ...assignment }) => ({
        ...assignment,
        shiftCode: assignment.shiftCode ?? fallbackShiftCode,
        isWorking: assignment.category === "working",
      })),
    );
}

function schedulePayload(
  month: string,
  version: typeof rosterVersionsTable.$inferSelect | null,
  assignments: Awaited<ReturnType<typeof scheduleAssignments>>,
) {
  return {
    month,
    status: version?.status === "draft" ? "draft" : "published",
    versionId: version?.id ?? null,
    versionNumber: version?.versionNumber ?? null,
    periodStart: version ? periodForVersion(version).start : null,
    periodEnd: version ? periodForVersion(version).end : null,
    assignments,
  };
}

async function assignmentById(versionId: string, assignmentId: string) {
  const [assignment] = await db
    .select({
      id: shiftAssignmentsTable.id,
      date: shiftAssignmentsTable.date,
      employeeId: employeesTable.id,
      employeeCode: employeesTable.employeeCode,
      employeeName: employeesTable.fullName,
      departmentId: departmentsTable.id,
      departmentName: departmentsTable.name,
      shiftTypeId: shiftTypesTable.id,
      shiftCode: shiftTypesTable.displayCode,
      fallbackShiftCode: shiftTypesTable.code,
      shiftName: shiftTypesTable.name,
      shiftColor: shiftTypesTable.color,
      category: shiftTypesTable.category,
      displayInCalendar: shiftTypesTable.displayInCalendar,
      notes: shiftAssignmentsTable.notes,
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
    .innerJoin(
      shiftTypesTable,
      eq(shiftTypesTable.id, shiftAssignmentsTable.shiftTypeId),
    )
    .where(
      and(
        eq(shiftAssignmentsTable.id, assignmentId),
        eq(shiftAssignmentsTable.versionId, versionId),
      ),
    )
    .limit(1);
  if (!assignment) return assignment;
  const { fallbackShiftCode, ...result } = assignment;
  return {
    ...result,
    shiftCode: result.shiftCode ?? fallbackShiftCode,
    isWorking: result.category === "working",
  };
}

async function getVersion(versionId: string) {
  const [version] = await db
    .select()
    .from(rosterVersionsTable)
    .where(eq(rosterVersionsTable.id, versionId))
    .limit(1);
  return version;
}

async function versionResponse(
  version: typeof rosterVersionsTable.$inferSelect,
) {
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
  return {
    id: version.id,
    month: version.month,
    periodStart: periodForVersion(version).start,
    periodEnd: periodForVersion(version).end,
    versionNumber: version.versionNumber,
    status: version.status,
    sourceImportId: version.sourceImportId,
    createdByName: creator?.fullName ?? "Aman admin",
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    assignmentCount: Number(assignmentCount.count),
  };
}

async function ensureEditableRoster(versionId: string) {
  const version = await getVersion(versionId);
  if (!version) return { error: "Roster version not found" as const };
  if (version.status === "archived") {
    return { error: "Archived roster versions cannot be changed" as const };
  }
  return { version };
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const query = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const month = query.data.month;
  const [employeeCount] = await db
    .select({ count: count(employeesTable.id) })
    .from(employeesTable)
    .where(eq(employeesTable.active, true));
  const [departmentCount] = await db
    .select({ count: count(departmentsTable.id) })
    .from(departmentsTable)
    .where(eq(departmentsTable.active, true));
  const monthPeriod = periodForMonth(month);
  const published = (await versionsForMonth(month)).find(
    (version) => version.status === "published",
  );
  const assignments = published
    ? await db
        .select({ count: count(shiftAssignmentsTable.id) })
        .from(shiftAssignmentsTable)
        .innerJoin(
          shiftTypesTable,
          eq(shiftTypesTable.id, shiftAssignmentsTable.shiftTypeId),
        )
        .where(
          and(
            eq(shiftAssignmentsTable.versionId, published.id),
            gte(shiftAssignmentsTable.date, monthPeriod.start),
            lte(shiftAssignmentsTable.date, monthPeriod.end),
            eq(shiftTypesTable.category, "working"),
          ),
        )
    : [{ count: 0 }];
  const pendingJobs = await db
    .select({
      month: importJobsTable.month,
      periodStart: importJobsTable.periodStart,
      periodEnd: importJobsTable.periodEnd,
    })
    .from(importJobsTable)
    .where(inArray(importJobsTable.status, ["needs_review", "ready"]));
  const importReviewCount = pendingJobs.filter((job) =>
    periodsOverlap(
      monthPeriod,
      {
        start: job.periodStart ?? periodForMonth(job.month).start,
        end: job.periodEnd ?? periodForMonth(job.month).end,
      },
    ),
  ).length;
  res.json(
    GetDashboardSummaryResponse.parse({
      month,
      employeeCount: Number(employeeCount.count),
      departmentCount: Number(departmentCount.count),
      assignedShiftCount: Number(assignments[0]?.count ?? 0),
      importReviewCount,
      publishedVersion: published?.versionNumber ?? null,
      publishedAt: published?.publishedAt?.toISOString() ?? null,
    }),
  );
});

router.get(
  "/activity/recent",
  requireAdmin,
  async (req, res): Promise<void> => {
    const query = GetRecentActivityQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const rows = await db
      .select({
        id: auditLogsTable.id,
        action: auditLogsTable.action,
        actorName: appUsersTable.fullName,
        subject: auditLogsTable.subject,
        createdAt: auditLogsTable.createdAt,
      })
      .from(auditLogsTable)
      .innerJoin(
        appUsersTable,
        eq(appUsersTable.id, auditLogsTable.actorUserId),
      )
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(query.data.limit ?? 10);
    res.json(
      GetRecentActivityResponse.parse(
        rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      ),
    );
  },
);

router.get(
  "/schedule/month",
  withScheduleReadErrors(async (req, res): Promise<void> => {
    const query = GetMonthlyScheduleQueryParams.safeParse(req.query);
    if (!query.success || !isValidScheduleMonth(query.data.month)) {
      res.status(400).json({
        error: "Choose a valid schedule month in YYYY-MM format.",
        code: "invalid_schedule_period",
      });
      return;
    }
    const user = currentAppUser(req);
    const version = await visibleVersion(query.data.month, user.role === "admin");
    const assignments = version
      ? await scheduleAssignments(
          version.id,
          query.data.departmentId,
          undefined,
          query.data.month,
        )
      : [];
    res.json(
      GetMonthlyScheduleResponse.parse(
        schedulePayload(query.data.month, version ?? null, assignments),
      ),
    );
  }),
);

router.get(
  "/schedule/mine",
  withScheduleReadErrors(async (req, res): Promise<void> => {
    const query = GetMyScheduleQueryParams.safeParse(req.query);
    if (!query.success || !isValidScheduleMonth(query.data.month)) {
      res.status(400).json({
        error: "Choose a valid schedule month in YYYY-MM format.",
        code: "invalid_schedule_period",
      });
      return;
    }
    const user = currentAppUser(req);
    const version = (await versionsForMonth(query.data.month)).find(
      (candidate) => candidate.status === "published",
    );
    const assignments =
      version && user.employeeId
        ? await scheduleAssignments(
            version.id,
            undefined,
            user.employeeId,
            query.data.month,
          )
        : [];
    res.json(
      GetMyScheduleResponse.parse(
        schedulePayload(query.data.month, version ?? null, assignments),
      ),
    );
  }),
);

router.get(
  "/roster-versions",
  requireAdmin,
  async (req, res): Promise<void> => {
    const query = ListRosterVersionsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const versions = await versionsForMonth(query.data.month);
    const result = await Promise.all(versions.map(versionResponse));
    res.json(ListRosterVersionsResponse.parse(result));
  },
);

router.post(
  "/roster-versions",
  requireAdmin,
  async (req, res): Promise<void> => {
    const body = CreateRosterVersionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const user = currentAppUser(req);
    const result = await db.transaction(async (tx) => {
      const monthPeriod = periodForMonth(body.data.month);
      const allVersions = await tx
        .select()
        .from(rosterVersionsTable)
        .orderBy(desc(rosterVersionsTable.createdAt));
      const overlapping = allVersions.filter((candidate) =>
        periodsOverlap(monthPeriod, periodForVersion(candidate)),
      );
      const base = overlapping.find(
        (candidate) => candidate.status === "published",
      );
      const newPeriod = base ? periodForVersion(base) : monthPeriod;
      const [maxVersion] = await tx
        .select({ number: rosterVersionsTable.versionNumber })
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.month, body.data.month))
        .orderBy(desc(rosterVersionsTable.versionNumber))
        .limit(1);
      const versionNumber = (maxVersion?.number ?? 0) + 1;
      const [version] = await tx
        .insert(rosterVersionsTable)
        .values({
          month: body.data.month,
          periodStart: newPeriod.start,
          periodEnd: newPeriod.end,
          versionNumber,
          status: "draft",
          createdBy: user.id,
        })
        .returning();
      if (body.data.copyPublished && base) {
        const sourceAssignments = await tx
          .select({
            employeeId: shiftAssignmentsTable.employeeId,
            shiftTypeId: shiftAssignmentsTable.shiftTypeId,
            date: shiftAssignmentsTable.date,
            sourceEmployeeId: shiftAssignmentsTable.sourceEmployeeId,
            sourceEmployeeName: shiftAssignmentsTable.sourceEmployeeName,
            sourceRawShiftValue: shiftAssignmentsTable.sourceRawShiftValue,
            notes: shiftAssignmentsTable.notes,
          })
          .from(shiftAssignmentsTable)
          .where(eq(shiftAssignmentsTable.versionId, base.id));
        if (sourceAssignments.length) {
          await tx.insert(shiftAssignmentsTable).values(
            sourceAssignments.map((assignment) => ({
              ...assignment,
              versionId: version.id,
            })),
          );
        }
      }
      await tx.insert(auditLogsTable).values({
        actorUserId: user.id,
        action: "roster.draft_created",
        subject: `${body.data.month} · v${versionNumber}`,
      });
      return version;
    });
    res
      .status(201)
      .json(CreateRosterVersionResponse.parse(await versionResponse(result)));
  },
);

router.get(
  "/roster-versions/:versionId/schedule",
  requireAdmin,
  withScheduleReadErrors(async (req: Request, res: Response): Promise<void> => {
    const params = GetRosterVersionScheduleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const version = await getVersion(params.data.versionId);
    if (!version) {
      res.status(404).json({ error: "Roster version not found" });
      return;
    }
    const assignments = await scheduleAssignments(version.id);
    res.json(
      GetRosterVersionScheduleResponse.parse(
        schedulePayload(version.month, version, assignments),
      ),
    );
  }),
);

router.post(
  "/roster-versions/:versionId/publish",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = PublishRosterVersionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = currentAppUser(req);
    const version = await db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.id, params.data.versionId))
        .limit(1);
      if (!draft) return null;
      if (draft.status !== "draft") return "not-draft" as const;
      const publishedVersions = await tx
        .select()
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.status, "published"));
      const overlappingPublishedIds = publishedVersions
        .filter((candidate) =>
          periodsOverlap(periodForVersion(draft), periodForVersion(candidate)),
        )
        .map((candidate) => candidate.id);
      if (overlappingPublishedIds.length) {
        await tx
          .update(rosterVersionsTable)
          .set({ status: "archived" })
          .where(inArray(rosterVersionsTable.id, overlappingPublishedIds));
      }
      const [published] = await tx
        .update(rosterVersionsTable)
        .set({
          status: "published",
          publishedAt: new Date(),
          publishedBy: user.id,
        })
        .where(eq(rosterVersionsTable.id, draft.id))
        .returning();
      await tx.insert(auditLogsTable).values({
        actorUserId: user.id,
        action: "roster.published",
        subject: `${draft.month} · v${draft.versionNumber}`,
      });
      return published;
    });
    if (!version) {
      res.status(404).json({ error: "Roster version not found" });
      return;
    }
    if (version === "not-draft") {
      res.status(409).json({ error: "Only a draft roster can be published" });
      return;
    }
    res.json(
      PublishRosterVersionResponse.parse(await versionResponse(version)),
    );
  },
);

router.post(
  "/roster-versions/:versionId/rollback",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = RollbackRosterVersionParams.safeParse(req.params);
    const body = RollbackRosterVersionBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const user = currentAppUser(req);
    const version = await db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.id, params.data.versionId))
        .limit(1);
      if (!source) return null;
      const [maxVersion] = await tx
        .select({ number: rosterVersionsTable.versionNumber })
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.month, source.month))
        .orderBy(desc(rosterVersionsTable.versionNumber))
        .limit(1);
      const [created] = await tx
        .insert(rosterVersionsTable)
        .values({
          month: source.month,
          periodStart: periodForVersion(source).start,
          periodEnd: periodForVersion(source).end,
          versionNumber: (maxVersion?.number ?? 0) + 1,
          status: "draft",
          sourceImportId: source.sourceImportId,
          createdBy: user.id,
        })
        .returning();
      const sourceAssignments = await tx
        .select({
          employeeId: shiftAssignmentsTable.employeeId,
          shiftTypeId: shiftAssignmentsTable.shiftTypeId,
          date: shiftAssignmentsTable.date,
          sourceEmployeeId: shiftAssignmentsTable.sourceEmployeeId,
          sourceEmployeeName: shiftAssignmentsTable.sourceEmployeeName,
          sourceRawShiftValue: shiftAssignmentsTable.sourceRawShiftValue,
          notes: shiftAssignmentsTable.notes,
        })
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.versionId, source.id));
      if (sourceAssignments.length) {
        await tx.insert(shiftAssignmentsTable).values(
          sourceAssignments.map((assignment) => ({
            ...assignment,
            versionId: created.id,
          })),
        );
      }
      await tx.insert(auditLogsTable).values({
        actorUserId: user.id,
        action: "roster.rollback_created",
        subject: `${source.month} · v${source.versionNumber}`,
        details: { reason: body.data.reason, newVersionId: created.id },
      });
      return created;
    });
    if (!version) {
      res.status(404).json({ error: "Roster version not found" });
      return;
    }
    res
      .status(201)
      .json(RollbackRosterVersionResponse.parse(await versionResponse(version)));
  },
);

router.post(
  "/roster-versions/:versionId/assignments",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = CreateRosterAssignmentParams.safeParse(req.params);
    const body = CreateRosterAssignmentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const editable = await ensureEditableRoster(params.data.versionId);
    if (!editable.version) {
      res.status(editable.error === "Roster version not found" ? 404 : 409).json({
        error: editable.error,
      });
      return;
    }
    const versionPeriod = periodForVersion(editable.version);
    if (body.data.date < versionPeriod.start || body.data.date > versionPeriod.end) {
      res.status(400).json({ error: "Shift date must be within the roster period" });
      return;
    }
    try {
      const [created] = await db
        .insert(shiftAssignmentsTable)
        .values({
          versionId: editable.version.id,
          employeeId: body.data.employeeId,
          shiftTypeId: body.data.shiftTypeId,
          date: body.data.date,
          notes: body.data.notes ?? null,
        })
        .returning();
      const assignment = await assignmentById(
        editable.version.id,
        created.id,
      );
      await writeAuditLog({
        actorUserId: currentAppUser(req).id,
        action: "shift_assignment.created",
        subject: `${assignment.employeeName} · ${assignment.date}`,
      });
      res
        .status(201)
        .json(CreateRosterAssignmentResponse.parse(assignment));
    } catch (error) {
      req.log.warn({ err: error }, "Could not create roster assignment");
      res.status(409).json({
        error: "A shift already exists for this employee and date, or a reference is invalid",
      });
    }
  },
);

router.patch(
  "/roster-versions/:versionId/assignments/:assignmentId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateRosterAssignmentParams.safeParse(req.params);
    const body = UpdateRosterAssignmentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const editable = await ensureEditableRoster(params.data.versionId);
    if (!editable.version) {
      res.status(editable.error === "Roster version not found" ? 404 : 409).json({
        error: editable.error,
      });
      return;
    }
    const versionPeriod = periodForVersion(editable.version);
    if (
      body.data.date &&
      (body.data.date < versionPeriod.start || body.data.date > versionPeriod.end)
    ) {
      res.status(400).json({ error: "Shift date must be within the roster period" });
      return;
    }
    try {
      const [updated] = await db
        .update(shiftAssignmentsTable)
        .set({ ...body.data, updatedAt: new Date() })
        .where(
          and(
            eq(shiftAssignmentsTable.id, params.data.assignmentId),
            eq(shiftAssignmentsTable.versionId, params.data.versionId),
          ),
        )
        .returning();
      if (!updated) {
        res.status(404).json({ error: "Assignment not found" });
        return;
      }
      const assignment = await assignmentById(
        editable.version.id,
        updated.id,
      );
      await writeAuditLog({
        actorUserId: currentAppUser(req).id,
        action: "shift_assignment.updated",
        subject: `${assignment.employeeName} · ${assignment.date}`,
      });
      res.json(UpdateRosterAssignmentResponse.parse(assignment));
    } catch (error) {
      req.log.warn({ err: error }, "Could not update roster assignment");
      res.status(409).json({
        error: "A shift already exists for this employee and date, or a reference is invalid",
      });
    }
  },
);

router.delete(
  "/roster-versions/:versionId/assignments/:assignmentId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = DeleteRosterAssignmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const editable = await ensureEditableRoster(params.data.versionId);
    if (!editable.version) {
      res.status(editable.error === "Roster version not found" ? 404 : 409).json({
        error: editable.error,
      });
      return;
    }
    const existing = await assignmentById(
      editable.version.id,
      params.data.assignmentId,
    );
    if (!existing) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    await db
      .delete(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.id, params.data.assignmentId));
    await writeAuditLog({
      actorUserId: currentAppUser(req).id,
      action: "shift_assignment.deleted",
      subject: `${existing.employeeName} · ${existing.date}`,
    });
    res.sendStatus(204);
  },
);

export default router;
