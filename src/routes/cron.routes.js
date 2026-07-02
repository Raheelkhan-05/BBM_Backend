// src/routes/cron.routes.js
//
// Endpoint that Vercel Cron itself calls on a schedule (see vercel.json).
// This is NOT the same as the existing manual "send now" admin endpoint —
// this one has no user session at all, since Vercel's scheduler is the
// caller, not someone logged into the app. It's authorized instead via
// a shared secret: when you set a CRON_SECRET environment variable in
// your Vercel project, Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` on every request it makes to a
// scheduled path — we just verify that header matches.

import { Router } from "express";
import { sendDailyReport } from "../services/sendDailyReport.js";

const router = Router();

router.get("/daily-report", async (req, res) => {
  const auth = req.headers.authorization;

  // TEMPORARY DEBUG — remove once this is confirmed working. Logs only
  // booleans, never the actual secret, so it's safe to leave in Vercel's
  // logs briefly while diagnosing.
  console.log("[cron/daily-report] CRON_SECRET set?", Boolean(process.env.CRON_SECRET));
  console.log("[cron/daily-report] Authorization header present?", Boolean(auth));

  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const report = await sendDailyReport();
    console.log(`[cron/daily-report] Sent — ${report.totalActions} actions across ${report.activeToday.length} active employees.`);
    return res.json({ success: true, totalActions: report.totalActions });
  } catch (err) {
    console.error("[cron/daily-report] Failed:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;