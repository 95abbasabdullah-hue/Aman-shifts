import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { requireAuthenticatedUser } from "../lib/amanAuth";
import accountRouter from "./account";
import catalogRouter from "./catalog";
import scheduleRouter from "./schedule";
import importsRouter from "./imports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuthenticatedUser);
router.use(accountRouter);
router.use(catalogRouter);
router.use(scheduleRouter);
router.use(importsRouter);

export default router;
