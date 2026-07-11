import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./src/routes/auth.routes.js";
import prospects from "./src/routes/prospectsRoutes.js";
import leads from "./src/routes/leads.js";
import rfqsRouter from "./src/routes/rfqs.js";
import productsRouter from "./src/routes/products.js";
import routesRouter from "./src/routes/routes.js";
import samplesRouter from "./src/routes/samples.js";
import quotationsRouter from "./src/routes/quotations.js";
import auth from "./src/middleware/auth.js";
import dashboardRoutes from "./src/routes/dashboard.routes.js";
import reportsRoutes from "./src/routes/reports.routes.js";
import purgeRoutes from "./src/routes/purge.routes.js";
import cronRoutes from "./src/routes/cron.routes.js";
import billsRoutes from "./src/routes/bills.routes.js";
import liveReportRoutes from "./src/routes/liveReport.routes.js";
import ordersRouter from "./src/routes/orders.routes.js";
import productAuditLogs from "./src/routes/productAuditLogs.routes.js";
import routeAuditLogs from "./src/routes/routeAuditLogs.routes.js";
import adminActivityRoutes from "./src/routes/adminActivity.routes.js";
import { getProductAuditLogs } from "./src/controllers/productAuditLogs.controller.js";

dotenv.config();

const app = express();

app.use(cors());

app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/prospects", prospects);
app.use("/api/leads", leads);
app.use("/api/rfqs", rfqsRouter);
app.use("/api/products", productsRouter);
app.use("/api/routes", routesRouter);
app.use("/api/samples", samplesRouter);
app.use("/api/quotations", quotationsRouter);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportsRoutes); 
app.use("/api/purge", purgeRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/bills", billsRoutes);
app.use("/api/reports", liveReportRoutes);
app.use("/api/orders", ordersRouter);
app.use("/api/admin/activity", adminActivityRoutes);
app.use("/api/product-audit-logs", productAuditLogs);
app.use("/api/route-audit-logs", routeAuditLogs);

app.get("/api/me", auth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
  });
});

app.listen(process.env.PORT, () => {
  console.log("Server Started");
});

export default app;