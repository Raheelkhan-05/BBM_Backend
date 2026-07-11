// routes/routeAuditLogs.routes.js
import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getRouteAuditLogs } from "../controllers/routeAuditLogs.controller.js";

const router = express.Router();
router.use(authenticate);
router.get("/", roleGuard(["Admin", "SalesCoordinator"]), getRouteAuditLogs);

export default router;