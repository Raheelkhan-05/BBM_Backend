// routes/auth.routes.js
import express from "express";
import { signup, sendOtp, verifyOtp, assignRole } from "../controllers/auth.controller.js";
import { getUsers, deleteUser, updateUser, adminCreateUser }        from "../controllers/users.controller.js";
import authenticate  from "../middleware/auth.js";
import roleGuard     from "../middleware/roleGuard.js";


const router     = express.Router();
const adminOnly  = [authenticate, roleGuard(["Admin"])];

// ── Public (no token required) ─────────────────────────────────────────────
router.post("/signup",     signup);
router.post("/send-otp",   sendOtp);
router.post("/verify-otp", verifyOtp);

// ── Admin only ─────────────────────────────────────────────────────────────
// NOTE: getUsers, deleteUser, updateUser had NO auth guard before — anyone
// on the internet could list/delete/modify your users. Fixed here.
router.post  ("/admin/create-user",  ...adminOnly, adminCreateUser);
router.post  ("/assign-role",    ...adminOnly, assignRole);
router.get   ("/users",          ...adminOnly, getUsers);
router.delete("/users/:userId",  ...adminOnly, deleteUser);
router.put   ("/users/:userId",  ...adminOnly, updateUser);

export default router;