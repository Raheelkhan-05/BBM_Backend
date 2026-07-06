import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getQuotations, getQuotationLogs, updateQuotation, getDueQuotations  } from "../controllers/quotations.controller.js";

const router = express.Router();
router.use(authenticate);
router.use(roleGuard(["Admin", "SalesCoordinator","Salesperson"]));

router.get("/due", getDueQuotations);
router.get("/", getQuotations);
router.get("/:id/logs", getQuotationLogs);
router.put("/:id", updateQuotation);

export default router;