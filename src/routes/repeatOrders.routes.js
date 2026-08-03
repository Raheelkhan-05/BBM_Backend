// routes/repeatOrders.routes.js
import express from "express";
import multer from "multer";
import authenticate from "../middleware/auth.js";
import { requireRepeatOrderAccess, requireRepeatOrderManagerAccess } from "../middleware/repeatOrderAccess.js";
import {
  uploadRepeatOrders, getRepeatOrders, getAssignableUsers, getRepeatOrderLogs,
  createRepeatOrder, updateRepeatOrder, deleteRepeatOrder,
  assignRepeatOrder, addFollowup, takeOrder, resolveOrderMatch,
  markNotInterested, reopenFollowUp, revertLastAction, sweepReopenNow,
} from "../controllers/repeatOrders.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Every route below requires a logged-in user; requireRepeatOrderAccess
// does NOT filter by role — see that file's comment for why. Per-record
// ownership (assignee-or-manager) is enforced inside the controller
// functions themselves, since it needs to look up who the record is
// currently assigned to.
router.use(authenticate, requireRepeatOrderAccess);

router.get("/", getRepeatOrders);
router.get("/assignable-users", requireRepeatOrderManagerAccess, getAssignableUsers);
router.get("/:id/logs", getRepeatOrderLogs);

router.put("/:id/assign", requireRepeatOrderManagerAccess, assignRepeatOrder);
router.put("/:id/followup", addFollowup);
router.put("/:id/take-order", takeOrder);
router.put("/:id/orders/:orderId/match", resolveOrderMatch);
router.put("/:id/not-interested", markNotInterested);
router.put("/:id/reopen", reopenFollowUp);
router.put("/:id/revert-last", revertLastAction);

router.post("/upload", requireRepeatOrderManagerAccess, upload.single("file"), uploadRepeatOrders);
router.post("/", requireRepeatOrderManagerAccess, createRepeatOrder);

// Optional: wire an external scheduler (Supabase cron / pg_cron edge
// function / GitHub Actions, etc.) to POST here periodically so records
// reopen even when nobody has the app open. The list endpoint already
// sweeps inline on every load, so this is a belt-and-braces extra, not
// a requirement.
router.post("/sweep-reopen", requireRepeatOrderManagerAccess, sweepReopenNow);

router.put("/:id", requireRepeatOrderManagerAccess, updateRepeatOrder);
router.delete("/:id", requireRepeatOrderManagerAccess, deleteRepeatOrder);

export default router;