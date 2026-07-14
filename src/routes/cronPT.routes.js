import { Router } from "express";
import { cronSyncPendingTasks, cronSendPendingTasksDigest } from "../controllers/adminActivity.controller.js";

const router = Router();

// No requireAuth here — these are hit by cron-job.org, not a logged-in user.
// Protected instead by CRON_SECRET checked inside each handler.
router.get("/pending-tasks/sync", cronSyncPendingTasks);
router.get("/pending-tasks/digest", cronSendPendingTasksDigest);

export default router;