import express from "express";
import authenticate from "../middleware/auth.js";
import {
  getRFQs, getLeadsForRFQ, createRFQ, updateRFQ, deleteRFQ,
  getFollowups, createFollowup, updateFollowup, deleteFollowup,
  getDueFollowups, resolveFollowup
} from "../controllers/rfq.controller.js";
import roleGuard from "../middleware/roleGuard.js";

const router = express.Router();
router.use(authenticate);

// RFQs
router.get("/", getRFQs);
router.get("/leads", getLeadsForRFQ);
router.post("/", createRFQ);
router.put("/:id", updateRFQ);
router.delete("/:id", deleteRFQ);

// Follow-ups
router.get("/:rfqId/followups", getFollowups);
router.post("/:rfqId/followups", createFollowup);
router.put("/followups/:id", updateFollowup);
router.delete("/followups/:id", deleteFollowup);

router.use(roleGuard(["Admin", "SalesCoordinator"]));
router.get("/followups/due", getDueFollowups);
router.post("/:id/followups/resolve", resolveFollowup);

export default router;