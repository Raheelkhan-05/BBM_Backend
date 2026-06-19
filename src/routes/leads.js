// routes/leads.js
import express from "express";
import authenticate from "../middleware/auth.js";
import { getLeads, createLead, updateLead, deleteLead } from "../controllers/leads.controller.js";

const router = express.Router();

// Make sure authenticate is here on every route
router.get("/", authenticate, getLeads);
router.post("/", authenticate, createLead);
router.put("/:id", authenticate, updateLead);
router.delete("/:id", authenticate, deleteLead);

export default router;