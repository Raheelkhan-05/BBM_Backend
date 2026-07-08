// routes/bills.routes.js
import express from "express";
import multer from "multer";
import authenticate from "../middleware/auth.js";
import {
  requireBillAccess, requireBillUploadAccess, requireBillAddAccess,
  requireBillEditDeleteAccess, requireBillToggleAccess,
} from "../middleware/billAccess.js";
import {
  uploadBills, getBills, getBillLogs, addFollowup, collectPayment,
  createBill, updateBill, deleteBill,
  setCollectionActive, clearCheque, bounceCheque,
} from "../controllers/bills.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate, requireBillAccess);

router.get("/", getBills);
router.get("/:id/logs", getBillLogs);
router.put("/:id/followup", addFollowup);
router.put("/:id/payment", collectPayment);

router.put("/:id/collection-toggle", requireBillToggleAccess, setCollectionActive);
router.put("/:id/cheque/:chequeId/clear", requireBillToggleAccess, clearCheque);
router.put("/:id/cheque/:chequeId/bounce", requireBillToggleAccess, bounceCheque);

router.post("/upload", requireBillUploadAccess, upload.single("file"), uploadBills);
router.post("/", requireBillAddAccess, createBill);

router.put("/:id", requireBillEditDeleteAccess, updateBill);
router.delete("/:id", requireBillEditDeleteAccess, deleteBill);

export default router;