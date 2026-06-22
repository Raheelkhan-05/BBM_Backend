// backend/auth.controller.js
//
// ── How OTP works in this codebase ───────────────────────────────────────
//
//  1. We generate our own cryptographically random 6-digit code.
//  2. We bcrypt-hash it and store the hash in public.otp_codes (one row per email).
//  3. We send the plain 6-digit code via our own nodemailer + BBM HTML template.
//     → Supabase NEVER sends any email. No magic links. No default templates.
//  4. On verification the user submits the code. We:
//       a. Fetch the hash from otp_codes, check attempts < 5, check not expired.
//       b. bcrypt.compare() the submitted code against the stored hash.
//       c. Delete the row (single-use).
//       d. Call supabaseAdmin.auth.admin.createSession(userId) to mint a real
//          Supabase JWT session — no magic links, no race conditions.
//  5. Return { token, user } — same shape as every other auth endpoint —
//     so AuthContext and all downstream guards need zero changes.

import { createClient }  from "@supabase/supabase-js";
import { supabase } from "../config/supabase.js";
import { sendMail }      from "../config/mailer.js";
import { otpEmail }      from "../config/emailTemplates.js";
import bcrypt            from "bcrypt";
import crypto            from "crypto";


const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS   = 5;
const BCRYPT_ROUNDS      = 10;

// ── Internal helpers ──────────────────────────────────────────────────────

/** Generate a cryptographically random 6-digit string e.g. "083941" */
const makeOtpCode = () =>
  String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** Upsert an OTP row for this email (replaces any existing code). */
const storeOtp = async (email, code) => {
  const hash       = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from("otp_codes")
    .upsert(
      { email, code: hash, attempts: 0, expires_at },
      { onConflict: "email" }           // replaces existing row for this email
    );

  if (error) throw new Error(`Failed to store OTP: ${error.message}`);
};

/**
 * Verify a submitted code against the stored hash.
 * Returns the otp_codes row on success, throws a user-facing error otherwise.
 */
const verifyStoredOtp = async (email, submitted) => {
  const { data: row, error } = await supabaseAdmin
    .from("otp_codes")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) throw new Error("Database error. Please try again.");
  if (!row)  throw Object.assign(new Error("No code found. Please request a new one."), { status: 400 });

  // Expiry check
  if (new Date(row.expires_at) < new Date()) {
    await supabaseAdmin.from("otp_codes").delete().eq("email", email);
    throw Object.assign(new Error("This code has expired. Please request a new one."), { status: 401 });
  }

  // Attempt limit
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await supabaseAdmin.from("otp_codes").delete().eq("email", email);
    throw Object.assign(
      new Error("Too many incorrect attempts. Please request a new code."),
      { status: 429 }
    );
  }

  const match = await bcrypt.compare(submitted, row.code);

  if (!match) {
    // Increment attempt counter
    await supabaseAdmin
      .from("otp_codes")
      .update({ attempts: row.attempts + 1 })
      .eq("email", email);
    const remaining = OTP_MAX_ATTEMPTS - row.attempts - 1;
    throw Object.assign(
      new Error(`Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`),
      { status: 401 }
    );
  }

  // ✅ Correct — delete immediately (single-use)
  await supabaseAdmin.from("otp_codes").delete().eq("email", email);
  return row;
};

/**
 * Create a real Supabase session directly via the Admin API.
 * We have already verified the OTP ourselves, so we just need a session
 * for the user — no magic links, no token exchange, no race conditions.
 */
const createSupabaseSession = async (userId, email) => {
  // 1. Generate a magic link server-side (never sent to the user)
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    throw new Error(`Session creation failed: ${linkError?.message || "no hashed_token"}`);
  }

  // 2. Immediately exchange that token for a real session
  const { data: otpData, error: otpError } = await supabaseAdmin.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });

  if (otpError) throw new Error(`Session creation failed: ${otpError.message}`);

  return otpData.session; // has access_token + refresh_token
};

// ── POST /api/auth/signup ─────────────────────────────────────────────────
export const signup = async (req, res) => {
  try {
    const { email, first_name, last_name, phone } = req.body;

    if (!email || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        message: "Email, first name and last name are required.",
      });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Reject duplicates before touching Auth
    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please sign in.",
      });
    }

    // Create Supabase Auth user (email pre-confirmed; no password)
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email:         cleanEmail,
        email_confirm: true,
        user_metadata: {
          first_name: first_name.trim(),
          last_name:  last_name.trim(),
        },
      });

    if (authError) {
      return res.status(400).json({ success: false, message: authError.message });
    }

    const authUser = authData.user;

    // Insert profile row
    const { error: dbError } = await supabaseAdmin
      .from("users")
      .insert([{
        id:         authUser.id,
        email:      cleanEmail,
        first_name: first_name.trim(),
        last_name:  last_name.trim(),
        phone:      phone?.trim() || null,
        role:       "UNASSIGNED",
      }]);

    if (dbError) {
      await supabaseAdmin.auth.admin.deleteUser(authUser.id);
      return res.status(400).json({ success: false, message: dbError.message });
    }

    // Generate + store + send our own 6-digit OTP
    const code = makeOtpCode();
    await storeOtp(cleanEmail, code);
    await sendMail(
      otpEmail({ email: cleanEmail, name: first_name.trim(), token: code })
    );

    return res.status(201).json({
      success: true,
      message: "Account created! A 6-digit verification code has been sent to your email.",
    });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/auth/send-otp ───────────────────────────────────────────────
export const sendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const cleanEmail = email.toLowerCase().trim();

    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id, first_name")
      .eq("email", cleanEmail)
      .maybeSingle();

    // Generic response — don't reveal whether email is registered
    if (!user) {
      return res.json({
        success: true,
        message: "If that email is registered, a code has been sent.",
      });
    }

    const code = makeOtpCode();
    await storeOtp(cleanEmail, code);
    await sendMail(
      otpEmail({ email: cleanEmail, name: user.first_name || "", token: code })
    );

    return res.json({
      success: true,
      message: "A 6-digit code has been sent to your email.",
    });
  } catch (err) {
    console.error("sendOtp error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────
export const verifyOtp = async (req, res) => {
  try {
    const { email, token } = req.body;   // token = the 6-digit code from the user

    if (!email || !token) {
      return res.status(400).json({
        success: false,
        message: "Email and verification code are required.",
      });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanCode  = String(token).replace(/\s/g, "").trim();

    // 1. Verify the 6-digit code against our otp_codes table
    await verifyStoredOtp(cleanEmail, cleanCode);

    // 2. Fetch the app-level profile
    const { data: userData, error: userError } = await supabaseAdmin
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .single();

    if (userError || !userData) {
      return res.status(400).json({ success: false, message: "User profile not found." });
    }

    // 3. Block unassigned users BEFORE creating a session
    if (!userData.role || userData.role === "UNASSIGNED") {
      return res.status(403).json({
        success: false,
        message:
          "Your account is pending admin approval. You'll be notified once access is granted.",
      });
    }

    // 4. Create a real Supabase session for this user (by their auth UUID)
    const session = await createSupabaseSession(userData.id, cleanEmail);

    return res.json({
      success: true,
      token:   session.access_token,
      user:    userData,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message });
  }
};

// ── POST /api/auth/assign-role (admin only) ───────────────────────────────
export const assignRole = async (req, res) => {
  try {
    const { userId, role } = req.body;
    const { error } = await supabaseAdmin
      .from("users")
      .update({ role })
      .eq("id", userId);

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.json({ success: true, message: "Role updated successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};