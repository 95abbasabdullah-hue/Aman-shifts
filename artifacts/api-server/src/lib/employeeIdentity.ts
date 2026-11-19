export type IdentityEmployee = {
  id: string;
  employeeCode: string;
  fullName: string;
  aliases?: string[];
};

export type EmployeeIdentityMatch =
  | { employee: IdentityEmployee; method: "employee_id" | "approved_alias" | "unique_name" }
  | { employee: null; method: "unmatched" | "ambiguous_name" };

const SHIFT_ANNOTATION = /^(?:D1|D\*?|N\*?|M)(?:\s*[/,+&-]\s*(?:D1|D\*?|N\*?|M))*$/i;

export function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/gu, "");
}

export function stripShiftPatternAnnotation(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\s*[\[(]([^\])]+)[\])]$/);
  if (!match || !SHIFT_ANNOTATION.test(match[1].trim())) return trimmed;
  return trimmed.slice(0, match.index).trim();
}

export function normalizeEmployeeName(value: string): string {
  return normalizeIdentityText(stripShiftPatternAnnotation(value));
}

export function matchEmployeeIdentity(
  sourceEmployeeId: string,
  sourceEmployeeName: string,
  employees: IdentityEmployee[],
): EmployeeIdentityMatch {
  const sourceId = sourceEmployeeId.trim();
  if (sourceId) {
    const exactIdMatches = employees.filter(
      (employee) => employee.employeeCode.trim() === sourceId,
    );
    if (exactIdMatches.length === 1) {
      return { employee: exactIdMatches[0], method: "employee_id" };
    }
  }

  const normalizedName = normalizeEmployeeName(sourceEmployeeName);
  if (!normalizedName) return { employee: null, method: "unmatched" };

  const aliasMatches = employees.filter((employee) =>
    (employee.aliases ?? []).some(
      (alias) => normalizeEmployeeName(alias) === normalizedName,
    ),
  );
  if (aliasMatches.length === 1) {
    return { employee: aliasMatches[0], method: "approved_alias" };
  }
  if (aliasMatches.length > 1) {
    return { employee: null, method: "ambiguous_name" };
  }

  const nameMatches = employees.filter(
    (employee) => normalizeEmployeeName(employee.fullName) === normalizedName,
  );
  if (nameMatches.length === 1) {
    return { employee: nameMatches[0], method: "unique_name" };
  }
  if (nameMatches.length > 1) {
    return { employee: null, method: "ambiguous_name" };
  }
  return { employee: null, method: "unmatched" };
}

export type NewEmployeeRegistration = {
  rowNumber: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  departmentId: string;
};

export type RegistrationValidation =
  | { valid: true; registrations: NewEmployeeRegistration[] }
  | { valid: false; error: string };

export function validateNewEmployeeRegistrations(
  registrations: NewEmployeeRegistration[],
  existingEmployees: Array<{
    employeeCode: string;
    fullName: string;
  }>,
): RegistrationValidation {
  const rowNumbers = new Set<number>();
  const codes = new Set<string>();
  const names = new Set<string>();
  const existingCodes = new Set(existingEmployees.map((item) => item.employeeCode.trim()));
  const existingNames = new Set(
    existingEmployees.map((item) => normalizeEmployeeName(item.fullName)),
  );

  for (const registration of registrations) {
    const employeeCode = registration.employeeCode.trim();
    const fullName = registration.fullName.trim();
    const jobTitle = registration.jobTitle.trim();
    const departmentId = registration.departmentId.trim();
    const normalizedName = normalizeEmployeeName(fullName);
    if (!Number.isInteger(registration.rowNumber) || registration.rowNumber < 1) {
      return { valid: false, error: "Each new employee must refer to a valid source row." };
    }
    if (rowNumbers.has(registration.rowNumber)) {
      return { valid: false, error: "A source employee row can only be registered once." };
    }
    if (!employeeCode || !fullName || !jobTitle || !departmentId || !normalizedName) {
      return {
        valid: false,
        error: "New employees need a source ID, name, role, and department.",
      };
    }
    if (existingCodes.has(employeeCode) || codes.has(employeeCode)) {
      return {
        valid: false,
        error: "An employee with this ID already exists; map the roster row instead.",
      };
    }
    if (existingNames.has(normalizedName) || names.has(normalizedName)) {
      return {
        valid: false,
        error: "A matching employee name already exists; map the roster row instead.",
      };
    }
    rowNumbers.add(registration.rowNumber);
    codes.add(employeeCode);
    names.add(normalizedName);
  }

  return { valid: true, registrations };
}
