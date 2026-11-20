import { eq } from "drizzle-orm";
import {
  db,
  shiftAssignmentsTable,
  shiftTypesTable,
} from "@workspace/db";
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
    if (definition.code === "/") {
      const [existingSlashType] = await db
        .select({
          id: shiftTypesTable.id,
          name: shiftTypesTable.name,
          meaning: shiftTypesTable.meaning,
        })
        .from(shiftTypesTable)
        .where(eq(shiftTypesTable.code, "/"))
        .limit(1);
      if (!existingSlashType) {
        await db.insert(shiftTypesTable).values(definition);
      } else {
        const wasLegacyOffDayDefault =
          existingSlashType.name === "Off Day" &&
          existingSlashType.meaning ===
            "Legacy '/' source value; treated as off duty.";
        await db
          .update(shiftTypesTable)
          .set({
            category: "attendance",
            ...(wasLegacyOffDayDefault
              ? {
                  name: definition.name,
                  meaning: definition.meaning,
                  color: definition.color,
                  displayCode: "/",
                  displayInCalendar: true,
                }
              : {}),
            startsAt: null,
            endsAt: null,
            active: true,
            updatedAt: new Date(),
          })
          .where(eq(shiftTypesTable.id, existingSlashType.id));
      }
      continue;
    }
    await db
      .insert(shiftTypesTable)
      .values(definition)
      .onConflictDoUpdate({
        target: shiftTypesTable.code,
        set: {
          category: "attendance",
          name: definition.name,
          meaning: definition.meaning,
          color: definition.color,
          displayCode: definition.displayCode,
          displayInCalendar: definition.displayInCalendar,
          startsAt: null,
          endsAt: null,
          active: true,
          updatedAt: new Date(),
        },
      });
  }

  // Older imports used BLANK to store an empty Excel cell. Keep those raw
  // assignments intact, but make their visible status match OFF.
  const offDay = attendanceDefinitions.find((definition) => definition.code === "OFF");
  if (offDay) {
    const [offDayType] = await db
      .select({ id: shiftTypesTable.id })
      .from(shiftTypesTable)
      .where(eq(shiftTypesTable.code, "OFF"))
      .limit(1);
    const [legacyBlankType] = await db
      .select({ id: shiftTypesTable.id })
      .from(shiftTypesTable)
      .where(eq(shiftTypesTable.code, "BLANK"))
      .limit(1);
    if (offDayType && legacyBlankType) {
      await db
        .update(shiftAssignmentsTable)
        .set({ shiftTypeId: offDayType.id, updatedAt: new Date() })
        .where(eq(shiftAssignmentsTable.shiftTypeId, legacyBlankType.id));
    }
    await db
      .update(shiftTypesTable)
      .set({
        category: "attendance",
        name: offDay.name,
        meaning: "Empty source cell; displayed as OFF. The raw value remains blank.",
        color: offDay.color,
        displayCode: "OFF",
        displayInCalendar: true,
        active: false,
        updatedAt: new Date(),
      })
      .where(eq(shiftTypesTable.code, "BLANK"));
  }
}
