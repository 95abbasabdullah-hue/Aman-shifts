export type ShiftCategory = "working" | "attendance";

export type DefaultShiftDefinition = {
  code: string;
  category: ShiftCategory;
  name: string;
  meaning: string | null;
  color: string;
  displayCode: string;
  displayInCalendar: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

export const DEFAULT_SHIFT_DEFINITIONS: DefaultShiftDefinition[] = [
  {
    code: "D",
    category: "working",
    name: "Day Shift",
    meaning: "07:00–19:00",
    color: "#1976D2",
    displayCode: "D",
    displayInCalendar: true,
    startsAt: "07:00",
    endsAt: "19:00",
  },
  {
    code: "N",
    category: "working",
    name: "Night Shift",
    meaning: "19:00–07:00 next day",
    color: "#FBC02D",
    displayCode: "N",
    displayInCalendar: true,
    startsAt: "19:00",
    endsAt: "07:00",
  },
  {
    code: "M",
    category: "working",
    name: "Midshift",
    meaning: null,
    color: "#43A047",
    displayCode: "M",
    displayInCalendar: true,
    startsAt: null,
    endsAt: null,
  },
  {
    code: "D1",
    category: "working",
    name: "Independent duty",
    meaning: "Independent duty assigned as needed",
    color: "#EF8F25",
    displayCode: "D1",
    displayInCalendar: true,
    startsAt: null,
    endsAt: null,
  },
  ...["AL", "CL", "EL", "R", "OFF", "/"].map((code) => ({
    code,
    category: "attendance" as const,
    name:
      code === "EL"
        ? "Educational Leave"
        : code === "AL"
          ? "Annual Leave"
          : code === "CL"
            ? "Casual Leave"
            : code === "R"
              ? "Requested Off"
              : code === "OFF"
                ? "Off Day"
                  : code === "/"
                    ? "Unresolved attendance status"
                    : "Off Day",
    meaning:
      code === "/"
        ? "Unresolved attendance code; meaning is not configured."
        : null,
    color:
      code === "EL"
        ? "#D1C4E9"
        : code === "AL"
          ? "#C5E1A5"
          : code === "CL"
            ? "#FFF59D"
            : code === "R"
              ? "#616161"
              : code === "OFF"
                ? "#E0E0E0"
                : "#E0E0E0",
    displayCode: code,
    displayInCalendar: true,
    startsAt: null,
    endsAt: null,
  })),
];

const KNOWN_CODES = new Set(DEFAULT_SHIFT_DEFINITIONS.map((definition) => definition.code));

export function normalizeShiftValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "OFF";
  const upper = trimmed.toUpperCase();
  if (upper === "BLANK") return "OFF";
  if (upper === "D" || upper === "D*") return "D";
  if (upper === "N" || upper === "N*") return "N";
  if (KNOWN_CODES.has(upper)) return upper;
  return trimmed;
}

export function isBlankOffDutyAlias(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  return !normalized || normalized === "BLANK";
}
