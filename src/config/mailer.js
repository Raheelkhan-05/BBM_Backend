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
});

export const sendMail = async ({ to, subject, html, headers, attachments }) => {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
      // Threading headers (In-Reply-To, References, Message-ID).
      ...(headers ? { headers } : {}),
      // e.g. [{ filename: "report.pdf", content: bufferOrBase64, contentType: "application/pdf" }]
      ...(attachments ? { attachments } : {}),
    });
  } catch (err) {
    console.error("Mail error:", err.message);
    // Never throw — mail failure should not break API response
  }
};