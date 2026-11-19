import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const departmentsTable = pgTable(
  "aman_departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Asia/Qatar"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("aman_departments_active_idx").on(table.active)],
);

export const employeesTable = pgTable(
  "aman_employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeCode: text("employee_code").notNull().unique(),
    fullName: text("full_name").notNull(),
    jobTitle: text("job_title").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departmentsTable.id),
    email: text("email"),
    photoPath: text("photo_path"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("aman_employees_department_idx").on(table.departmentId),
    index("aman_employees_active_idx").on(table.active),
    uniqueIndex("aman_employees_email_unique_idx").on(table.email),
  ],
);

export const appUsersTable = pgTable(
  "aman_app_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    role: text("role").notNull().default("staff"),
    departmentId: uuid("department_id").references(() => departmentsTable.id),
    employeeId: uuid("employee_id").references(() => employeesTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("aman_app_users_employee_unique_idx").on(table.employeeId),
    index("aman_app_users_role_idx").on(table.role),
  ],
);

export const employeeAliasesTable = pgTable(
  "aman_employee_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employeesTable.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => appUsersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("aman_employee_aliases_normalized_unique_idx").on(
      table.normalizedAlias,
    ),
    index("aman_employee_aliases_employee_idx").on(table.employeeId),
  ],
);

export const shiftTypesTable = pgTable(
  "aman_shift_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    category: text("category").notNull().default("working"),
    name: text("name").notNull(),
    meaning: text("meaning"),
    color: text("color").notNull(),
    displayCode: text("display_code"),
    displayInCalendar: boolean("display_in_calendar").notNull().default(true),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("aman_shift_types_active_idx").on(table.active)],
);

export const importJobsTable = pgTable(
  "aman_import_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    month: text("month").notNull(),
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }),
    status: text("status").notNull().default("needs_review"),
    detectedFormat: text("detected_format").notNull().default("unknown"),
    selectedWorksheet: text("selected_worksheet"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => appUsersTable.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rowCount: integer("row_count").notNull().default(0),
    validCount: integer("valid_count").notNull().default(0),
    issueCount: integer("issue_count").notNull().default(0),
    mapping: jsonb("mapping")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    preview: jsonb("preview")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdVersionId: uuid("created_version_id"),
  },
  (table) => [
    index("aman_import_jobs_month_idx").on(table.month),
    index("aman_import_jobs_uploaded_at_idx").on(table.uploadedAt),
  ],
);

export const rosterVersionsTable = pgTable(
  "aman_roster_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    month: text("month").notNull(),
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    sourceImportId: uuid("source_import_id").references(() => importJobsTable.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => appUsersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => appUsersTable.id),
  },
  (table) => [
    uniqueIndex("aman_roster_versions_month_number_unique_idx").on(
      table.month,
      table.versionNumber,
    ),
    index("aman_roster_versions_month_status_idx").on(
      table.month,
      table.status,
    ),
  ],
);

export const shiftAssignmentsTable = pgTable(
  "aman_shift_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => rosterVersionsTable.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employeesTable.id),
    shiftTypeId: uuid("shift_type_id")
      .notNull()
      .references(() => shiftTypesTable.id),
    date: date("date", { mode: "string" }).notNull(),
    sourceEmployeeId: text("source_employee_id"),
    sourceEmployeeName: text("source_employee_name"),
    sourceDepartment: text("source_department"),
    sourceRole: text("source_role"),
    sourceRawShiftValue: text("source_raw_shift_value"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("aman_shift_assignments_person_day_unique_idx").on(
      table.versionId,
      table.date,
      table.employeeId,
    ),
    index("aman_shift_assignments_version_idx").on(table.versionId),
    index("aman_shift_assignments_date_idx").on(table.date),
  ],
);

export const auditLogsTable = pgTable(
  "aman_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => appUsersTable.id),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("aman_audit_logs_created_at_idx").on(table.createdAt),
    index("aman_audit_logs_actor_idx").on(table.actorUserId),
  ],
);

export const insertDepartmentSchema = createInsertSchema(departmentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departmentsTable.$inferSelect;

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;

export const insertEmployeeAliasSchema = createInsertSchema(
  employeeAliasesTable,
).omit({ id: true, createdAt: true });
export type InsertEmployeeAlias = z.infer<typeof insertEmployeeAliasSchema>;
export type EmployeeAlias = typeof employeeAliasesTable.$inferSelect;

export const insertAppUserSchema = createInsertSchema(appUsersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAppUser = z.infer<typeof insertAppUserSchema>;
export type AppUser = typeof appUsersTable.$inferSelect;

export const insertShiftTypeSchema = createInsertSchema(shiftTypesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertShiftType = z.infer<typeof insertShiftTypeSchema>;
export type ShiftType = typeof shiftTypesTable.$inferSelect;

export const insertImportJobSchema = createInsertSchema(importJobsTable).omit({
  id: true,
  uploadedAt: true,
});
export type InsertImportJob = z.infer<typeof insertImportJobSchema>;
export type ImportJob = typeof importJobsTable.$inferSelect;

export const insertRosterVersionSchema = createInsertSchema(
  rosterVersionsTable,
).omit({ id: true, createdAt: true });
export type InsertRosterVersion = z.infer<typeof insertRosterVersionSchema>;
export type RosterVersion = typeof rosterVersionsTable.$inferSelect;

export const insertShiftAssignmentSchema = createInsertSchema(
  shiftAssignmentsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShiftAssignment = z.infer<typeof insertShiftAssignmentSchema>;
export type ShiftAssignment = typeof shiftAssignmentsTable.$inferSelect;

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
