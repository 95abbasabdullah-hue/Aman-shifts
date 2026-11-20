import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import {
  parseRosterWorkbook,
  type DepartmentReference,
  type EmployeeReference,
  type ShiftReference,
} from "./rosterImportParser";
import { DEFAULT_SHIFT_DEFINITIONS, normalizeShiftValue } from "./shiftDefinitions";
import {
  matchEmployeeIdentity,
  normalizeEmployeeName,
  stripShiftPatternAnnotation,
  validateNewEmployeeRegistrations,
} from "./employeeIdentity";
import {
  prepareAutomaticRoster,
  type AutoImportReferenceData,
} from "./automaticRosterImport";

const departments: DepartmentReference[] = [
  { id: "dept-ed", code: "ED", name: "Emergency Department" },
  { id: "dept-icu", code: "ICU", name: "Intensive Care Unit" },
  { id: "dept-hca", code: "HCA", name: "Health Care Assistant" },
];

const shiftTypes: ShiftReference[] = DEFAULT_SHIFT_DEFINITIONS.map((shift) => ({
  id: `shift-${shift.code}`,
  code: shift.code,
  name: shift.name,
  category: shift.category,
  displayCode: shift.displayCode,
}));

type Fixture = {
  buffer: Buffer;
  employees: EmployeeReference[];
  cellValues: Map<string, string>;
  dateStrings: string[];
  staffRows: number[];
};

function dateString(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function buildFixture(options: { competing?: boolean; unknownCode?: boolean } = {}): Promise<Fixture> {
  const workbook = new ExcelJS.Workbook();
  const dateStrings = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 20 + index));
    return dateString(date);
  });
  const employeeRows = [
    ...Array.from({ length: 13 }, (_, index) => ({ row: 7 + index, department: "ED" })),
    ...Array.from({ length: 6 }, (_, index) => ({ row: 24 + index, department: "ICU" })),
    { row: 34, department: "HCA" },
  ];
  const employees: EmployeeReference[] = [];
  const staffRows = employeeRows.map(({ row }) => row);
  const cellValues = new Map<string, string>();

  const addHistoricalSheet = (name: string, firstDate: Date) => {
    const sheet = workbook.addWorksheet(name);
    sheet.getCell("B4").value = "Employee Name";
    sheet.getCell("C4").value = "Employee ID";
    sheet.getCell("D4").value = "Role";
    for (let index = 0; index < 3; index += 1) {
      sheet.getCell(5, 5 + index).value = new Date(
        firstDate.getTime() + index * 86400000,
      );
    }
    sheet.getCell("B7").value = "Historical employee";
    sheet.getCell("C7").value = "HIST01";
    sheet.getCell("D7").value = "RN";
    sheet.getCell("E7").value = "D";
  };
  addHistoricalSheet("EDrev (3)", new Date(Date.UTC(2026, 8, 1)));
  addHistoricalSheet("ED", new Date(Date.UTC(2026, 9, 1)));

  const populateLatest = (sheet: ExcelJS.Worksheet) => {
    sheet.getCell("B4").value = "Employee Name";
    sheet.getCell("C4").value = "Employee ID";
    sheet.getCell("D4").value = "Role";
    for (let index = 0; index < dateStrings.length; index += 1) {
      const date = new Date(Date.UTC(2026, 10, 20 + index));
      sheet.getCell(5, 5 + index).value = date;
      sheet.getCell(5, 5 + index).numFmt = "dd/mm/yyyy";
    }

    let staffIndex = 0;
    let cellIndex = 0;
    for (const { row, department } of employeeRows) {
      if ([7, 24, 34].includes(row)) sheet.getCell(row - 1, 1).value = department;
      const name = `Nurse Employee ${String(staffIndex + 1).padStart(2, "0")}`;
      const employeeCode = staffIndex === 16 ? "" : `ID${String(staffIndex + 1).padStart(3, "0")}`;
      sheet.getCell(row, 2).value = name;
      sheet.getCell(row, 3).value = employeeCode;
      sheet.getCell(row, 4).value = department === "HCA" ? "HCA" : "Registered Nurse";
      if (employeeCode) {
        employees.push({
          id: `emp-${staffIndex + 1}`,
          employeeCode,
          fullName: name,
          departmentId: department === "ED" ? "dept-ed" : department === "ICU" ? "dept-icu" : "dept-hca",
        });
      } else {
        employees.push({
          id: `emp-${staffIndex + 1}`,
          employeeCode: "DIRECTORY-ONLY-17",
          fullName: name,
          departmentId: "dept-icu",
        });
      }

      for (let dayIndex = 0; dayIndex < dateStrings.length; dayIndex += 1) {
        const column = 5 + dayIndex;
        let rawValue = "";
        if (cellIndex >= 104) {
          const codes = ["D", "D*", "N", "N*", "M", "AL", "CL", "EL", "R", "OFF", "/"];
          rawValue = codes[(cellIndex - 104) % codes.length];
        }
        if (options.unknownCode && cellIndex === 200) rawValue = "UNMAPPED";
        if (rawValue) sheet.getCell(row, column).value = rawValue;
        cellValues.set(`${row}:${dateStrings[dayIndex]}`, rawValue);
        cellIndex += 1;
      }
      staffIndex += 1;
    }
  };

  const latest = workbook.addWorksheet("ED-ICU");
  populateLatest(latest);
  if (options.competing) {
    const competitor = workbook.addWorksheet("Updated roster");
    populateLatest(competitor);
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    employees,
    cellValues,
    dateStrings,
    staffRows,
  };
}

const emptyMapping = {
  format: "auto" as const,
  employeeIdColumn: null,
  employeeNameColumn: null,
  employeeRoleColumn: null,
  departmentColumn: null,
  dateColumn: null,
  shiftCodeColumn: null,
  worksheetName: null,
};
const actualWorkbookPath = process.env.AMAN_ROSTER_WORKBOOK;

function rawExcelText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return dateString(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    if ("result" in value) return rawExcelText(value.result as ExcelJS.CellValue);
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return "";
}

test("official shift normalization trims aliases and keeps D1 separate", () => {
  assert.equal(normalizeShiftValue(" D "), "D");
  assert.equal(normalizeShiftValue(" D* "), "D");
  assert.equal(normalizeShiftValue(" N "), "N");
  assert.equal(normalizeShiftValue(" N* "), "N");
  assert.equal(normalizeShiftValue(" M "), "M");
  assert.equal(normalizeShiftValue(" D1 "), "D1");
  assert.notEqual(normalizeShiftValue("D1"), normalizeShiftValue("D"));
  assert.equal(normalizeShiftValue(""), "BLANK");
  assert.equal(normalizeShiftValue(" / "), "/");
  assert.equal(normalizeShiftValue(" OFF "), "OFF");
  assert.deepEqual(
    DEFAULT_SHIFT_DEFINITIONS.filter((shift) => shift.category === "working").map(
      ({ code, displayCode, color, startsAt, endsAt }) => ({
        code,
        displayCode,
        color,
        startsAt,
        endsAt,
      }),
    ),
    [
      { code: "D", displayCode: "D", color: "#1976D2", startsAt: "07:00", endsAt: "19:00" },
      { code: "N", displayCode: "N", color: "#7555C7", startsAt: "19:00", endsAt: "07:00" },
      { code: "M", displayCode: "M", color: "#43A047", startsAt: null, endsAt: null },
      { code: "D1", displayCode: "D1", color: "#EF8F25", startsAt: null, endsAt: null },
    ],
  );
});

test("employee resolution prefers exact IDs, then approved aliases, then unique names", () => {
  const employees: EmployeeReference[] = [
    {
      id: "emp-1",
      employeeCode: "ID001",
      fullName: "Nurse Alpha",
      departmentId: "dept-ed",
      aliases: ["Imported Alpha"],
    },
    {
      id: "emp-2",
      employeeCode: "ID002",
      fullName: "Nurse Beta",
      departmentId: "dept-icu",
    },
  ];
  assert.equal(
    matchEmployeeIdentity(" ID002 ", "Nurse Alpha", employees).employee?.id,
    "emp-2",
  );
  assert.equal(
    matchEmployeeIdentity("OLD-ID", "Imported Alpha", employees).method,
    "approved_alias",
  );
  assert.equal(
    matchEmployeeIdentity("", "Nurse Beta", employees).method,
    "unique_name",
  );
  assert.equal(
    matchEmployeeIdentity("OLD-ID", "Nurse Beta", employees).employee?.id,
    "emp-2",
  );
  assert.equal(
    matchEmployeeIdentity("", "Nurse Alpha (D*/N)", employees).employee?.id,
    "emp-1",
  );
  assert.notEqual(
    normalizeEmployeeName("Nurse Alpha (Extra Name)"),
    normalizeEmployeeName("Nurse Alpha"),
  );
  assert.equal(stripShiftPatternAnnotation("Nurse Alpha (D*/N)"), "Nurse Alpha");
});

test("ambiguous names stay unresolved and employee registration rejects duplicates", () => {
  const duplicateNames: EmployeeReference[] = [
    { id: "emp-1", employeeCode: "ID001", fullName: "Nurse Alpha", departmentId: "dept-ed" },
    { id: "emp-2", employeeCode: "ID002", fullName: "Nurse Alpha", departmentId: "dept-icu" },
  ];
  const ambiguous = matchEmployeeIdentity("", "Nurse Alpha", duplicateNames);
  assert.equal(ambiguous.employee, null);
  assert.equal(ambiguous.method, "ambiguous_name");

  const valid = validateNewEmployeeRegistrations(
    [{ rowNumber: 4, employeeCode: "ID003", fullName: "Nurse Gamma", jobTitle: "RN", departmentId: "dept-ed" }],
    duplicateNames,
  );
  assert.equal(valid.valid, true);
  assert.equal(
    validateNewEmployeeRegistrations(
      [{ rowNumber: 4, employeeCode: "ID001", fullName: "Nurse Gamma", jobTitle: "RN", departmentId: "dept-ed" }],
      duplicateNames,
    ).valid,
    false,
  );
  assert.equal(
    validateNewEmployeeRegistrations(
      [{ rowNumber: 4, employeeCode: "ID003", fullName: "Nurse Alpha", jobTitle: "RN", departmentId: "dept-ed" }],
      duplicateNames,
    ).valid,
    false,
  );
  assert.equal(
    validateNewEmployeeRegistrations(
      [{ rowNumber: 4, employeeCode: "", fullName: "Nurse Gamma", jobTitle: "RN", departmentId: "dept-ed" }],
      [],
    ).valid,
    false,
  );
});

test("raw Excel text is retained while surrounding spaces are normalized", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Current roster");
  sheet.getCell("B4").value = "Employee Name";
  sheet.getCell("C4").value = "Employee ID";
  sheet.getCell("D4").value = "Role";
  for (let index = 0; index < 3; index += 1) {
    sheet.getCell(5, 5 + index).value = new Date(Date.UTC(2026, 10, 20 + index));
  }
  sheet.getCell("B6").value = "Nurse Sample";
  sheet.getCell("C6").value = " ID001 ";
  sheet.getCell("D6").value = "RN - ED";
  sheet.getCell("E6").value = " D* ";
  sheet.getCell("F6").value = "N*";
  sheet.getCell("G6").value = "M";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseRosterWorkbook(
    buffer,
    "2026-11",
    emptyMapping,
    [{
      id: "emp-1",
      employeeCode: "ID001",
      fullName: "Nurse Sample",
      departmentId: "dept-ed",
    }],
    shiftTypes,
    departments,
  );
  assert.deepEqual(parsed.records.map((record) => record.rawShiftValue), [" D* ", "N*", "M"]);
  assert.deepEqual(parsed.records.map((record) => record.shiftCode), ["D", "N", "M"]);
  assert.equal(parsed.records[0].sourceEmployeeId, " ID001 ");
  assert.equal(parsed.records[0].sourceRole, "RN - ED");
  assert.equal(parsed.records[0].sourceDepartment, "ED");
  assert.equal(parsed.mapping.employeeNameColumn, "B");
  assert.equal(parsed.mapping.employeeIdColumn, "C");
  assert.equal(parsed.mapping.employeeRoleColumn, "D");
  assert.equal(parsed.mapping.dateColumn, null);
  assert.equal(parsed.mapping.shiftCodeColumn, null);
  assert.ok(parsed.columns.includes("B"));
  assert.ok(!parsed.columns.includes("GREGORIAN DATE"));
});

test("latest date range wins and preserves a cross-month 20 by 30 grid", async () => {
  const fixture = await buildFixture();
  const parsed = await parseRosterWorkbook(
    fixture.buffer,
    "2026-11",
    emptyMapping,
    fixture.employees,
    shiftTypes,
    departments,
  );

  assert.equal(parsed.selectedWorksheet, "ED-ICU");
  assert.deepEqual(parsed.worksheetChoices, ["ED-ICU"]);
  assert.equal(parsed.periodStart, "2026-11-20");
  assert.equal(parsed.periodEnd, "2026-12-19");
  assert.equal(parsed.records.length, 600);
  assert.equal(new Set(parsed.records.map((record) => record.rowNumber)).size, 20);
  assert.equal(new Set(parsed.records.map((record) => record.date)).size, 30);
  assert.equal(parsed.records.filter((record) => record.rawShiftValue === "").length, 104);
  assert.equal(parsed.records.filter((record) => record.rawShiftValue !== "").length, 496);

  const missingIdRows = new Set(
    parsed.issues
      .filter((issue) => issue.code === "missing_employee_id")
      .map((issue) => issue.rowNumber),
  );
  assert.equal(missingIdRows.size, 1);

  for (const record of parsed.records) {
    assert.ok(record.date);
    const key = `${record.rowNumber}:${record.date}`;
    const sourceRaw = fixture.cellValues.get(key);
    assert.equal(record.rawShiftValue, sourceRaw);
    const normalized = normalizeShiftValue(sourceRaw ?? "");
    assert.equal(
      record.shiftCode,
      normalized === "BLANK"
        ? ""
        : shiftTypes.find((shift) => shift.code === normalized)?.displayCode,
    );
    assert.equal(
      record.shiftTypeId,
      shiftTypes.find((shift) => shift.code === normalized)?.id,
    );
  }

  const rawNonempty = new Set(
    parsed.records.map((record) => record.rawShiftValue).filter(Boolean),
  );
  assert.deepEqual(
    [...rawNonempty].sort(),
    ["/", "AL", "CL", "D", "D*", "EL", "M", "N", "N*", "OFF", "R"].sort(),
  );
  const normalizedDStar = parsed.records.find((record) => record.rawShiftValue === "D*");
  const normalizedNStar = parsed.records.find((record) => record.rawShiftValue === "N*");
  assert.equal(normalizedDStar?.shiftCode, "D");
  assert.equal(normalizedNStar?.shiftCode, "N");
  assert.equal(normalizedDStar?.rawShiftValue, "D*");
  assert.equal(normalizedNStar?.rawShiftValue, "N*");
  assert.ok(
    parsed.records.every((record) => !record.shiftCode.includes("*")),
  );
});

test("competing latest-period sheets require a selected worksheet", async () => {
  const fixture = await buildFixture({ competing: true });
  const unresolved = await parseRosterWorkbook(
    fixture.buffer,
    "2026-11",
    emptyMapping,
    fixture.employees,
    shiftTypes,
    departments,
  );
  assert.equal(unresolved.records.length, 0);
  assert.ok(unresolved.issues.some((issue) => issue.code === "competing_schedules"));
  assert.deepEqual(unresolved.worksheetChoices.sort(), ["ED-ICU", "Updated roster"]);

  const selected = await parseRosterWorkbook(
    fixture.buffer,
    "2026-11",
    { ...emptyMapping, worksheetName: "ED-ICU" },
    fixture.employees,
    shiftTypes,
    departments,
  );
  assert.equal(selected.selectedWorksheet, "ED-ICU");
  assert.equal(selected.records.length, 600);
});

test("unknown codes warn without aborting, and attendance remains non-working", async () => {
  const fixture = await buildFixture({ unknownCode: true });
  const parsed = await parseRosterWorkbook(
    fixture.buffer,
    "2026-11",
    emptyMapping,
    fixture.employees,
    shiftTypes,
    departments,
  );
  assert.equal(parsed.records.length, 600);
  assert.ok(parsed.issues.some((issue) => issue.code === "unknown_shift" && issue.value === "UNMAPPED"));
  for (const code of ["AL", "CL", "EL", "R", "OFF", "/", "BLANK"]) {
    assert.equal(
      shiftTypes.find((shift) => shift.code === code)?.category,
      "attendance",
      `${code} remains a non-working attendance status`,
    );
  }
  assert.equal(normalizeShiftValue("/"), "/");
  assert.equal(normalizeShiftValue(""), "BLANK");
  assert.notEqual(normalizeShiftValue("/"), normalizeShiftValue("OFF"));
  assert.equal(
    shiftTypes.find((shift) => shift.code === "D1")?.category,
    "working",
  );
});

test("long-format sheets also select the newest actual date period", async () => {
  const workbook = new ExcelJS.Workbook();
  const addLongSheet = (
    name: string,
    dates: Date[],
    shiftValues: string[],
  ) => {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(["Employee ID", "Employee Name", "Department", "Date", "Shift Code"]);
    dates.forEach((date, index) => {
      sheet.addRow([
        "ID001",
        "Nurse Employee 01",
        "ED",
        date,
        shiftValues[index],
      ]);
    });
  };
  addLongSheet(
    "Old roster",
    [new Date(Date.UTC(2026, 8, 1))],
    ["N"],
  );
  addLongSheet(
    "Current roster",
    [
      new Date(Date.UTC(2026, 10, 20)),
      new Date(Date.UTC(2026, 11, 1)),
      new Date(Date.UTC(2026, 11, 2)),
    ],
    ["D*", "AL", ""],
  );
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const employees = [
    {
      id: "emp-1",
      employeeCode: "ID001",
      fullName: "Nurse Employee 01",
      departmentId: "dept-ed",
    },
  ];
  const parsed = await parseRosterWorkbook(
    buffer,
    "2026-11",
    emptyMapping,
    employees,
    shiftTypes,
    departments,
  );
  assert.equal(parsed.format, "long");
  assert.equal(parsed.selectedWorksheet, "Current roster");
  assert.equal(parsed.periodStart, "2026-11-20");
  assert.equal(parsed.periodEnd, "2026-12-02");
  assert.deepEqual(parsed.records.map((record) => record.shiftCode), ["D", "AL", ""]);
  assert.deepEqual(parsed.records.map((record) => record.rawShiftValue), ["D*", "AL", ""]);
});

test(
  "automatic roster planning keeps every cell, creates missing departments, and preserves unknown values",
  async () => {
    const fixture = await buildFixture({ unknownCode: true });
    const employeeReferences = fixture.employees
      .filter((employee) => employee.employeeCode !== "DIRECTORY-ONLY-17")
      .map((employee) => ({
        ...employee,
        jobTitle: "Registered Nurse",
        active: true,
        aliases: [],
      }));
    const references: AutoImportReferenceData = {
      employees: employeeReferences,
      departments: departments
        .filter((department) => department.code !== "HCA")
        .map((department) => ({ ...department, active: true })),
      shiftTypes: DEFAULT_SHIFT_DEFINITIONS.map((shift) => ({
        ...shift,
        active: true,
      })),
    };
    const parsed = await parseRosterWorkbook(
      fixture.buffer,
      "2026-11",
      emptyMapping,
      employeeReferences,
      references.shiftTypes,
      references.departments,
    );
    const plan = prepareAutomaticRoster(parsed, references);
    assert.equal(plan.employees.length, 20);
    assert.equal(plan.dates.length, 30);
    assert.equal(plan.assignments.length, 600);
    assert.deepEqual(plan.assignments.find((item) => item.record.rawShiftValue === "D*")?.normalizedShiftCode, "D");
    assert.deepEqual(plan.assignments.find((item) => item.record.rawShiftValue === "N*")?.normalizedShiftCode, "N");
    assert.equal(plan.unknownShiftCounts.get("UNMAPPED"), 1);
    assert.ok(plan.departments.some((department) => department.code === "HCA" && !department.existingId));
    const noIdEmployee = plan.employees.find((employee) => !employee.sourceEmployeeId);
    assert.ok(noIdEmployee?.employeeCode.startsWith("AUTO-"));
    assert.equal(noIdEmployee?.existingId, null);
    assert.ok(
      plan.assignments.some(
        (assignment) =>
          assignment.record.rawShiftValue === "UNMAPPED" &&
          assignment.normalizedShiftCode === "UNMAPPED",
      ),
    );
  },
);

test(
  "uploaded ED-ICU workbook preserves all 600 source cells",
  { skip: !actualWorkbookPath },
  async () => {
    const sourceWorkbook = new ExcelJS.Workbook();
    const sourceBuffer = await readFile(actualWorkbookPath!);
    await sourceWorkbook.xlsx.load(
      sourceBuffer as unknown as Parameters<typeof sourceWorkbook.xlsx.load>[0],
    );
    const sourceSheet = sourceWorkbook.getWorksheet("ED-ICU");
    assert.ok(sourceSheet, "ED-ICU worksheet must exist");

    const sourceRows = [
      ...Array.from({ length: 13 }, (_, index) => 7 + index),
      ...Array.from({ length: 6 }, (_, index) => 24 + index),
      34,
    ];
    const departmentForRow = (row: number) =>
      row <= 19 ? "ED" : row <= 29 ? "ICU" : "HCA";
    const sourceDates = Array.from({ length: 30 }, (_, index) => {
      const value = sourceSheet.getRow(5).getCell(5 + index).value;
      assert.ok(value instanceof Date, `date header ${index + 1} must be an Excel date`);
      return dateString(value);
    });
    const sourceEmployees: EmployeeReference[] = sourceRows.map((row, index) => {
      const sourceId = rawExcelText(sourceSheet.getRow(row).getCell(3).value).trim();
      const sourceName = rawExcelText(sourceSheet.getRow(row).getCell(2).value);
      const departmentCode = departmentForRow(row);
      return {
        id: `reference-employee-${index + 1}`,
        employeeCode: sourceId || `missing-source-id-${row}`,
        fullName: sourceName.trim(),
        departmentId: `dept-${departmentCode.toLowerCase()}`,
      };
    });

    const parsed = await parseRosterWorkbook(
      await readFile(actualWorkbookPath!),
      "2026-11",
      emptyMapping,
      sourceEmployees,
      shiftTypes,
      departments,
    );
    assert.equal(parsed.selectedWorksheet, "ED-ICU");
    assert.equal(parsed.format, "wide");
    assert.equal(parsed.periodStart, "2026-11-20");
    assert.equal(parsed.periodEnd, "2026-12-19");
    assert.equal(sourceRows.length, 20);
    assert.equal(sourceDates.length, 30);
    assert.equal(
      parsed.records.length,
      600,
      `parsed source rows: ${[...new Set(parsed.records.map((record) => record.rowNumber))].join(",")}; mapping: ${JSON.stringify(parsed.mapping)}`,
    );
    assert.equal(new Set(parsed.records.map((record) => record.rowNumber)).size, 20);
    assert.equal(new Set(parsed.records.map((record) => record.date)).size, 30);
    assert.equal(parsed.mapping.employeeNameColumn, "B");
    assert.equal(parsed.mapping.employeeIdColumn, "C");
    assert.equal(parsed.mapping.employeeRoleColumn, "D");
    assert.ok(!parsed.records.some((record) => record.rowNumber === 20 || record.rowNumber === 30));
    assert.deepEqual(
      Object.fromEntries(
        ["ED", "ICU", "HCA"].map((code) => [
          code,
          new Set(
            parsed.records
              .filter((record) => record.sourceDepartment === code)
              .map((record) => record.rowNumber),
          ).size,
        ]),
      ),
      { ED: 13, ICU: 6, HCA: 1 },
    );
    const parsedWithoutHcaConfigured = await parseRosterWorkbook(
      sourceBuffer,
      "2026-11",
      emptyMapping,
      sourceEmployees,
      shiftTypes,
      departments.filter((department) => department.code !== "HCA"),
    );
    assert.equal(parsedWithoutHcaConfigured.records.length, 600);
    assert.equal(
      new Set(
        parsedWithoutHcaConfigured.records
          .filter((record) => record.sourceDepartment === "HCA")
          .map((record) => record.rowNumber),
      ).size,
      1,
    );
    assert.ok(!parsedWithoutHcaConfigured.records.some((record) => record.rowNumber === 33));

    const expectedRawCounts = new Map<string, number>();
    const normalizedCounts = new Map<string, number>();
    for (const row of sourceRows) {
      const sourceName = rawExcelText(sourceSheet.getRow(row).getCell(2).value);
      const sourceId = rawExcelText(sourceSheet.getRow(row).getCell(3).value).trim();
      const expectedDepartmentId = `dept-${departmentForRow(row).toLowerCase()}`;
      for (let index = 0; index < sourceDates.length; index += 1) {
        const rawShiftValue = rawExcelText(
          sourceSheet.getRow(row).getCell(5 + index).value,
        );
        const normalized = normalizeShiftValue(rawShiftValue);
        const record = parsed.records.find(
          (item) => item.rowNumber === row && item.date === sourceDates[index],
        );
        assert.ok(record, `source cell at row ${row} date ${sourceDates[index]} is preserved`);
        assert.equal(record.rawShiftValue, rawShiftValue);
        assert.equal(record.sourceEmployeeName, sourceName);
        assert.equal(record.sourceEmployeeId, sourceId || null);
        assert.equal(
          record.sourceRole,
          rawExcelText(sourceSheet.getRow(row).getCell(4).value),
        );
        assert.equal(record.departmentId, expectedDepartmentId);
        const expectedShift = shiftTypes.find((shift) => shift.code === normalized);
        assert.equal(record.shiftTypeId, expectedShift?.id);
        assert.equal(
          record.shiftCode,
          normalized === "BLANK" ? "" : expectedShift?.displayCode ?? normalized,
        );
        expectedRawCounts.set(rawShiftValue, (expectedRawCounts.get(rawShiftValue) ?? 0) + 1);
        normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
      }
    }

    const missingIdRows = new Set(
      parsed.issues
        .filter((issue) => issue.code === "missing_employee_id")
        .map((issue) => issue.rowNumber),
    );
    assert.equal(missingIdRows.size, 1);
    assert.ok(
      parsed.records.filter((record) => record.rawShiftValue === "D*")
        .every((record) => record.shiftCode === "D"),
    );
    assert.ok(
      parsed.records.filter((record) => record.rawShiftValue === "N*")
        .every((record) => record.shiftCode === "N"),
    );
    assert.equal(
      shiftTypes.find((shift) => shift.code === "D1")?.category,
      "working",
    );
    assert.deepEqual(
      [...parsed.issues]
        .filter((issue) => issue.code === "unknown_shift")
        .map((issue) => issue.value),
      [],
    );

    console.log(
      "REFERENCE_WORKBOOK_RESULT",
      JSON.stringify({
        sheet: parsed.selectedWorksheet,
        staff: new Set(parsed.records.map((record) => record.rowNumber)).size,
        dates: new Set(parsed.records.map((record) => record.date)).size,
        cells: parsed.records.length,
        nonempty: parsed.records.filter((record) => record.rawShiftValue.trim()).length,
        blank: parsed.records.filter((record) => !record.rawShiftValue.trim()).length,
        rawShiftCodes: Object.fromEntries(
          [...expectedRawCounts.entries()]
            .filter(([code]) => code.trim())
            .sort((a, b) => a[0].localeCompare(b[0])),
        ),
        normalizedCodeDistribution: Object.fromEntries(
          [...normalizedCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        unknownCodes: [...parsed.issues]
          .filter((issue) => issue.code === "unknown_shift")
          .map((issue) => issue.value),
        missingEmployeeIds: missingIdRows.size,
        dStarConverted: parsed.records
          .filter((record) => record.rawShiftValue === "D*")
          .every((record) => record.shiftCode === "D"),
        nStarConverted: parsed.records
          .filter((record) => record.rawShiftValue === "N*")
          .every((record) => record.shiftCode === "N"),
        d1ConfiguredSeparately: normalizeShiftValue("D1") === "D1",
        latestSheetSelected: parsed.selectedWorksheet === "ED-ICU",
        allCellsMatchSource: true,
      }),
    );
  },
);
