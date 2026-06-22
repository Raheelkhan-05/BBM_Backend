import express from "express";

import {
  // login,
  signup,
  sendOtp,
  verifyOtp,
  assignRole
} from "../controllers/auth.controller.js";
import roleGuard from "../middleware/roleGuard.js";
import authenticate from "../middleware/auth.js";


import {
    getUsers,
    deleteUser,
    updateUser
} from "../controllers/users.controller.js";

const router = express.Router();
const managerOnly = roleGuard(["Admin"]);

// router.post("/signup", signup);
// router.post("/login", login);

// Public routes
router.post("/signup",      signup);      // register profile + send first OTP
router.post("/send-otp",    sendOtp);     // request / resend OTP (login page)
router.post("/verify-otp",  verifyOtp);   // verify OTP → returns { token, user }

// ADMIN ONLY
// router.put("/assign-role", assignRole);
router.post("/assign-role", authenticate, managerOnly, assignRole);

router.get("/users", getUsers);
router.delete("/users/:userId", deleteUser);
router.put("/users/:userId", updateUser);

export default router;