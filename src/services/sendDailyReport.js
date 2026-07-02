// services/sendDailyReport.js

import { buildDailyReportData, buildLifetimeSummary, buildLifetimeActivityLog } from "./dailyReport.service.js";
import { buildDailyReportPdf } from "./pdfReport.builder.js";
import { sendMail } from "../config/mailer.js";

// Add as many recipients as you need — everyone here goes on BCC, so
// none of them can see who else received the report. The visible "To"
// address is set separately below (a neutral self-send), since an email
// with no visible recipients at all can look broken or get flagged by
// spam filters.
const REPORT_RECIPIENTS_BCC = [
  "communication@bbmpvtltd.com",
  "2005raheelkhan@gmail.com",
  // "someoneelse@bbmpvtltd.com",
];

// The one visible "To" address — recipients only see this, never each
// other. Using the first BCC address here is fine (that person just sees
// their own email in "To", same as everyone else on BCC sees nothing).
const REPORT_VISIBLE_TO = "communication@bbmpvtltd.com";

function todayLabelIST() {
  return new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export async function sendDailyReport() {
  const [reportData, lifetimeSummary, lifetimeActivityLog] = await Promise.all([
    buildDailyReportData(),
    buildLifetimeSummary(),
    buildLifetimeActivityLog(),
  ]);
  const pdfBuffer = await buildDailyReportPdf(reportData, lifetimeSummary, lifetimeActivityLog);
  const dateLabel = todayLabelIST();

  await sendMail({
    to: REPORT_VISIBLE_TO,
    bcc: REPORT_RECIPIENTS_BCC,
    subject: `[BBM CRM] Daily Activity Report — ${dateLabel}`,
    headers: {
      "Message-ID": `<daily-report-${Date.now()}@bbm.crm>`,
    },
    html: `
      <div style="font-family:sans-serif;color:#0f172a">
        <p>Hi,</p>
        <p>Attached is today's activity report (${dateLabel}): <strong>${reportData.totalActions}</strong>
        action(s) across <strong>${reportData.activeToday.length}</strong> active employee(s), plus a
        lifetime contribution summary and a full all-time activity history per employee. Most recent
        activity appears first within each employee's section, with every field-level change (added /
        updated / removed) shown per action.</p>
        <p style="color:#64748b;font-size:12px">This is an automated message from BBM CRM.</p>
      </div>
    `,
    attachments: [
      {
        filename: `BBM-Daily-Report-${dateLabel.replace(/\s+/g, "-")}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });

  return reportData;
}