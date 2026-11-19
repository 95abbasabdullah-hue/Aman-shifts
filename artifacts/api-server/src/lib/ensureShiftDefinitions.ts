import { db, shiftTypesTable } from "@workspace/db";
import { DEFAULT_SHIFT_DEFINITIONS } from "./shiftDefinitions";

export async function ensureShiftDefinitions(): Promise<void> {
  const workingDefinitions = DEFAULT_SHIFT_DEFINITIONS.filter(
    (definition) => definition.category === "working",
  );
  const attendanceDefinitions = DEFAULT_SHIFT_DEFINITIONS.filter(
    (definition) => definition.category === "attendance",
  );
  for (const definition of workingDefinitions) {
    await db
      .insert(shiftTypesTable)
      .values(definition)
      .onConflictDoUpdate({
        target: shiftTypesTable.code,
        set: { ...definition, active: true, updatedAt: new Date() },
      });
  }
  for (const definition of attendanceDefinitions) {
    await db
      .insert(shiftTypesTable)
      .values(definition)
      .onConflictDoUpdate({
        target: shiftTypesTable.code,
        set: { category: "attendance", active: true, updatedAt: new Date() },
      });
  }
}
