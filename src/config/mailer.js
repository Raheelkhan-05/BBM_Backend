// config/mailer.js
//
// Same as before, plus optional `attachments` support (needed for the
// daily PDF report). Existing calls to sendMail({to, subject, html, headers})
// keep working unchanged.

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  pool: false,
});

export const sendMail = async ({ to, subject, html, headers, attachments }) => {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
      ...(headers ? { headers } : {}),
      ...(attachments ? { attachments } : {}),
    });
    return { success: true };
  } catch (err) {
    console.error("Mail error:", err.message);
    return { success: false, error: err.message };
  }
};

export const sendMailWithRetry = async (opts, attempts = 2) => {
  for (let i = 0; i <= attempts; i++) {
    const result = await sendMail(opts);
    if (result.success) return result;
    if (i < attempts) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return { success: false, error: "max retries exceeded" };
};