// controllers/reports.controller.js
//
// Lets an Admin trigger the daily report on demand — useful for testing
// before you rely on the 7pm cron job, or for re-sending after a meeting.
//
// IMPORTANT: report generation (6 paginated log queries + full-history
// diffing per changed record + an all-time lifetime scan) can take a
// while. If this endpoint waits for all of that before responding, a
// slow run can outlast your dev server / proxy / browser's request
// timeout, which cuts the connection and leaves the client trying to
// JSON-parse an empty body ("Unexpected end of JSON input"). So this
// responds immediately and runs the report in the background — same
// fire-and-forget pattern already used for emails elsewhere in this app.

import { sendDailyReport } from "../services/sendDailyReport.js";

// POST /api/reports/daily/send
export const sendDailyReportNow = async (req, res) => {
  const { role, email } = req.user;
  const isAuthorized = role === "Admin" || email === "communication@bbmpvtltd.com" || email === "jay@bbmpvtltd.com";
  if (!isAuthorized) {
    return res.status(403).json({ success: false, message: "Not authorized" });
  }

  // Respond right away — don't make the client wait on report generation.
  res.status(202).json({
    success: true,
    message: "Report generation started. It will be emailed to jay@bbmpvtltd.com shortly.",
  });

  // Runs after the response has already been sent. Any failure here is
  // logged server-side only, since the client has already moved on.
  try {
    const report = await sendDailyReport();
    console.log(
      `[reports] Manual send complete — ${report.totalActions} actions across ${report.activeToday.length} active employees.`
    );
  } catch (err) {
    console.error("[reports] Manual send failed:", err.message);
  }
};