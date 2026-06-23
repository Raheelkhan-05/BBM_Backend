// routes/dashboard.routes.js
import express from "express";
import { getDashboard } from "../controllers/dashboard.controller.js";
import authenticate from "../middleware/auth.js";

const router = express.Router();
router.get("/", authenticate, getDashboard);
export default router;
