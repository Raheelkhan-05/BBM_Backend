// routes/pos.routes.js
import express from "express";
import multer from "multer";
import authenticate from "../middleware/auth.js";
import {
  requirePOAccess, requirePOUploadAccess, requirePOAddAccess,
  requirePOEditDeleteAccess, requirePOToggleAccess,
} from "../middleware/poAccess.js";
import {
  uploadPOs, getPOs, getPOLogs, addFollowup, recordDelivery,
  createPO, updatePO, deletePO,
  setTrackingActive, cancelPO, revertLastAction,
} from "../controllers/pos.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate, requirePOAccess);

router.get("/", getPOs);
router.get("/:id/logs", getPOLogs);
router.put("/:id/followup", addFollowup);
router.put("/:id/delivery", requirePOToggleAccess, recordDelivery);

router.put("/:id/tracking-toggle", requirePOToggleAccess, setTrackingActive);
router.put("/:id/cancel", requirePOToggleAccess, cancelPO);
router.put("/:id/revert-last", requirePOToggleAccess, revertLastAction);

router.post("/upload", requirePOUploadAccess, upload.single("file"), uploadPOs);
router.post("/", requirePOAddAccess, createPO);

router.put("/:id", requirePOEditDeleteAccess, updatePO);
router.delete("/:id", requirePOEditDeleteAccess, deletePO);

export default router;