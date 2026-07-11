// routes/productAuditLogs.routes.js
import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getProductAuditLogs } from "../controllers/productAuditLogs.controller.js";

const router = express.Router();
router.use(authenticate);
router.get("/", roleGuard(["Admin", "SalesCoordinator"]), getProductAuditLogs);

export default router;