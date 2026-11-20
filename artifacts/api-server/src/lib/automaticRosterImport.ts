import { createHash } from "node:crypto";
import type { StagedAssignment } from "@workspace/api-zod";
import {
  normalizeEmployeeName,
  normalizeIdentityText,
} from "./employeeIdentity";
import { normalizeShiftValue } from "./shiftDefinitions";
import type { ParsedRoster } from "./rosterImportParser";

export class AutomaticRosterImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_roster"
      | "ambiguous_employee"
      | "department_conflict"
      | "employee_id_conflict",
  ) {
    super(message);
    this.name = "AutomaticRosterImportError";
  }
}

export type AutoImportEmployeeReference = {
  id: string;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  departmentId: string;
  active: boolean;
  aliases: string[];
};

export type AutoImportDepartmentReference = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

export type AutoImportShiftReference = {
  id: string;
  code: string;
  name: string;
  meaning: string | null;
  category: string;
  color: string;
  displayCode: string | null;
  displayInCalendar: boolean;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
};

export type AutoImportReferenceData = {
  employees: AutoImportEmployeeReference[];
  departments: AutoImportDepartmentReference[];
  shiftTypes: AutoImportShiftReference[];
};

export type PlannedDepartment = {
  key: string;
  label: string;
  code: string;
  name: string;
  existingId: string | null;
};

export type PlannedEmployee = {
  key: string;
  sourceEmployeeId: string | null;
  sourceNames: string[];
  fullName: string;
  jobTitle: string;
  departmentKey: string;
  existingId: string | null;
  employeeCode: string;
};

export type PlannedAssignment = {
  record: StagedAssignment;
  employeeKey: string;
  departmentKey: string;
  normalizedShiftCode: string;
  knownShiftTypeId: string | null;
};

export type PlannedAlias = {
  employeeKey: string;
  alias: string;
};

export type AutomaticRosterPlan = {
  periodStart: string;
  periodEnd: string;
  selectedWorksheet: string;
  dates: string[];
  employees: PlannedEmployee[];
  departments: PlannedDepartment[];
  assignments: PlannedAssignment[];
  aliases: PlannedAlias[];
  unknownShiftCounts: Map<string, number>;
};

function fail(
  code: ConstructorParameters<typeof AutomaticRosterImportError>[1],
  message: string,
): never {
  throw new AutomaticRosterImportError(message, code);
}

function stableHash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length).toUpperCase();
}

function stableEmployeeCode(name: string): string {
  return `AUTO-${stableHash(normalizeEmployeeName(name))}`;
}

function isHealthcareAssistantRole(value: string): boolean {
  return /\bHCA\b|HEALTH\s*CARE\s*ASSISTANT/i.test(value.trim());
}

function dateRange(start: string, end: string): string[] {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
    fail("invalid_roster", "The workbook does not contain a valid roster date range.");
  }
  const dates: string[] = [];
  for (let timestamp = startTime; timestamp <= endTime; timestamp += 86400000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function findEmployeeMatches(
  name: string,
  employees: AutoImportEmployeeReference[],
): AutoImportEmployeeReference[] {
  const normalized = normalizeEmployeeName(name);
  if (!normalized) return [];
  return employees.filter(
    (employee) =>
      normalizeEmployeeName(employee.fullName) === normalized ||
      employee.aliases.some((alias) => normalizeEmployeeName(alias) === normalized),
  );
}

function lookupDepartment(
  label: string,
  departments: AutoImportDepartmentReference[],
): AutoImportDepartmentReference | undefined {
  const normalized = normalizeIdentityText(label);
  if (!normalized) return undefined;
  const canonicalCode =
    normalized === "hca" ||
    normalized === "healthcareassistant"
      ? "ed"
      : normalized === "emergency" || normalized === "emergencydepartment"
        ? "ed"
        : normalized === "intensivecare" || normalized === "intensivecareunit"
          ? "icu"
          : normalized;
  if (canonicalCode !== "ed" && canonicalCode !== "icu") return undefined;
  return departments.find(
    (department) =>
      normalizeIdentityText(department.code) === canonicalCode,
  );
}

function identityKey(record: StagedAssignment): string {
  const sourceId = record.sourceEmployeeId?.trim();
  if (sourceId) return `id:${sourceId}`;
  const normalizedName = normalizeEmployeeName(record.sourceEmployeeName);
  if (!normalizedName) {
    fail(
      "invalid_roster",
      `Employee identity is missing at workbook row ${record.rowNumber}.`,
    );
  }
  return `name:${normalizedName}`;
}

function shiftLookupKey(code: string): string {
  return normalizeIdentityText(code);
}

export function importedAttendanceShiftCode(rawCode: string): string {
  const normalized = normalizeShiftValue(rawCode);
  return `IMPORTED_${stableHash(shiftLookupKey(normalized), 12)}`;
}

export function prepareAutomaticRoster(
  parsed: ParsedRoster,
  references: AutoImportReferenceData,
): AutomaticRosterPlan {
  const periodStart = parsed.periodStart;
  const periodEnd = parsed.periodEnd;
  if (!periodStart || !periodEnd || !parsed.selectedWorksheet || !parsed.records.length) {
    fail(
      "invalid_roster",
      "No complete schedule was found. The existing published roster was not changed.",
    );
  }
  const blockingIssues = parsed.issues.filter((issue) =>
    [
      "invalid_date",
      "duplicate",
      "competing_schedules",
      "unsupported_sheet",
      "missing_value",
      "ambiguous_employee",
    ].includes(issue.code),
  );
  if (blockingIssues.length) {
    const first = blockingIssues[0]!;
    fail(
      first.code === "ambiguous_employee" ? "ambiguous_employee" : "invalid_roster",
      first.message,
    );
  }

  const dates = dateRange(periodStart, periodEnd);
  const dateSet = new Set(dates);
  const workbookDates = distinct(
    parsed.records.flatMap((record) => (record.date ? [record.date] : [])),
  ).sort();
  if (
    workbookDates.length !== dates.length ||
    workbookDates.some((date, index) => date !== dates[index])
  ) {
    fail(
      "invalid_roster",
      "The detected date columns are incomplete or contain invalid gaps. The existing published roster was not changed.",
    );
  }

  const identityRecords = new Map<string, StagedAssignment[]>();
  for (const record of parsed.records) {
    if (!record.date || !dateSet.has(record.date)) {
      fail(
        "invalid_roster",
        `A shift row has an invalid or out-of-range date at workbook row ${record.rowNumber}.`,
      );
    }
    const key = identityKey(record);
    const group = identityRecords.get(key) ?? [];
    group.push(record);
    identityRecords.set(key, group);
  }

  const usedCodes = new Set(references.employees.map((employee) => employee.employeeCode.trim()));
  const usedNames = new Map<string, AutoImportEmployeeReference[]>();
  for (const employee of references.employees) {
    const names = [employee.fullName, ...employee.aliases];
    for (const name of names) {
      const key = normalizeEmployeeName(name);
      if (!key) continue;
      const matches = usedNames.get(key) ?? [];
      matches.push(employee);
      usedNames.set(key, matches);
    }
  }

  const departmentsByKey = new Map<string, PlannedDepartment>();
  const employees: PlannedEmployee[] = [];
  const employeeByIdentityKey = new Map<string, PlannedEmployee>();
  const pendingAliases = new Map<string, { employeeKey: string; alias: string }>();

  for (const [key, records] of identityRecords) {
    const sourceIds = distinct(
      records
        .map((record) => record.sourceEmployeeId?.trim() ?? "")
        .filter(Boolean),
    );
    if (sourceIds.length > 1) {
      fail("invalid_roster", "A roster row contains conflicting Employee IDs.");
    }
    const sourceEmployeeId = sourceIds[0] ?? null;
    const sourceNames = distinct(
      records
        .map((record) => record.sourceEmployeeName.trim())
        .filter(Boolean),
    );
    const fullName = sourceNames[0] ?? "";
    if (!fullName) {
      fail("invalid_roster", `Employee ID ${sourceEmployeeId ?? ""} has no name in the workbook.`);
    }

    const sourceDepartments = distinct(
      records
        .map((record) => record.sourceDepartment.trim())
        .filter(Boolean)
        .map((label) => {
          const match = lookupDepartment(label, references.departments);
          return match ? `id:${match.id}` : `label:${normalizeIdentityText(label)}`;
        }),
    );
    const recordDepartmentIds = distinct(
      records
        .map((record) => record.departmentId)
        .filter((id): id is string => Boolean(id)),
    );
    const employeeById = sourceEmployeeId
      ? references.employees.find((employee) => employee.employeeCode.trim() === sourceEmployeeId)
      : undefined;
    const nameMatches = findEmployeeMatches(fullName, references.employees);

    let existingEmployee: AutoImportEmployeeReference | undefined;
    if (sourceEmployeeId) {
      existingEmployee = employeeById;
      if (!existingEmployee && nameMatches.length) {
        fail(
          "employee_id_conflict",
          `Employee ID "${sourceEmployeeId}" is not registered, but the name matches an existing employee. The upload was rejected instead of guessing.`,
        );
      }
    } else if (nameMatches.length > 1) {
      fail(
        "ambiguous_employee",
        `The name "${fullName}" matches multiple employees. The upload was rejected instead of guessing.`,
      );
    } else {
      existingEmployee = nameMatches[0];
    }

    if (sourceDepartments.length > 1 || recordDepartmentIds.length > 1) {
      fail(
        "department_conflict",
        `Employee "${fullName}" is assigned to more than one department in this workbook.`,
      );
    }

    const existingDepartment = existingEmployee
      ? references.departments.find(
          (department) => department.id === existingEmployee.departmentId,
        )
      : recordDepartmentIds.length
        ? references.departments.find(
            (department) => department.id === recordDepartmentIds[0],
          )
        : undefined;
    const rawDepartmentLabel =
      records.find((record) => record.sourceDepartment.trim())?.sourceDepartment.trim() ??
      existingDepartment?.code ??
      "";
    const matchedDepartment = rawDepartmentLabel
      ? lookupDepartment(rawDepartmentLabel, references.departments)
      : existingDepartment;
    if (!rawDepartmentLabel && !matchedDepartment) {
      fail(
        "department_conflict",
        `No department could be identified for "${fullName}". The existing published roster was not changed.`,
      );
    }
    if (!matchedDepartment) {
      fail(
        "department_conflict",
        `Department "${rawDepartmentLabel}" for "${fullName}" is unsupported. Use Emergency (ED) or Intensive Care (ICU); the published roster was not changed.`,
      );
    }
    const healthcareAssistant =
      isHealthcareAssistantRole(existingEmployee?.jobTitle ?? "") ||
      records.some((record) => isHealthcareAssistantRole(record.sourceRole)) ||
      normalizeIdentityText(rawDepartmentLabel) === "hca";
    if (healthcareAssistant && matchedDepartment.code !== "ED") {
      fail(
        "department_conflict",
        `Healthcare Assistant "${fullName}" must belong to Emergency (ED), not ${matchedDepartment.name}. The published roster was not changed.`,
      );
    }
    const departmentKey = matchedDepartment
      ? `id:${matchedDepartment.id}`
      : `label:${normalizeIdentityText(rawDepartmentLabel)}`;
    let department = departmentsByKey.get(departmentKey);
    if (!department) {
      department = {
        key: departmentKey,
        label: rawDepartmentLabel || matchedDepartment!.name,
        code: matchedDepartment.code,
        name: matchedDepartment.name,
        existingId: matchedDepartment.id,
      };
      departmentsByKey.set(departmentKey, department);
    }

    const normalizedName = normalizeEmployeeName(fullName);
    const employeeCode =
      existingEmployee?.employeeCode ??
      sourceEmployeeId ??
      stableEmployeeCode(fullName);
    if (!existingEmployee && usedCodes.has(employeeCode)) {
      fail(
        "employee_id_conflict",
        `Employee ID "${employeeCode}" is already in use by another identity.`,
      );
    }
    const newNameMatch = usedNames.get(normalizedName) ?? [];
    if (!existingEmployee && newNameMatch.length) {
      fail(
        "ambiguous_employee",
        `The name "${fullName}" matches an existing employee. The upload was rejected instead of creating a duplicate.`,
      );
    }

    const sourceRole =
      records.find((record) => record.sourceRole.trim())?.sourceRole.trim() ?? "";
    const employee: PlannedEmployee = {
      key,
      sourceEmployeeId,
      sourceNames,
      fullName: existingEmployee?.fullName ?? fullName,
      jobTitle: healthcareAssistant
        ? "Healthcare Assistant"
        : (existingEmployee?.jobTitle ?? sourceRole) || "Unspecified role",
      departmentKey,
      existingId: existingEmployee?.id ?? null,
      employeeCode,
    };
    employees.push(employee);
    employeeByIdentityKey.set(key, employee);
    if (!existingEmployee) {
      usedCodes.add(employeeCode);
      const sameName = usedNames.get(normalizedName) ?? [];
      sameName.push({
        id: `new:${key}`,
        employeeCode,
        fullName,
        jobTitle: employee.jobTitle,
        departmentId: department.existingId ?? "",
        active: true,
        aliases: [],
      });
      usedNames.set(normalizedName, sameName);
    }

    if (existingEmployee) {
      for (const alias of sourceNames) {
        const aliasKey = normalizeEmployeeName(alias);
        const canonicalKey = normalizeEmployeeName(existingEmployee.fullName);
        if (!aliasKey || aliasKey === canonicalKey) continue;
        const nameConflicts = usedNames.get(aliasKey) ?? [];
        if (nameConflicts.some((candidate) => candidate.id !== existingEmployee.id)) {
          fail(
            "ambiguous_employee",
            `The imported name "${alias}" is already associated with another employee.`,
          );
        }
        const previousAlias = pendingAliases.get(aliasKey);
        if (previousAlias && previousAlias.employeeKey !== key) {
          fail(
            "ambiguous_employee",
            `The imported name "${alias}" belongs to more than one Employee ID.`,
          );
        }
        pendingAliases.set(aliasKey, { employeeKey: key, alias });
      }
    }
  }

  const shiftByKey = new Map<string, AutoImportShiftReference>();
  for (const shift of references.shiftTypes) {
    shiftByKey.set(shiftLookupKey(shift.code), shift);
    if (shift.displayCode) shiftByKey.set(shiftLookupKey(shift.displayCode), shift);
  }
  const unknownShiftCounts = new Map<string, number>();
  const assignments: PlannedAssignment[] = [];
  const seenAssignments = new Set<string>();
  for (const record of parsed.records) {
    const employee = employeeByIdentityKey.get(identityKey(record));
    if (!employee) {
      fail("invalid_roster", "An employee row could not be resolved.");
    }
    const department = departmentsByKey.get(employee.departmentKey);
    if (!department) {
      fail("department_conflict", `No department was identified for "${employee.fullName}".`);
    }
    const code = normalizeShiftValue(record.rawShiftValue);
    const normalizedCode = shiftLookupKey(code);
    const shift = shiftByKey.get(normalizedCode);
    const assignmentKey = `${employee.key}:${record.date}`;
    if (seenAssignments.has(assignmentKey)) {
      fail(
        "invalid_roster",
        `More than one shift was found for "${employee.fullName}" on ${record.date}.`,
      );
    }
    seenAssignments.add(assignmentKey);
    if (!shift && code !== "BLANK") {
      unknownShiftCounts.set(code, (unknownShiftCounts.get(code) ?? 0) + 1);
    }
    assignments.push({
      record,
      employeeKey: employee.key,
      departmentKey: department.key,
      normalizedShiftCode: code,
      knownShiftTypeId: shift?.id ?? null,
    });
  }

  if (parsed.format === "wide") {
    const expected = dates.length;
    for (const employee of employees) {
      const assignedDates = new Set(
        assignments
          .filter((assignment) => assignment.employeeKey === employee.key)
          .map((assignment) => assignment.record.date),
      );
      if (assignedDates.size !== expected) {
        fail(
          "invalid_roster",
          `The workbook is missing one or more dates for "${employee.fullName}". The existing published roster was not changed.`,
        );
      }
    }
  }

  for (const [aliasKey, alias] of pendingAliases) {
    const aliasUsers = usedNames.get(aliasKey) ?? [];
    const plannedUser = employees.find((employee) => employee.key === alias.employeeKey);
    if (!plannedUser || aliasUsers.some((candidate) => candidate.id !== plannedUser.existingId)) {
      fail(
        "ambiguous_employee",
        `The imported name "${alias.alias}" conflicts with another employee identity.`,
      );
    }
  }

  return {
    periodStart,
    periodEnd,
    selectedWorksheet: parsed.selectedWorksheet,
    dates,
    employees,
    departments: [...departmentsByKey.values()],
    assignments,
    aliases: [...pendingAliases.values()],
    unknownShiftCounts,
  };
}
