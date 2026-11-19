import ExcelJS from "exceljs";
import type {
  ImportIssue,
  ImportMapping,
  StagedAssignment,
} from "@workspace/api-zod";

type EmployeeReference = {
  id: string;
  employeeCode: string;
  fullName: string;
  departmentId: string;
};

type ShiftReference = {
  id: string;
  code: string;
  name: string;
};

export type ParsedRoster = {
  format: "wide" | "long" | "unknown";
  columns: string[];
  mapping: ImportMapping;
  records: StagedAssignment[];
  issues: ImportIssue[];
};

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/gu, "");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("").trim();
    }
  }
  return "";
}

function dateFromCell(value: ExcelJS.CellValue, month: string): string | null {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1 && value <= 31) {
      return `${month}-${String(value).padStart(2, "0")}`;
    }
    if (value >= 1 && value <= 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    }
  }

  const text = cellText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dmy = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})$/);
  if (dmy) {
    const [, dayOrMonth, monthOrDay, rawYear] = dmy;
    const first = Number(dayOrMonth);
    const second = Number(monthOrDay);
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
    const selectedMonth = Number(month.slice(5, 7));
    let day: number;
    let monthNumber: number;
    if (first > 12) {
      day = first;
      monthNumber = second;
    } else if (second > 12) {
      day = second;
      monthNumber = first;
    } else if (first === selectedMonth && second !== selectedMonth) {
      monthNumber = first;
      day = second;
    } else if (second === selectedMonth && first !== selectedMonth) {
      monthNumber = second;
      day = first;
    } else {
      day = first;
      monthNumber = second;
    }
    const candidate = new Date(Date.UTC(year, monthNumber - 1, day));
    if (
      monthNumber >= 1 &&
      monthNumber <= 12 &&
      day >= 1 &&
      candidate.getUTCMonth() === monthNumber - 1 &&
      candidate.getUTCDate() === day
    ) {
      return `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const dayOnly = text.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) return `${month}-${String(day).padStart(2, "0")}`;
  }

  const monthDay = text.match(/^(\d{1,2})[\s-]([a-z]{3,})$/i);
  if (monthDay) {
    const parsed = new Date(`${monthDay[2]} ${monthDay[1]}, ${month.slice(0, 4)} 12:00:00 UTC`);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
    }
  }
  return null;
}

function isBlankShift(
  value: ExcelJS.CellValue,
  knownShifts: Map<string, ShiftReference>,
): boolean {
  const text = normalize(cellText(value));
  if (!text || text === "-") return true;
  return ["off", "rest"].includes(text) && !knownShifts.has(text);
}

function findColumn(
  headers: string[],
  explicit: string | null,
  aliases: string[],
): number | null {
  if (explicit) {
    const requested = normalize(explicit);
    const index = headers.findIndex((header) => normalize(header) === requested);
    if (index >= 0) return index + 1;
  }
  const normalizedAliases = aliases.map(normalize);
  const index = headers.findIndex((header) => {
    const normalized = normalize(header);
    return normalizedAliases.some(
      (alias) => normalized === alias || normalized.includes(alias),
    );
  });
  return index >= 0 ? index + 1 : null;
}

function detectHeaderRow(worksheet: ExcelJS.Worksheet): number {
  let bestRow = 1;
  let bestScore = -1;
  const keywords = [
    "employee",
    "staff",
    "name",
    "date",
    "shift",
    "code",
    "department",
    "الموظف",
    "التاريخ",
    "الوردية",
  ].map(normalize);

  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
    const values = worksheet.getRow(rowNumber).values as ExcelJS.CellValue[];
    const texts = values.map(cellText).filter(Boolean);
    const keywordCount = texts.filter((text) =>
      keywords.some((keyword) => normalize(text).includes(keyword)),
    ).length;
    const score = texts.length + keywordCount * 4;
    if (texts.length >= 2 && score > bestScore) {
      bestScore = score;
      bestRow = rowNumber;
    }
  }
  return bestRow;
}

function issue(
  code: ImportIssue["code"],
  message: string,
  rowNumber: number | null,
  value: string | null,
): ImportIssue {
  return { code, message, rowNumber, value };
}

export async function parseRosterWorkbook(
  buffer: Buffer,
  month: string,
  requestedMapping: ImportMapping,
  employees: EmployeeReference[],
  shiftTypes: ShiftReference[],
): Promise<ParsedRoster> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const worksheet = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
  if (!worksheet) {
    return {
      format: "unknown",
      columns: [],
      mapping: requestedMapping,
      records: [],
      issues: [
        issue(
          "unsupported_sheet",
          "The workbook has no non-empty worksheet.",
          null,
          null,
        ),
      ],
    };
  }

  const headerRowNumber = detectHeaderRow(worksheet);
  const headerRow = worksheet.getRow(headerRowNumber);
  const columnCount = Math.max(headerRow.cellCount, worksheet.columnCount);
  const headers = Array.from({ length: columnCount }, (_, index) =>
    cellText(headerRow.getCell(index + 1).value),
  );
  const columns = headers.filter(Boolean);
  const employeeIdColumn = findColumn(
    headers,
    requestedMapping.employeeIdColumn,
    ["employee id", "employee code", "staff id", "staff code", "id", "الكود", "رقم الموظف"],
  );
  const employeeNameColumn = findColumn(
    headers,
    requestedMapping.employeeNameColumn,
    ["employee name", "staff name", "full name", "name", "employee", "staff", "الموظف", "الاسم"],
  );
  const departmentColumn = findColumn(
    headers,
    requestedMapping.departmentColumn,
    ["department", "unit", "ward", "القسم"],
  );
  const dateColumn = findColumn(
    headers,
    requestedMapping.dateColumn,
    ["date", "shift date", "التاريخ"],
  );
  const shiftCodeColumn = findColumn(
    headers,
    requestedMapping.shiftCodeColumn,
    ["shift code", "shift", "duty", "code", "الوردية"],
  );

  const resolvedMapping: ImportMapping = {
    format:
      requestedMapping.format === "auto"
        ? dateColumn && shiftCodeColumn
          ? "long"
          : "wide"
        : requestedMapping.format,
    employeeIdColumn: employeeIdColumn ? headers[employeeIdColumn - 1] : null,
    employeeNameColumn: employeeNameColumn
      ? headers[employeeNameColumn - 1]
      : null,
    departmentColumn: departmentColumn ? headers[departmentColumn - 1] : null,
    dateColumn: dateColumn ? headers[dateColumn - 1] : null,
    shiftCodeColumn: shiftCodeColumn ? headers[shiftCodeColumn - 1] : null,
    worksheetName: worksheet.name,
  };

  const employeeByCode = new Map(
    employees.map((employee) => [normalize(employee.employeeCode), employee]),
  );
  const employeeByName = new Map(
    employees.map((employee) => [normalize(employee.fullName), employee]),
  );
  const shiftByCode = new Map(
    shiftTypes.flatMap((shift) => [
      [normalize(shift.code), shift] as const,
      [normalize(shift.name), shift] as const,
    ]),
  );

  const records: StagedAssignment[] = [];
  const issues: ImportIssue[] = [];
  const duplicateKeys = new Set<string>();
  let previousEmployeeCode = "";
  let previousEmployeeName = "";
  let previousDepartmentId: string | null = null;

  const addRecord = (
    rowNumber: number,
    rawDate: ExcelJS.CellValue,
    rawShift: ExcelJS.CellValue,
    employeeCodeValue: string,
    employeeNameValue: string,
    departmentValue: string,
  ) => {
    const dateValue = dateFromCell(rawDate, month);
    const employeeCode = employeeCodeValue.trim();
    const employeeName = employeeNameValue.trim();
    const employeeByCodeMatch = employeeCode
      ? employeeByCode.get(normalize(employeeCode))
      : undefined;
    const employeeByNameMatch = employeeName
      ? employeeByName.get(normalize(employeeName))
      : undefined;
    const employee = employeeByCodeMatch ?? employeeByNameMatch;
    const shiftCode = cellText(rawShift).trim();
    const shift = shiftCode ? shiftByCode.get(normalize(shiftCode)) : undefined;
    const departmentMatch = employees.find(
      (candidate) => normalize(candidate.employeeCode) === normalize(employeeCode),
    );
    const departmentId = employee?.departmentId ?? departmentMatch?.departmentId ?? null;
    const dateInMonth = dateValue?.startsWith(`${month}-`) ?? false;
    const duplicateKey = `${dateValue ?? "invalid"}:${employee?.id ?? normalize(employeeCode || employeeName)}`;
    const duplicate = duplicateKeys.has(duplicateKey);
    if (dateValue && employee) duplicateKeys.add(duplicateKey);

    const rowIssues: ImportIssue[] = [];
    if (!dateValue || !dateInMonth) {
      rowIssues.push(
        issue(
          "invalid_date",
          `Use a valid date within ${month}.`,
          rowNumber,
          cellText(rawDate) || null,
        ),
      );
    }
    if (!employeeCode && !employeeName) {
      rowIssues.push(
        issue("missing_value", "No employee identifier or name was found.", rowNumber, null),
      );
    } else if (!employee) {
      rowIssues.push(
        issue(
          "unknown_employee",
          "The employee does not match the staff directory.",
          rowNumber,
          employeeCode || employeeName,
        ),
      );
    }
    if (!shiftCode) {
      rowIssues.push(issue("missing_value", "A shift code is required.", rowNumber, null));
    } else if (!shift) {
      rowIssues.push(
        issue(
          "unknown_shift",
          "The shift code is not configured.",
          rowNumber,
          shiftCode,
        ),
      );
    }
    if (duplicate) {
      rowIssues.push(
        issue(
          "duplicate",
          "This employee already has a shift on this date.",
          rowNumber,
          `${dateValue ?? ""} · ${employeeCode || employeeName}`,
        ),
      );
    }
    issues.push(...rowIssues);
    records.push({
      rowNumber,
      date: dateValue,
      sourceEmployeeId: employeeCode || null,
      sourceEmployeeName: employeeName,
      employeeId: employee?.id ?? null,
      employeeCode: employeeCode || null,
      employeeName: employeeName || "Unmatched employee",
      departmentId,
      shiftTypeId: shift?.id ?? null,
      shiftCode,
      rawShiftValue: cellText(rawShift),
      shiftName: shift?.name ?? null,
      valid: rowIssues.length === 0,
    });
  };

  for (
    let rowNumber = headerRowNumber + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    if (resolvedMapping.format === "long") {
      const rawCode = employeeIdColumn
        ? cellText(row.getCell(employeeIdColumn).value)
        : "";
      const rawName = employeeNameColumn
        ? cellText(row.getCell(employeeNameColumn).value)
        : "";
      const rawDepartment = departmentColumn
        ? cellText(row.getCell(departmentColumn).value)
        : "";
      if (rawCode) previousEmployeeCode = rawCode;
      if (rawName) previousEmployeeName = rawName;
      if (rawDepartment) previousDepartmentId = rawDepartment;
      const rawDate = dateColumn ? row.getCell(dateColumn).value : null;
      const rawShift = shiftCodeColumn ? row.getCell(shiftCodeColumn).value : null;
      if (
        isBlankShift(rawDate, shiftByCode) &&
        isBlankShift(rawShift, shiftByCode)
      ) {
        continue;
      }
      if (shiftCodeColumn && !isBlankShift(rawShift, shiftByCode)) {
        addRecord(
          rowNumber,
          rawDate,
          rawShift,
          rawCode || previousEmployeeCode,
          rawName || previousEmployeeName,
          rawDepartment || previousDepartmentId || "",
        );
      }
      continue;
    }

    const rawCode = employeeIdColumn
      ? cellText(row.getCell(employeeIdColumn).value)
      : "";
    const rawName = employeeNameColumn
      ? cellText(row.getCell(employeeNameColumn).value)
      : "";
    const rawDepartment = departmentColumn
      ? cellText(row.getCell(departmentColumn).value)
      : "";
    if (rawCode) previousEmployeeCode = rawCode;
    if (rawName) previousEmployeeName = rawName;
    if (rawDepartment) previousDepartmentId = rawDepartment;

    let rowHasShift = false;
    for (let column = 1; column <= columnCount; column += 1) {
      if ([employeeIdColumn, employeeNameColumn, departmentColumn].includes(column)) {
        continue;
      }
      const headerValue = headerRow.getCell(column).value;
      const dateValue = dateFromCell(headerValue, month);
      if (!dateValue || isBlankShift(row.getCell(column).value, shiftByCode)) continue;
      rowHasShift = true;
      addRecord(
        rowNumber,
        headerValue,
        row.getCell(column).value,
        rawCode || previousEmployeeCode,
        rawName || previousEmployeeName,
        rawDepartment || previousDepartmentId || "",
      );
    }
    if (!rowHasShift && !rawCode && !rawName) continue;
  }

  if (!records.length) {
    issues.push(
      issue(
        "unsupported_sheet",
        "No shift assignments were found. Check the worksheet and column mapping.",
        headerRowNumber,
        null,
      ),
    );
  }

  const issueRows = new Set(
    issues.map((item) => item.rowNumber).filter((row): row is number => row !== null),
  );
  for (const record of records) {
    record.valid = !issueRows.has(record.rowNumber);
  }

  return {
    format: resolvedMapping.format === "auto" ? "unknown" : resolvedMapping.format,
    columns,
    mapping: resolvedMapping,
    records,
    issues,
  };
}
