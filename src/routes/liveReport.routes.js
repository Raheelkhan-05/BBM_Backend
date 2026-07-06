// routes/liveReport.routes.js
import { Router } from "express";
import authenticate from "../middleware/auth.js";   // default export, not { requireAuth }
import { getLiveReport } from "../controllers/liveReport.controller.js";

const router = Router();
router.get("/live", authenticate, getLiveReport);
export default router;