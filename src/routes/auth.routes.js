import express from "express";

import {
  login,
  signup,
  assignRole
} from "../controllers/auth.controller.js";

import {
    getUsers,
    deleteUser,
    updateUser
} from "../controllers/users.controller.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);

// ADMIN ONLY
router.put("/assign-role", assignRole);

router.get("/users", getUsers);
router.delete("/users/:userId", deleteUser);
router.put("/users/:userId", updateUser);

export default router;