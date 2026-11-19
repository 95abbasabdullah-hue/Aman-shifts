import { Router, type IRouter } from "express";
import {
  and,
  asc,
  count,
  eq,
  ilike,
  or,
} from "drizzle-orm";
import {
  CreateDepartmentBody,
  CreateDepartmentResponse,
  CreateEmployeeBody,
  CreateEmployeeResponse,
  CreateShiftTypeBody,
  CreateShiftTypeResponse,
  ListDepartmentsResponse,
  ListEmployeesQueryParams,
  ListEmployeesResponse,
  ListShiftTypesResponse,
  UpdateDepartmentBody,
  UpdateDepartmentParams,
  UpdateDepartmentResponse,
  UpdateEmployeeBody,
  UpdateEmployeeParams,
  UpdateEmployeeResponse,
  UpdateShiftTypeBody,
  UpdateShiftTypeParams,
  UpdateShiftTypeResponse,
} from "@workspace/api-zod";
import {
  db,
  departmentsTable,
  employeesTable,
  shiftTypesTable,
} from "@workspace/db";
import { currentAppUser, requireAdmin } from "../lib/amanAuth";
import { writeAuditLog } from "../lib/audit";

const router: IRouter = Router();

router.get("/departments", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: departmentsTable.id,
      code: departmentsTable.code,
      name: departmentsTable.name,
      timezone: departmentsTable.timezone,
      employeeCount: count(employeesTable.id),
    })
    .from(departmentsTable)
    .leftJoin(
      employeesTable,
      and(
        eq(employeesTable.departmentId, departmentsTable.id),
        eq(employeesTable.active, true),
      ),
    )
    .where(eq(departmentsTable.active, true))
    .groupBy(
      departmentsTable.id,
      departmentsTable.code,
      departmentsTable.name,
      departmentsTable.timezone,
    )
    .orderBy(asc(departmentsTable.name));

  res.json(
    ListDepartmentsResponse.parse(
      rows.map((row) => ({ ...row, employeeCount: Number(row.employeeCount) })),
    ),
  );
});

router.post("/departments", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateDepartmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [department] = await db
      .insert(departmentsTable)
      .values(parsed.data)
      .returning();
    const [employeeCount] = await db
      .select({ count: count(employeesTable.id) })
      .from(employeesTable)
      .where(eq(employeesTable.departmentId, department.id));
    const result = CreateDepartmentResponse.parse({
      ...department,
      employeeCount: Number(employeeCount.count),
    });
    await writeAuditLog({
      actorUserId: currentAppUser(req).id,
      action: "department.created",
      subject: department.name,
    });
    res.status(201).json(result);
  } catch (error) {
    req.log.warn({ err: error }, "Could not create department");
    res.status(409).json({ error: "A department with this code already exists" });
  }
});

router.patch(
  "/departments/:departmentId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateDepartmentParams.safeParse(req.params);
    const body = UpdateDepartmentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    const [department] = await db
      .update(departmentsTable)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(departmentsTable.id, params.data.departmentId))
      .returning();
    if (!department) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    const [employeeCount] = await db
      .select({ count: count(employeesTable.id) })
      .from(employeesTable)
      .where(eq(employeesTable.departmentId, department.id));
    await writeAuditLog({
      actorUserId: currentAppUser(req).id,
      action: "department.updated",
      subject: department.name,
    });
    res.json(
      UpdateDepartmentResponse.parse({
        ...department,
        employeeCount: Number(employeeCount.count),
      }),
    );
  },
);

router.get(
  "/employees",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = ListEmployeesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const conditions = [];
    if (parsed.data.departmentId) {
      conditions.push(
        eq(employeesTable.departmentId, parsed.data.departmentId),
      );
    }
    if (parsed.data.activeOnly !== false) {
      conditions.push(eq(employeesTable.active, true));
    }
    if (parsed.data.search?.trim()) {
      const search = `%${parsed.data.search.trim()}%`;
      conditions.push(
        or(
          ilike(employeesTable.fullName, search),
          ilike(employeesTable.employeeCode, search),
          ilike(employeesTable.jobTitle, search),
          ilike(employeesTable.email, search),
        )!,
      );
    }
    const rows = await db
      .select({
        id: employeesTable.id,
        employeeCode: employeesTable.employeeCode,
        fullName: employeesTable.fullName,
        jobTitle: employeesTable.jobTitle,
        departmentId: employeesTable.departmentId,
        departmentName: departmentsTable.name,
        email: employeesTable.email,
        photoPath: employeesTable.photoPath,
        active: employeesTable.active,
      })
      .from(employeesTable)
      .innerJoin(
        departmentsTable,
        eq(departmentsTable.id, employeesTable.departmentId),
      )
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(employeesTable.fullName));
    res.json(ListEmployeesResponse.parse(rows));
  },
);

async function employeeResponse(id: string) {
  const [employee] = await db
    .select({
      id: employeesTable.id,
      employeeCode: employeesTable.employeeCode,
      fullName: employeesTable.fullName,
      jobTitle: employeesTable.jobTitle,
      departmentId: employeesTable.departmentId,
      departmentName: departmentsTable.name,
      email: employeesTable.email,
      photoPath: employeesTable.photoPath,
      active: employeesTable.active,
    })
    .from(employeesTable)
    .innerJoin(
      departmentsTable,
      eq(departmentsTable.id, employeesTable.departmentId),
    )
    .where(eq(employeesTable.id, id))
    .limit(1);
  return employee;
}

router.post("/employees", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [created] = await db
      .insert(employeesTable)
      .values(parsed.data)
      .returning({ id: employeesTable.id });
    const employee = await employeeResponse(created.id);
    await writeAuditLog({
      actorUserId: currentAppUser(req).id,
      action: "employee.created",
      subject: employee.fullName,
    });
    res.status(201).json(CreateEmployeeResponse.parse(employee));
  } catch (error) {
    req.log.warn({ err: error }, "Could not create employee");
    res
      .status(409)
      .json({ error: "Employee code or email is already in use" });
  }
});

router.patch(
  "/employees/:employeeId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateEmployeeParams.safeParse(req.params);
    const body = UpdateEmployeeBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    try {
      const [updated] = await db
        .update(employeesTable)
        .set({ ...body.data, updatedAt: new Date() })
        .where(eq(employeesTable.id, params.data.employeeId))
        .returning({ id: employeesTable.id });
      if (!updated) {
        res.status(404).json({ error: "Employee not found" });
        return;
      }
      const employee = await employeeResponse(updated.id);
      await writeAuditLog({
        actorUserId: currentAppUser(req).id,
        action: body.data.active === false ? "employee.deactivated" : "employee.updated",
        subject: employee.fullName,
      });
      res.json(UpdateEmployeeResponse.parse(employee));
    } catch (error) {
      req.log.warn({ err: error }, "Could not update employee");
      res
        .status(409)
        .json({ error: "Employee code or email is already in use" });
    }
  },
);

router.get("/shift-types", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: shiftTypesTable.id,
      code: shiftTypesTable.code,
      name: shiftTypesTable.name,
      color: shiftTypesTable.color,
      startsAt: shiftTypesTable.startsAt,
      endsAt: shiftTypesTable.endsAt,
      active: shiftTypesTable.active,
    })
    .from(shiftTypesTable)
    .where(eq(shiftTypesTable.active, true))
    .orderBy(asc(shiftTypesTable.name));
  res.json(ListShiftTypesResponse.parse(rows));
});

router.post(
  "/shift-types",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = CreateShiftTypeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const [shiftType] = await db
        .insert(shiftTypesTable)
        .values(parsed.data)
        .returning();
      const result = CreateShiftTypeResponse.parse(shiftType);
      await writeAuditLog({
        actorUserId: currentAppUser(req).id,
        action: "shift_type.created",
        subject: shiftType.name,
      });
      res.status(201).json(result);
    } catch (error) {
      req.log.warn({ err: error }, "Could not create shift type");
      res.status(409).json({ error: "A shift type with this code already exists" });
    }
  },
);

router.patch(
  "/shift-types/:shiftTypeId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateShiftTypeParams.safeParse(req.params);
    const body = UpdateShiftTypeBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: params.success
          ? body.error?.message ?? "Invalid request body"
          : params.error.message,
      });
      return;
    }
    try {
      const [shiftType] = await db
        .update(shiftTypesTable)
        .set({ ...body.data, updatedAt: new Date() })
        .where(eq(shiftTypesTable.id, params.data.shiftTypeId))
        .returning();
      if (!shiftType) {
        res.status(404).json({ error: "Shift type not found" });
        return;
      }
      await writeAuditLog({
        actorUserId: currentAppUser(req).id,
        action: "shift_type.updated",
        subject: shiftType.name,
      });
      res.json(UpdateShiftTypeResponse.parse(shiftType));
    } catch (error) {
      req.log.warn({ err: error }, "Could not update shift type");
      res.status(409).json({ error: "A shift type with this code already exists" });
    }
  },
);

export default router;
