// routes/orders.routes.js

import express from "express";
import authenticate from "../middleware/auth.js";
import { getOrders, createOrder, revertOrder } from "../controllers/orders.controller.js";

const router = express.Router();

router.get("/",     authenticate, getOrders);
router.post("/",    authenticate, createOrder);
router.delete("/:id", authenticate, revertOrder);

export default router;

// Then in your main app/router file:
//
//   import ordersRouter from "./routes/orders.routes.js";
//   app.use("/api/orders", ordersRouter);
//
// And apply the orders_table.sql migration before deploying this.