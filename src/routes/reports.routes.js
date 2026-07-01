 
import { Router } from "express";
import { sendDailyReportNow } from "../controllers/reports.controller.js";
import authenticate from "../middleware/auth.js"; // adjust path/name if different
 
const router = Router();

router.use(authenticate);
 
router.post("/daily/send", sendDailyReportNow);
 
export default router;
 