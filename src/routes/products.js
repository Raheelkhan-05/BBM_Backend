import express from "express";
import authenticate from "../middleware/auth.js";
import roleGuard from "../middleware/roleGuard.js";
import { getProducts, createProduct, updateProduct, deleteProduct } from "../controllers/products.controller.js";

const router = express.Router();
router.use(authenticate);

const managerOnly = roleGuard(["Admin", "SalesCoordinator"]);

router.get("/", getProducts);
router.post("/", managerOnly, createProduct);
router.put("/:id", managerOnly, updateProduct);
router.delete("/:id", managerOnly, deleteProduct);

export default router;