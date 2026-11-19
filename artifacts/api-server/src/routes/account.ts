import { Router, type IRouter } from "express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { currentAppUser } from "../lib/amanAuth";

const router: IRouter = Router();

router.get("/me", (req, res): void => {
  const user = currentAppUser(req);
  res.json(
    GetCurrentUserResponse.parse({
      id: user.id,
      clerkUserId: user.clerkUserId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      departmentId: user.departmentId,
    }),
  );
});

export default router;
