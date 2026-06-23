// routes/prospectsRoutes.js
import express from "express";
import authenticate from "../middleware/auth.js"; // adjust path to match your project
import {
  getProspects,
  getMyProspects,
  createProspect,
  updateProspect,
  deleteProspect,
} from "../controllers/prospects.controller.js";
import roleGuard from "../middleware/roleGuard.js";
import { getProspectHistory } from "../controllers/prospectHistory.controller.js";

const router = express.Router();

// All routes require a valid JWT
router.use(authenticate);


const managerOnly = roleGuard(["Admin"]);

router.get("/",      getProspects);      // GET  /api/prospects        (admin = all, user = own)
router.get("/mine",  getMyProspects);    // GET  /api/prospects/mine   (always current user only — used by Lead form picker)
router.post("/",     createProspect);    // POST /api/prospects
router.get("/:id/history", managerOnly, getProspectHistory);
router.put("/:id",   updateProspect);    // PUT  /api/prospects/:id
router.delete("/:id",deleteProspect);    // DELETE /api/prospects/:id

export default router;