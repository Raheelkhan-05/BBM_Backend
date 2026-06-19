import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getSamples, getSampleLogs, updateSample } from "../controllers/samples.controller.js";

const router = express.Router();
router.use(authenticate);
router.use(roleGuard(["Admin", "SalesCoordinator"]));

router.get("/", getSamples);
router.get("/:id/logs", getSampleLogs);
router.put("/:id", updateSample);

export default router;