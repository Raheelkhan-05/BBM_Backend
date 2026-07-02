// jobs/dailyReportCron.js
//
// Schedules the daily report for 7:00 PM IST every day.
// Requires: npm install node-cron --save
//
// Import this file once from your server entry point (e.g. index.js / app.js):
//   import "./jobs/dailyReportCron.js";
// That's enough — node-cron keeps the schedule alive as long as the process runs.

import cron from "node-cron";
import { sendDailyReport } from "../services/sendDailyReport.js";

// "0 19 * * *" = minute 0, hour 19 (7 PM), every day
cron.schedule(
  "21 17 * * *",
  async () => {
    console.log("[dailyReportCron] Running 7pm daily report job…");
    try {
      const report = await sendDailyReport();
      console.log(
        `[dailyReportCron] Sent. ${report.totalActions} actions across ${report.employees.length} employees.`
      );
    } catch (err) {
      console.error("[dailyReportCron] Failed to send daily report:", err.message);
    }
  },
  { timezone: "Asia/Kolkata" }
);

console.log("[dailyReportCron] Scheduled: daily report at 7:00 PM IST");