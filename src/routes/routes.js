import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getRoutes, createRoute, updateRoute, deleteRoute } from "../controllers/routes.controller.js";

const router = express.Router();
router.use(authenticate);

const adminOnly = roleGuard(["Admin"]);

router.get("/", getRoutes);
router.post("/", createRoute);          // all roles — salesperson creates while filling lead
router.put("/:id", adminOnly, updateRoute);
router.delete("/:id", adminOnly, deleteRoute);

export default router;