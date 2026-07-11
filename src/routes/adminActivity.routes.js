// routes/adminActivity.routes.js
import { Router } from "express";
import requireAuth from "../middleware/auth.js";
import {
  getTodayActivity, getStatusBoard, searchCompaniesEndpoint, getCompanyTimeline,
  getActivityFeed, getAllTimeByEmployee, searchBillPartiesEndpoint, getPartyBillTimeline, getSingleBillTimeline,
  getStageMatrix
} from "../controllers/adminActivity.controller.js";

const router = Router();
router.use(requireAuth);
router.get("/today", getTodayActivity);
router.get("/status", getStatusBoard);
router.get("/companies", searchCompaniesEndpoint);
router.get("/companies/:leadId", getCompanyTimeline);
router.get("/feed", getActivityFeed);
router.get("/by-employee", getAllTimeByEmployee);
router.get("/bills/parties", searchBillPartiesEndpoint);
router.get("/bills/parties/:partyName", getPartyBillTimeline);
router.get("/bills/:billId", getSingleBillTimeline);
router.get("/stage-matrix", getStageMatrix);



export default router;