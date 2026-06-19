import express from "express";
import authenticate from "../middleware/auth.js";
import {
  getRFQs, getLeadsForRFQ, createRFQ, updateRFQ, deleteRFQ,
  getFollowups, createFollowup, updateFollowup, deleteFollowup,
} from "../controllers/rfq.controller.js";

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

export default router;