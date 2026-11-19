import { Router, type IRouter } from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
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

async function versionsForMonth(month: string) {
  return db
    .select()
    .from(rosterVersionsTable)
    .where(eq(rosterVersionsTable.month, month))
    .orderBy(desc(rosterVersionsTable.versionNumber));
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
) {
  const conditions = [eq(shiftAssignmentsTable.versionId, versionId)];
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
      shiftCode: shiftTypesTable.code,
      shiftName: shiftTypesTable.name,
      shiftColor: shiftTypesTable.color,
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
    .orderBy(asc(shiftAssignmentsTable.date), asc(employeesTable.fullName));
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
      shiftCode: shiftTypesTable.code,
      shiftName: shiftTypesTable.name,
      shiftColor: shiftTypesTable.color,
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
  return assignment;
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
    .where(eq(shiftAssignmentsTable.versionId, version.id));
  return {
    id: version.id,
    month: version.month,
    versionNumber: version.versionNumber,
    status: version.status,
    sourceImportId: version.sourceImportId,
    createdByName: creator?.fullName ?? "Aman admin",
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    assignmentCount: Number(assignmentCount.count),
  };
}

async function ensureDraft(versionId: string) {
  const version = await getVersion(versionId);
  if (!version) return { error: "Roster version not found" as const };
  if (version.status !== "draft") {
    return { error: "Only draft roster versions can be changed" as const };
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
  const [pendingImports] = await db
    .select({ count: count(importJobsTable.id) })
    .from(importJobsTable)
    .where(
      and(
        eq(importJobsTable.month, month),
        inArray(importJobsTable.status, ["needs_review", "ready"]),
      ),
    );
  const published = (await versionsForMonth(month)).find(
    (version) => version.status === "published",
  );
  const assignments = published
    ? await db
        .select({ count: count(shiftAssignmentsTable.id) })
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.versionId, published.id))
    : [{ count: 0 }];
  res.json(
    GetDashboardSummaryResponse.parse({
      month,
      employeeCount: Number(employeeCount.count),
      departmentCount: Number(departmentCount.count),
      assignedShiftCount: Number(assignments[0]?.count ?? 0),
      importReviewCount: Number(pendingImports.count),
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

router.get("/schedule/month", async (req, res): Promise<void> => {
  const query = GetMonthlyScheduleQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const user = currentAppUser(req);
  const version = await visibleVersion(query.data.month, user.role === "admin");
  const assignments = version
    ? await scheduleAssignments(version.id, query.data.departmentId)
    : [];
  res.json(
    GetMonthlyScheduleResponse.parse(
      schedulePayload(query.data.month, version ?? null, assignments),
    ),
  );
});

router.get("/schedule/mine", async (req, res): Promise<void> => {
  const query = GetMyScheduleQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const user = currentAppUser(req);
  const version = (await versionsForMonth(query.data.month)).find(
    (candidate) => candidate.status === "published",
  );
  const assignments =
    version && user.employeeId
      ? await scheduleAssignments(version.id, undefined, user.employeeId)
      : [];
  res.json(
    GetMyScheduleResponse.parse(
      schedulePayload(query.data.month, version ?? null, assignments),
    ),
  );
});

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
      const [latest] = await tx
        .select()
        .from(rosterVersionsTable)
        .where(
          and(
            eq(rosterVersionsTable.month, body.data.month),
            inArray(rosterVersionsTable.status, ["published", "draft"]),
          ),
        )
        .orderBy(desc(rosterVersionsTable.versionNumber))
        .limit(1);
      const [nextNumber] = await tx
        .select({ max: count(rosterVersionsTable.id) })
        .from(rosterVersionsTable)
        .where(eq(rosterVersionsTable.month, body.data.month));
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
          versionNumber,
          status: "draft",
          createdBy: user.id,
        })
        .returning();
      void nextNumber;
      if (body.data.copyPublished && latest) {
        const base =
          latest.status === "published"
            ? latest
            : (
                await tx
                  .select()
                  .from(rosterVersionsTable)
                  .where(
                    and(
                      eq(rosterVersionsTable.month, body.data.month),
                      eq(rosterVersionsTable.status, "published"),
                    ),
                  )
                  .orderBy(desc(rosterVersionsTable.versionNumber))
                  .limit(1)
              )[0];
        if (base) {
          const sourceAssignments = await tx
            .select({
              employeeId: shiftAssignmentsTable.employeeId,
              shiftTypeId: shiftAssignmentsTable.shiftTypeId,
              date: shiftAssignmentsTable.date,
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
  async (req, res): Promise<void> => {
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
  },
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
      await tx
        .update(rosterVersionsTable)
        .set({ status: "archived" })
        .where(
          and(
            eq(rosterVersionsTable.month, draft.month),
            eq(rosterVersionsTable.status, "published"),
          ),
        );
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
    const draft = await ensureDraft(params.data.versionId);
    if (!draft.version) {
      res.status(draft.error === "Roster version not found" ? 404 : 409).json({
        error: draft.error,
      });
      return;
    }
    if (!body.data.date.startsWith(`${draft.version.month}-`)) {
      res.status(400).json({ error: "Shift date must be within the roster month" });
      return;
    }
    try {
      const [created] = await db
        .insert(shiftAssignmentsTable)
        .values({
          versionId: draft.version.id,
          employeeId: body.data.employeeId,
          shiftTypeId: body.data.shiftTypeId,
          date: body.data.date,
          notes: body.data.notes ?? null,
        })
        .returning();
      const assignment = await assignmentById(
        draft.version.id,
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
    const draft = await ensureDraft(params.data.versionId);
    if (!draft.version) {
      res.status(draft.error === "Roster version not found" ? 404 : 409).json({
        error: draft.error,
      });
      return;
    }
    if (body.data.date && !body.data.date.startsWith(`${draft.version.month}-`)) {
      res.status(400).json({ error: "Shift date must be within the roster month" });
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
        draft.version.id,
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
    const draft = await ensureDraft(params.data.versionId);
    if (!draft.version) {
      res.status(draft.error === "Roster version not found" ? 404 : 409).json({
        error: draft.error,
      });
      return;
    }
    const existing = await assignmentById(
      draft.version.id,
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
