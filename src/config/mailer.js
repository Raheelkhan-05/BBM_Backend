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

export const sendMail = async ({ to, subject, html, headers }) => {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
      // Threading headers (In-Reply-To, References, Message-ID).
      // Nodemailer accepts them as a plain object here.
      ...(headers ? { headers } : {}),
    });
  } catch (err) {
    console.error("Mail error:", err.message);
    // Never throw — mail failure should not break API response
  }
};