// services/sendDailyReport.js

import { buildDailyReportData, buildLifetimeSummary, buildLifetimeActivityLog, buildStatusReport } from "./dailyReport.service.js";
import { buildDailyReportPdf } from "./pdfReport.builder.js";
import { sendMail } from "../config/mailer.js";

// Every address here gets its OWN individual email, addressed directly
// to them — not a single to+bcc email. This is what makes each
// recipient's "To" field show only their own address (BCC alone can't
// do that — a shared "To" address is still visible to every BCC'd
// recipient, even though they can't see each other).
const REPORT_RECIPIENTS = [
  "communication@bbmpvtltd.com",
  "jay@bbmpvtltd.com",
  // "someoneelse@bbmpvtltd.com",
];

function todayLabelIST() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

export async function sendDailyReport() {
  const [reportData, lifetimeSummary, lifetimeActivityLog, statusReport] = await Promise.all([
    buildDailyReportData(),
    buildLifetimeSummary(),
    buildLifetimeActivityLog(),
    buildStatusReport(),
  ]);
  const pdfBuffer = await buildDailyReportPdf(reportData, lifetimeSummary, lifetimeActivityLog, statusReport);
  const dateLabel = todayLabelIST();
  const filename = `BBM-Daily-Report-${dateLabel.replace(/\s+/g, "-")}.pdf`;

  const html = `
    <div style="font-family:sans-serif;color:#0f172a">
      <p>Hi,</p>
      <p>Attached is today's activity report (${dateLabel}): <strong>${reportData.totalActions}</strong>
      action(s) across <strong>${reportData.activeToday.length}</strong> active employee(s), plus a
      lifetime contribution summary and a full all-time activity history per employee. Most recent
      activity appears first within each employee's section, with every field-level change (added /
      updated / removed) shown per action.</p>
      <p style="color:#64748b;font-size:12px">This is an automated message from BBM CRM.</p>
    </div>
  `;

  // Sent sequentially (not Promise.all) — one connection at a time is
  // gentler on SMTP rate limits than opening several in parallel,
  // especially with pool:false in mailer.js meaning a fresh connection
  // per send. For a handful of recipients this adds negligible time.
  for (const email of REPORT_RECIPIENTS) {
    const result = await sendMail({
      to: email,
      subject: `[BBM CRM] Daily Activity Report — ${dateLabel}`,
      headers: {
        // Unique per recipient so each gets its own thread, not a
        // shared Message-ID that could confuse client-side threading.
        "Message-ID": `<daily-report-${Date.now()}-${email.replace(/[^a-zA-Z0-9]/g, "")}@bbm.crm>`,
      },
      html,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });
    if (!result?.success) {
      console.error(`[sendDailyReport] Failed to send to ${email}:`, result?.error);
    }
  }

  return reportData;
}