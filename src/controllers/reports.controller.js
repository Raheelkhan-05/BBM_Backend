// controllers/reports.controller.js
//
// Lets an Admin trigger the daily report on demand — useful for testing
// before you rely on the 7pm cron job, or for re-sending after a meeting.

import { sendDailyReport } from "../services/sendDailyReport.js";

// POST /api/reports/daily/send
export const sendDailyReportNow = async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "Admin") {
      return res.status(403).json({ success: false, message: "Admin only" });
    }

    const report = await sendDailyReport();
    return res.json({
      success: true,
      message: `Report sent — ${report.totalActions} actions across ${report.employees.length} employees.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};