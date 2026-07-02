// routes/purge.routes.js
//
// Wire into your main router:
//   import purgeRoutes from "./routes/purge.routes.js";
//   app.use("/api/purge", purgeRoutes);
//
// Every handler in purge.controller.js independently re-checks
// req.user.email === "communication@bbmpvtltd.com" — requireAuth here is
// just to populate req.user; the actual authorization happens per-handler.
// Adjust the middleware import path to match your project.

import { Router } from "express";
import requireAuth from "../middleware/auth.js"; // adjust path/name if different
import {
  purgeProspect,
  purgeLead,
  purgeEnquiry,
  purgeSample,
  purgeQuotation,
} from "../controllers/purge.controller.js";

const router = Router();

router.delete("/prospects/:id", requireAuth, purgeProspect);
router.delete("/leads/:id",     requireAuth, purgeLead);
router.delete("/rfqs/:id",      requireAuth, purgeEnquiry);
router.delete("/samples/:id",   requireAuth, purgeSample);
router.delete("/quotations/:id",requireAuth, purgeQuotation);

export default router;