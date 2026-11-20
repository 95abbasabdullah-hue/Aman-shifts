import ExcelJS from "exceljs";
import type {
  ImportIssue,
  ImportMapping,
  StagedAssignment,
} from "@workspace/api-zod";
import {
  matchEmployeeIdentity,
  normalizeIdentityText,
} from "./employeeIdentity";
import { normalizeShiftValue } from "./shiftDefinitions";

export type EmployeeReference = {
  id: string;
  employeeCode: string;
  fullName: string;
  departmentId: string;
  aliases?: string[];
};

export type DepartmentReference = {
  id: string;
  code: string;
  name: string;
};

export type ShiftReference = {
  id: string;
  code: string;
  name: string;
  category: string;
  displayCode: string | null;
};

type SheetCandidate = {
  format: "wide" | "long";
  worksheet: ExcelJS.Worksheet;
  headerRow: number;
  dateColumns: Array<{ column: number; date: string }>;
  periodStart: string;
  periodEnd: string;
  longColumns?: {
    employeeId: number | null;
    employeeName: number | null;
    employeeRole: number | null;
    department: number | null;
    date: number;
    shift: number;
  };
};

export type ParsedRoster = {
  format: "wide" | "long" | "unknown";
  columns: string[];
  mapping: ImportMapping;
  records: StagedAssignment[];
  issues: ImportIssue[];
  periodStart: string | null;
  periodEnd: string | null;
  selectedWorksheet: string | null;
  worksheetChoices: string[];
};

function normalize(value: string): string {
  return normalizeIdentityText(value);
}

function rawCellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    if ("result" in value) return rawCellText(value.result as ExcelJS.CellValue);
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return "";
}

function cellText(value: ExcelJS.CellValue): string {
  return rawCellText(value).trim();
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateFromCell(cell: ExcelJS.Cell, fallbackMonth: string): string | null {
  const value = cell.value;
  if (value instanceof Date) {
    return isoDate(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    );
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1 && value <= 31) {
      const [year, month] = fallbackMonth.split("-").map(Number);
      return isoDate(year, month, value);
    }
    if (value >= 1 && value <= 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
      return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }

  const text = cellText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return isoDate(year, month, day);
  }

  const dmy = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})$/);
  if (dmy) {
    const [, firstPart, secondPart, rawYear] = dmy;
    const first = Number(firstPart);
    const second = Number(secondPart);
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
    const fallbackMonthNumber = Number(fallbackMonth.slice(5, 7));
    const month = first > 12
      ? second
      : second > 12
        ? first
        : first === fallbackMonthNumber
          ? first
          : second === fallbackMonthNumber
            ? second
            : second;
    const day = month === first ? second : first;
    return isoDate(year, month, day);
  }

  const dayOnly = text.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (dayOnly) {
    const [year, month] = fallbackMonth.split("-").map(Number);
    return isoDate(year, month, Number(dayOnly[1]));
  }
  return null;
}

function detectDateHeader(
  worksheet: ExcelJS.Worksheet,
  fallbackMonth: string,
): SheetCandidate | null {
  const candidates: Array<{
    row: number;
    dates: Array<{ column: number; date: string }>;
    continuity: number;
  }> = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const dates: Array<{ column: number; date: string }> = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const date = dateFromCell(row.getCell(column), fallbackMonth);
      if (date) dates.push({ column, date });
    }
    const uniqueDates = new Set(dates.map((item) => item.date));
    if (uniqueDates.size < 2) return;
    const continuity = dates.reduce(
      (score, item, index) =>
        index > 0 && item.column === dates[index - 1].column + 1 ? score + 1 : score,
      0,
    );
    if (dates.length < 7 && continuity < 2) return;
    candidates.push({ row: rowNumber, dates, continuity });
  });

  candidates.sort(
    (a, b) =>
      b.dates.length - a.dates.length ||
      b.continuity - a.continuity ||
      a.row - b.row,
  );
  const best = candidates[0];
  if (!best) return null;

  const dates = [...best.dates].sort((a, b) => a.date.localeCompare(b.date));
  return {
    format: "wide",
    worksheet,
    headerRow: best.row,
    dateColumns: best.dates,
    periodStart: dates[0].date,
    periodEnd: dates[dates.length - 1].date,
  };
}

function detectLongCandidate(
  worksheet: ExcelJS.Worksheet,
  fallbackMonth: string,
  requestedMapping: ImportMapping,
): SheetCandidate | null {
  let candidate: SheetCandidate | null = null;
  worksheet.eachRow({ includeEmpty: false }, (row, headerRow) => {
    if (candidate) return;
    const headers = Array.from(
      { length: Math.max(row.cellCount, worksheet.columnCount) },
      (_, index) => cellText(row.getCell(index + 1).value),
    );
    const dateColumn = explicitColumn(headers, requestedMapping.dateColumn, [
      "date",
      "shift date",
      "roster date",
      "التاريخ",
    ]);
    const shiftColumn = explicitColumn(headers, requestedMapping.shiftCodeColumn, [
      "shift code",
      "shift",
      "duty",
      "الوردية",
    ]);
    if (!dateColumn || !shiftColumn || dateColumn === shiftColumn) return;

    const employeeId = explicitColumn(
      headers,
      requestedMapping.employeeIdColumn,
      ["employee id", "employee code", "staff id", "staff code", "id", "رقم الموظف"],
    );
    const employeeName = explicitColumn(
      headers,
      requestedMapping.employeeNameColumn,
      ["employee name", "staff name", "full name", "name", "employee", "staff", "الاسم"],
    );
    const department = explicitColumn(
      headers,
      requestedMapping.departmentColumn,
      ["department", "unit", "ward", "القسم"],
    );
    const employeeRole = explicitColumn(
      headers,
      requestedMapping.employeeRoleColumn,
      ["role", "position", "job title", "designation"],
    );
    const dates: string[] = [];
    for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const date = dateFromCell(worksheet.getRow(rowNumber).getCell(dateColumn), fallbackMonth);
      if (date) dates.push(date);
    }
    if (!dates.length) return;
    dates.sort();
    candidate = {
      format: "long",
      worksheet,
      headerRow,
      dateColumns: [],
      periodStart: dates[0],
      periodEnd: dates[dates.length - 1],
      longColumns: {
        employeeId,
        employeeName,
        employeeRole,
        department,
        date: dateColumn,
        shift: shiftColumn,
      },
    };
  });
  return candidate;
}

function columnLabel(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function explicitColumn(
  headers: string[],
  explicit: string | null,
  aliases: string[],
): number | null {
  if (explicit) {
    const requested = normalize(explicit);
    const index = headers.findIndex((header) => normalize(header) === requested);
    if (index >= 0) return index + 1;
    if (/^[A-Za-z]{1,3}$/.test(explicit)) {
      return explicit
        .toUpperCase()
        .split("")
        .reduce((column, letter) => column * 26 + letter.charCodeAt(0) - 64, 0);
    }
  }
  const normalizedAliases = aliases.map(normalize);
  const index = headers.findIndex((header) => {
    const normalizedHeader = normalize(header);
    return normalizedAliases.some(
      (alias) => normalizedHeader === alias || normalizedHeader.includes(alias),
    );
  });
  return index >= 0 ? index + 1 : null;
}

function headerAliases(
  worksheet: ExcelJS.Worksheet,
  dateHeaderRow: number,
  column: number,
): string[] {
  const fromRow = Math.max(1, dateHeaderRow - 5);
  const values: string[] = [];
  for (let row = fromRow; row <= dateHeaderRow; row += 1) {
    const value = cellText(worksheet.getRow(row).getCell(column).value);
    if (value) values.push(value);
  }
  return values;
}

function detectColumns(
  worksheet: ExcelJS.Worksheet,
  candidate: SheetCandidate,
  requestedMapping: ImportMapping,
) {
  const dateRow = worksheet.getRow(candidate.headerRow);
  const firstDateColumn = Math.min(...candidate.dateColumns.map((item) => item.column));
  const headers = Array.from(
    { length: Math.max(worksheet.columnCount, dateRow.cellCount) },
    (_, index) => cellText(dateRow.getCell(index + 1).value),
  );
  const precedingColumns = Array.from(
    { length: Math.max(0, firstDateColumn - 1) },
    (_, index) => index + 1,
  );
  const allHeaderValues = new Map(
    precedingColumns.map((column) => [column, headerAliases(worksheet, candidate.headerRow, column)]),
  );
  const findHeaderAlias = (aliases: string[]) => {
    for (const column of precedingColumns) {
      const texts = allHeaderValues.get(column) ?? [];
      if (texts.some((text) => aliases.some((alias) => normalize(text).includes(normalize(alias))))) {
        return column;
      }
    }
    return null;
  };

  const employeeIdColumn =
    explicitColumn(
      headers,
      requestedMapping.employeeIdColumn,
      ["employee id", "employee code", "staff id", "staff code", "id", "الكود", "رقم الموظف"],
    ) ??
    findHeaderAlias(["employee id", "employee code", "staff id", "staff code", "id", "رقم الموظف"]);
  const employeeNameColumn =
    explicitColumn(
      headers,
      requestedMapping.employeeNameColumn,
      ["employee name", "staff name", "full name", "name", "employee", "staff", "الموظف", "الاسم"],
    ) ??
    findHeaderAlias(["employee name", "staff name", "full name", "name", "الموظف", "الاسم"]);
  const departmentColumn =
    explicitColumn(
      headers,
      requestedMapping.departmentColumn,
      ["department", "unit", "ward", "القسم"],
    ) ?? findHeaderAlias(["department", "unit", "ward", "القسم"]);
  const roleColumn =
    explicitColumn(
      headers,
      requestedMapping.employeeRoleColumn,
      ["role", "position", "job title", "designation"],
    ) ??
    findHeaderAlias(["role", "position", "job title", "designation"]);

  const scoreColumns = precedingColumns.map((column) => {
    const values: string[] = [];
    for (let row = candidate.headerRow + 1; row <= worksheet.rowCount; row += 1) {
      const value = cellText(worksheet.getRow(row).getCell(column).value);
      if (value) values.push(value);
    }
    const uniqueRatio = values.length
      ? new Set(values.map(normalize)).size / values.length
      : 0;
    const digitRatio = values.length
      ? values.filter((value) => /\d/.test(value)).length / values.length
      : 0;
    const multiWordRatio = values.length
      ? values.filter((value) => value.trim().split(/\s+/).length >= 2).length / values.length
      : 0;
    const averageLength = values.length
      ? values.reduce((total, value) => total + value.length, 0) / values.length
      : 0;
    const repeatRatio = values.length ? 1 - uniqueRatio : 0;
    return {
      column,
      idScore: uniqueRatio * 2 + digitRatio * 3 + (averageLength <= 20 ? 0.5 : 0),
      nameScore: uniqueRatio + multiWordRatio * 4 + Math.min(averageLength / 20, 1),
      roleScore: repeatRatio * 3 + (averageLength <= 28 ? 0.5 : 0),
    };
  });

  const best = (key: "idScore" | "nameScore" | "roleScore", excluded: number[]) =>
    scoreColumns
      .filter((item) => !excluded.includes(item.column))
      .sort((a, b) => b[key] - a[key])[0]?.column ?? null;

  return {
    headers,
    firstDateColumn,
    employeeIdColumn: employeeIdColumn ?? best("idScore", []),
    employeeNameColumn: employeeNameColumn ?? best("nameScore", employeeIdColumn ? [employeeIdColumn] : []),
    departmentColumn,
    roleColumn: roleColumn ?? best("roleScore", [employeeIdColumn, employeeNameColumn].filter((value): value is number => value !== null)),
  };
}

function matchDepartment(
  value: string,
  departments: DepartmentReference[],
): DepartmentReference | undefined {
  const key = normalize(value);
  if (!key) return undefined;
  return departments.find(
    (department) =>
      normalize(department.code) === key || normalize(department.name) === key,
  );
}

function matchDepartmentFromRole(
  role: string,
  departments: DepartmentReference[],
): DepartmentReference | undefined {
  const key = normalize(role);
  if (!key) return undefined;
  return departments.find((department) => {
    const code = normalize(department.code);
    const name = normalize(department.name);
    const codeToken = new RegExp(
      `(?:^|[^a-z0-9])${department.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
      "i",
    );
    return (
      Boolean(code && (key === code || codeToken.test(role))) ||
      Boolean(name && key.includes(name))
    );
  });
}

function makeIssue(
  code: ImportIssue["code"],
  message: string,
  rowNumber: number | null,
  value: string | null,
): ImportIssue {
  return { code, message, rowNumber, value };
}

function excelColumnName(column: number): string {
  return columnLabel(column);
}

function parseLongCandidate(
  candidate: SheetCandidate,
  requestedMapping: ImportMapping,
  employees: EmployeeReference[],
  shiftTypes: ShiftReference[],
  departments: DepartmentReference[],
  worksheetChoices: string[],
): ParsedRoster {
  const worksheet = candidate.worksheet;
  const columns = candidate.longColumns;
  if (!columns) {
    return {
      format: "unknown",
      columns: [],
      mapping: requestedMapping,
      records: [],
      issues: [
        makeIssue(
          "unsupported_sheet",
          "The detected worksheet is missing its long-format column mapping.",
          candidate.headerRow,
          worksheet.name,
        ),
      ],
      periodStart: candidate.periodStart,
      periodEnd: candidate.periodEnd,
      selectedWorksheet: worksheet.name,
      worksheetChoices,
    };
  }

  const headerRow = worksheet.getRow(candidate.headerRow);
  const headers = Array.from(
    { length: Math.max(headerRow.cellCount, worksheet.columnCount) },
    (_, index) => cellText(headerRow.getCell(index + 1).value),
  );
  const mapping: ImportMapping = {
    format: "long",
    employeeIdColumn: columns.employeeId
      ? headers[columns.employeeId - 1] || columnLabel(columns.employeeId)
      : null,
    employeeNameColumn: columns.employeeName
      ? headers[columns.employeeName - 1] || columnLabel(columns.employeeName)
      : null,
    employeeRoleColumn: columns.employeeRole
      ? headers[columns.employeeRole - 1] || columnLabel(columns.employeeRole)
      : null,
    departmentColumn: columns.department
      ? headers[columns.department - 1] || columnLabel(columns.department)
      : null,
    dateColumn: headers[columns.date - 1] || columnLabel(columns.date),
    shiftCodeColumn: headers[columns.shift - 1] || columnLabel(columns.shift),
    worksheetName: worksheet.name,
  };
  const shiftByCode = new Map(
    shiftTypes.flatMap((shift) => [
      [normalize(shift.code), shift] as const,
      [normalize(shift.name), shift] as const,
    ]),
  );
  const records: StagedAssignment[] = [];
  const issues: ImportIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (item: ImportIssue) => {
    const key = `${item.code}:${item.rowNumber ?? ""}:${item.value ?? ""}:${item.message}`;
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(item);
    }
  };
  const duplicateKeys = new Set<string>();
  let previousEmployeeId = "";
  let previousEmployeeName = "";
  let previousDepartment = "";

  for (
    let rowNumber = candidate.headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    const rawId = columns.employeeId
      ? rawCellText(row.getCell(columns.employeeId).value)
      : "";
    const rawName = columns.employeeName
      ? rawCellText(row.getCell(columns.employeeName).value)
      : "";
    const rawRole = columns.employeeRole
      ? rawCellText(row.getCell(columns.employeeRole).value)
      : "";
    const rawDepartment = columns.department
      ? rawCellText(row.getCell(columns.department).value)
      : "";
    if (rawName) {
      previousEmployeeName = rawName;
      previousEmployeeId = rawId;
    }
    if (rawDepartment.trim()) previousDepartment = rawDepartment;
    const sourceEmployeeId = rawName ? rawId : rawId || previousEmployeeId;
    const hasSourceEmployeeId = Boolean(sourceEmployeeId.trim());
    const sourceEmployeeName = rawName || previousEmployeeName;
    const sourceRole = rawRole;
    const sourceDepartment =
      rawDepartment ||
      previousDepartment ||
      matchDepartmentFromRole(sourceRole, departments)?.code ||
      "";
    const rawDate = row.getCell(columns.date);
    const date = dateFromCell(rawDate, candidate.periodStart.slice(0, 7));
    const rawShiftValue = rawCellText(row.getCell(columns.shift).value);
    if (
      !hasSourceEmployeeId &&
      !sourceEmployeeName &&
      !rawShiftValue &&
      !cellText(rawDate.value)
    ) {
      continue;
    }
    const identity = matchEmployeeIdentity(sourceEmployeeId, sourceEmployeeName, employees);
    const employee = identity.employee;
    const departmentMatch =
      matchDepartment(sourceDepartment, departments) ??
      matchDepartmentFromRole(sourceRole, departments);
    const departmentId = employee?.departmentId ?? departmentMatch?.id ?? null;
    const shiftCode = normalizeShiftValue(rawShiftValue);
    const shift = shiftByCode.get(normalize(shiftCode));
    const duplicateKey = `${date ?? "invalid"}:${employee?.id ?? normalize(sourceEmployeeId.trim() || sourceEmployeeName)}`;
    const duplicate = duplicateKeys.has(duplicateKey);
    if (date) duplicateKeys.add(duplicateKey);

    if (!date) {
      addIssue(
        makeIssue(
          "invalid_date",
          "The row does not contain a valid date value.",
          rowNumber,
          cellText(rawDate.value) || null,
        ),
      );
    }
    if (!hasSourceEmployeeId) {
      addIssue(
        makeIssue(
          "missing_employee_id",
          "This employee row has no source Employee ID and needs Admin review.",
          rowNumber,
          sourceEmployeeName || null,
        ),
      );
    }
    if (!hasSourceEmployeeId && !sourceEmployeeName.trim()) {
      addIssue(
        makeIssue("missing_value", "No employee identifier or name was found.", rowNumber, null),
      );
    } else if (identity.method === "ambiguous_name") {
      addIssue(
        makeIssue(
          "ambiguous_employee",
          "This name matches more than one employee. Choose the correct person.",
          rowNumber,
          sourceEmployeeName,
        ),
      );
    } else if (!employee) {
      addIssue(
        makeIssue(
          "unknown_employee",
          "The source employee does not match the staff directory. Map this row before import.",
          rowNumber,
          sourceEmployeeId.trim() || sourceEmployeeName,
        ),
      );
    }
    if (sourceDepartment && !departmentMatch) {
      addIssue(
        makeIssue(
          "unknown_department",
          "The department could not be matched to a configured department.",
          rowNumber,
          sourceDepartment,
        ),
      );
    } else if (!departmentId) {
      addIssue(
        makeIssue(
          "unknown_department",
          "No department could be identified for this employee row.",
          rowNumber,
          null,
        ),
      );
    }
    if (!shift) {
      addIssue(
        makeIssue(
          "unknown_shift",
          "The shift or attendance code is not configured; map it in the import review.",
          rowNumber,
          shiftCode === "BLANK" ? "(blank cell)" : rawShiftValue.trim(),
        ),
      );
    }
    if (duplicate) {
      addIssue(
        makeIssue(
          "duplicate",
          "The source contains more than one assignment for this employee and date.",
          rowNumber,
          `${date ?? ""} · ${sourceEmployeeId.trim() || sourceEmployeeName}`,
        ),
      );
    }

    records.push({
      rowNumber,
      date,
      sourceEmployeeId: hasSourceEmployeeId ? sourceEmployeeId : null,
      sourceEmployeeName,
      sourceDepartment,
      sourceRole,
      employeeId: employee?.id ?? null,
      employeeCode: employee?.employeeCode ?? (sourceEmployeeId.trim() || null),
      employeeName: employee?.fullName ?? (sourceEmployeeName || "Unmatched employee"),
      departmentId,
      shiftTypeId: shift?.id ?? null,
      shiftCode: shiftCode === "BLANK" ? "" : shift?.displayCode ?? shiftCode,
      rawShiftValue,
      shiftName: shift?.name ?? null,
      valid: Boolean(
        employee &&
          departmentId &&
          hasSourceEmployeeId &&
          date &&
          shift &&
          !duplicate,
      ),
    });
  }

  const rowsWithIssues = new Set(
    issues.map((item) => item.rowNumber).filter((row): row is number => row !== null),
  );
  for (const record of records) {
    record.valid = record.valid && !rowsWithIssues.has(record.rowNumber);
  }
  return {
    format: records.length ? "long" : "unknown",
    columns: headers.filter(Boolean),
    mapping,
    records,
    issues,
    periodStart: candidate.periodStart,
    periodEnd: candidate.periodEnd,
    selectedWorksheet: worksheet.name,
    worksheetChoices,
  };
}

export async function parseRosterWorkbook(
  buffer: Buffer,
  month: string,
  requestedMapping: ImportMapping,
  employees: EmployeeReference[],
  shiftTypes: ShiftReference[],
  departments: DepartmentReference[] = [],
): Promise<ParsedRoster> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const candidates = workbook.worksheets
    .filter((sheet) => sheet.actualRowCount > 0)
    .flatMap((worksheet) => {
      const wideCandidate = detectDateHeader(worksheet, month);
      const candidate =
        wideCandidate ?? detectLongCandidate(worksheet, month, requestedMapping);
      return candidate ? [candidate] : [];
    });
  const latestEnd = candidates
    .map((candidate) => candidate.periodEnd)
    .sort()
    .at(-1);
  const latestCandidates = latestEnd
    ? candidates.filter((candidate) => candidate.periodEnd === latestEnd)
    : [];
  const latestStart = latestCandidates
    .map((candidate) => candidate.periodStart)
    .sort()
    .at(-1);
  const competingCandidates = latestCandidates.filter(
    (candidate) => candidate.periodStart === latestStart,
  );
  const worksheetChoices = competingCandidates.map(
    (candidate) => candidate.worksheet.name,
  );
  const requestedSheet = requestedMapping.worksheetName?.trim() || null;
  const selectedCandidate = requestedSheet
    ? competingCandidates.find((candidate) => candidate.worksheet.name === requestedSheet)
    : competingCandidates.length === 1
      ? competingCandidates[0]
      : null;

  const emptyResult = (
    mapping: ImportMapping,
    issues: ImportIssue[],
    periodStart: string | null = null,
    periodEnd: string | null = null,
    selectedWorksheet: string | null = null,
    choices: string[] = [],
  ): ParsedRoster => ({
    format: "unknown",
    columns: [],
    mapping,
    records: [],
    issues,
    periodStart,
    periodEnd,
    selectedWorksheet,
    worksheetChoices: choices,
  });

  if (!candidates.length) {
    const fallback = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
    return emptyResult(
      requestedMapping,
      [
        makeIssue(
          "unsupported_sheet",
          "No worksheet contains a row of actual date values for a roster period.",
          null,
          fallback?.name ?? null,
        ),
      ],
    );
  }

  if (!selectedCandidate) {
    return emptyResult(
      requestedMapping,
      [
        makeIssue(
          "competing_schedules",
          "Several worksheets contain schedules for the latest date period. Select the correct worksheet to continue.",
          null,
          worksheetChoices.join(", "),
        ),
      ],
      latestStart ?? null,
      latestEnd ?? null,
      null,
      worksheetChoices,
    );
  }

  if (requestedSheet && selectedCandidate.worksheet.name !== requestedSheet) {
    return emptyResult(
      requestedMapping,
      [
        makeIssue(
          "unsupported_sheet",
          "The selected worksheet is not one of the latest schedule candidates.",
          null,
          requestedSheet,
        ),
      ],
      latestStart ?? null,
      latestEnd ?? null,
      null,
      worksheetChoices,
    );
  }

  const worksheet = selectedCandidate.worksheet;
  if (selectedCandidate.format === "long") {
    return parseLongCandidate(
      selectedCandidate,
      requestedMapping,
      employees,
      shiftTypes,
      departments,
      worksheetChoices,
    );
  }
  const layout = detectColumns(worksheet, selectedCandidate, requestedMapping);
  const columns = layout.headers.map((_, index) => columnLabel(index + 1));
  const resolvedMapping: ImportMapping = {
    format: "wide",
    employeeIdColumn: layout.employeeIdColumn
      ? columnLabel(layout.employeeIdColumn)
      : null,
    employeeNameColumn: layout.employeeNameColumn
      ? columnLabel(layout.employeeNameColumn)
      : null,
    employeeRoleColumn: layout.roleColumn
      ? columnLabel(layout.roleColumn)
      : null,
    departmentColumn: layout.departmentColumn
      ? columnLabel(layout.departmentColumn)
      : null,
    dateColumn: null,
    shiftCodeColumn: null,
    worksheetName: worksheet.name,
  };

  const shiftByCode = new Map(
    shiftTypes.flatMap((shift) => [
      [normalize(shift.code), shift] as const,
      [normalize(shift.name), shift] as const,
    ]),
  );

  const records: StagedAssignment[] = [];
  const issues: ImportIssue[] = [];
  const seenIssues = new Set<string>();
  const duplicateKeys = new Set<string>();
  const addIssue = (item: ImportIssue) => {
    const key = `${item.code}:${item.rowNumber ?? ""}:${item.value ?? ""}:${item.message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push(item);
  };
  let currentDepartmentId: string | null = null;
  let currentDepartmentSource = "";
  for (
    let rowNumber = selectedCandidate.headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    const sourceEmployeeId = layout.employeeIdColumn
      ? rawCellText(row.getCell(layout.employeeIdColumn).value)
      : "";
    const hasSourceEmployeeId = Boolean(sourceEmployeeId.trim());
    const sourceEmployeeName = layout.employeeNameColumn
      ? rawCellText(row.getCell(layout.employeeNameColumn).value)
      : "";
    const roleValue = layout.roleColumn
      ? rawCellText(row.getCell(layout.roleColumn).value)
      : "";
    const departmentValue = layout.departmentColumn
      ? rawCellText(row.getCell(layout.departmentColumn).value)
      : "";
    const identity = matchEmployeeIdentity(sourceEmployeeId, sourceEmployeeName, employees);
    const employeeByNameMatch = identity.employee;

    const precedingValues = Array.from(
      { length: layout.firstDateColumn - 1 },
      (_, index) => cellText(row.getCell(index + 1).value),
    ).filter(Boolean);
    const sectionMatches = precedingValues
      .map((value) => matchDepartment(value, departments))
      .filter((department): department is DepartmentReference => Boolean(department));
    const sectionDepartment =
      precedingValues.length > 0 &&
      sectionMatches.length === precedingValues.length &&
      new Set(sectionMatches.map((department) => department.id)).size === 1
        ? sectionMatches[0]
        : undefined;
    if (sectionDepartment) {
      currentDepartmentId = sectionDepartment.id;
      currentDepartmentSource = precedingValues[0] ?? sectionDepartment.code;
    }
    if (departmentValue.trim()) {
      const rowDepartment = matchDepartment(departmentValue, departments);
      if (rowDepartment) {
        currentDepartmentId = rowDepartment.id;
        currentDepartmentSource = departmentValue;
      }
    }

    const isDepartmentLabel = matchDepartment(sourceEmployeeName, departments);
    const shiftCellValues = selectedCandidate.dateColumns.map(({ column }) =>
      rawCellText(row.getCell(column).value).trim(),
    );
    const recognizedRosterValues = shiftCellValues.filter((value) => {
      if (!value) return false;
      return shiftByCode.has(normalize(normalizeShiftValue(value)));
    });
    const hasRosterValues = recognizedRosterValues.length >= 2;
    const sectionToken = sourceEmployeeName.trim();
    const repeatedSectionLabel = Boolean(
      sectionToken &&
        /^[A-Z0-9][A-Z0-9 _&/-]{1,19}$/.test(sectionToken) &&
        shiftCellValues.some(Boolean) &&
        shiftCellValues.every(
          (value) =>
            !value ||
            normalize(value) === normalize(sectionToken),
        ),
    );
    const isUnconfiguredSectionLabel = Boolean(
      (!hasSourceEmployeeId ||
        normalize(sourceEmployeeId) === normalize(sectionToken)) &&
        (!roleValue.trim() || normalize(roleValue) === normalize(sectionToken)) &&
        !employeeByNameMatch &&
        sectionToken === sectionToken.toUpperCase() &&
        /^[A-Z0-9][A-Z0-9 _&/-]{1,19}$/.test(sectionToken) &&
        (shiftCellValues.every((value) => !value) || repeatedSectionLabel),
    );
    if (isUnconfiguredSectionLabel) {
      currentDepartmentId = isDepartmentLabel?.id ?? null;
      currentDepartmentSource = sourceEmployeeName.trim();
      continue;
    }
    const isEmployeeRow = Boolean(
      (hasSourceEmployeeId || sourceEmployeeName.trim()) &&
        !isDepartmentLabel &&
        (hasSourceEmployeeId || roleValue || employeeByNameMatch || hasRosterValues),
    );
    if (!isEmployeeRow) continue;

    const name = sourceEmployeeName.trim();
    const employee = employeeByNameMatch;
    const roleDepartment = matchDepartmentFromRole(roleValue, departments);
    const sourceDepartment =
      (departmentValue.trim() ? departmentValue : "") ||
      currentDepartmentSource ||
      roleDepartment?.code ||
      "";
    const departmentId =
      employee?.departmentId ??
      currentDepartmentId ??
      roleDepartment?.id ??
      null;

    if (!hasSourceEmployeeId) {
      addIssue(
        makeIssue(
          "missing_employee_id",
          "This employee row has no source Employee ID and needs Admin review.",
          rowNumber,
          name || null,
        ),
      );
    }
    if (sourceDepartment && !matchDepartment(sourceDepartment, departments)) {
      addIssue(
        makeIssue(
          "unknown_department",
          "The department could not be matched to a configured department.",
          rowNumber,
          sourceDepartment,
        ),
      );
    }
    if (!departmentId && !sourceDepartment) {
      addIssue(
        makeIssue(
          "unknown_department",
          "No department could be identified for this employee row.",
          rowNumber,
          null,
        ),
      );
    }
    if (
      employee &&
      currentDepartmentId &&
      employee.departmentId !== currentDepartmentId
    ) {
      addIssue(
        makeIssue(
          "unknown_department",
          "The workbook department differs from the employee directory; confirm the employee mapping.",
          rowNumber,
          sourceDepartment || null,
        ),
      );
    }
    if (identity.method === "ambiguous_name") {
      addIssue(
        makeIssue(
          "ambiguous_employee",
          "This name matches more than one employee. Choose the correct person.",
          rowNumber,
          name || null,
        ),
      );
    } else if (!employee) {
      addIssue(
        makeIssue(
          "unknown_employee",
          "The source employee does not match the staff directory. Map this row before import.",
          rowNumber,
          sourceEmployeeId.trim() || name || null,
        ),
      );
    }

    for (const { column, date } of selectedCandidate.dateColumns) {
      const cell = row.getCell(column);
      const rawShiftValue = rawCellText(cell.value);
      const shiftCode = normalizeShiftValue(rawShiftValue);
      const shift = shiftByCode.get(normalize(shiftCode));
      const duplicateKey = `${date}:${employee?.id ?? normalize(sourceEmployeeId.trim() || name)}`;
      const duplicate = duplicateKeys.has(duplicateKey);
      duplicateKeys.add(duplicateKey);

      if (!shift) {
        addIssue(
          makeIssue(
            "unknown_shift",
            "The shift or attendance code is not configured; map it in the import review.",
            rowNumber,
            shiftCode === "BLANK" ? "(blank cell)" : rawShiftValue.trim(),
          ),
        );
      }
      if (duplicate) {
        addIssue(
          makeIssue(
            "duplicate",
            "The source contains more than one assignment for this employee and date.",
            rowNumber,
            `${date} · ${sourceEmployeeId.trim() || name}`,
          ),
        );
      }

      const rowHasInvalidShift = !shift;
      records.push({
        rowNumber,
        date,
        sourceEmployeeId: hasSourceEmployeeId ? sourceEmployeeId : null,
        sourceEmployeeName: sourceEmployeeName,
        sourceDepartment,
        sourceRole: roleValue,
        employeeId: employee?.id ?? null,
        employeeCode: employee?.employeeCode ?? (sourceEmployeeId.trim() || null),
        employeeName: employee?.fullName ?? (name || "Unmatched employee"),
        departmentId,
        shiftTypeId: shift?.id ?? null,
        shiftCode: shiftCode === "BLANK" ? "" : shift?.displayCode ?? shiftCode,
        rawShiftValue,
        shiftName: shift?.name ?? null,
        valid: Boolean(
          employee &&
            departmentId &&
            hasSourceEmployeeId &&
            !rowHasInvalidShift &&
            !duplicate,
        ),
      });
    }
  }

  if (!records.length) {
    addIssue(
      makeIssue(
        "unsupported_sheet",
        "No employee rows were found under the detected date headers.",
        selectedCandidate.headerRow,
        worksheet.name,
      ),
    );
  }

  return {
    format: records.length ? "wide" : "unknown",
    columns,
    mapping: resolvedMapping,
    records,
    issues,
    periodStart: selectedCandidate.periodStart,
    periodEnd: selectedCandidate.periodEnd,
    selectedWorksheet: worksheet.name,
    worksheetChoices,
  };
}

