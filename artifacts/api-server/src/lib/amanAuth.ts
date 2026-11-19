import {
  clerkClient,
  getAuth,
} from "@clerk/express";
import type {
  NextFunction,
  Request,
  Response,
} from "express";
import { eq } from "drizzle-orm";
import {
  appUsersTable,
  db,
  employeesTable,
  type AppUser,
} from "@workspace/db";

export type AmanRequest = Request & { amanUser?: AppUser };

function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.AMAN_ADMIN_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requireAuthenticatedUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    const clerkUser = await clerkClient.users.getUser(userId);
    const primaryEmail = clerkUser.emailAddresses.find(
      (entry) => entry.id === clerkUser.primaryEmailAddressId,
    );
    const email = primaryEmail?.emailAddress ?? "";
    const fullName =
      clerkUser.fullName?.trim() ||
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      email ||
      "Team member";
    const isVerified = primaryEmail?.verification?.status === "verified";
    const role =
      isVerified && configuredAdminEmails().has(email.toLowerCase())
        ? "admin"
        : "staff";

    const [matchedEmployee] = email
      ? await db
          .select({
            id: employeesTable.id,
            departmentId: employeesTable.departmentId,
          })
          .from(employeesTable)
          .where(eq(employeesTable.email, email))
          .limit(1)
      : [];

    const [localUser] = await db
      .insert(appUsersTable)
      .values({
        clerkUserId: userId,
        email,
        fullName,
        role,
        employeeId: matchedEmployee?.id ?? null,
        departmentId: matchedEmployee?.departmentId ?? null,
      })
      .onConflictDoUpdate({
        target: appUsersTable.clerkUserId,
        set: {
          email,
          fullName,
          role,
          employeeId: matchedEmployee?.id ?? null,
          departmentId: matchedEmployee?.departmentId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();

    (req as AmanRequest).amanUser = localUser;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Could not load signed-in Aman user");
    res.status(401).json({ error: "Unable to verify signed-in user" });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if ((req as AmanRequest).amanUser?.role !== "admin") {
    res.status(403).json({ error: "Administrator access required" });
    return;
  }
  next();
}

export function currentAppUser(req: Request): AppUser {
  const user = (req as AmanRequest).amanUser;
  if (!user) {
    throw new Error("Authenticated app user is missing from request");
  }
  return user;
}
