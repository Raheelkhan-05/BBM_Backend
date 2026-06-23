// backend/middleware/auth.js
//
// Optimisation: in-process user profile cache
//
// BEFORE every request:
//   1. supabaseAdmin.auth.getUser(token)   → ~100-150ms network call to Supabase Auth
//   2. supabaseAdmin.from("users").select  → ~100-150ms second network call
//   Total: ~200-300ms added to EVERY authenticated request
//
// AFTER:
//   1. supabaseAdmin.auth.getUser(token)   → still needed (Supabase verifies the JWT signature)
//   2. profile lookup                      → served from in-process Map cache (< 1ms)
//   Total: ~100-150ms — cuts middleware overhead roughly in half
//
// Cache TTL is 5 minutes. Roles rarely change; if an admin reassigns a role,
// the user just needs to log out and back in (or wait 5 min) to pick it up.
// You can lower TTL_MS if you need faster role propagation.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── In-process profile cache ───────────────────────────────────────────────
// Key: Supabase auth user UUID  →  Value: { profile, cachedAt }
// Lives as long as the serverless function instance is warm.
// On Vercel free tier, instances stay warm for ~5-10 min between requests,
// so this meaningfully reduces DB hits during active usage.
const profileCache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedProfile(userId) {
  const entry = profileCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    profileCache.delete(userId);
    return null;
  }
  return entry.profile;
}

function setCachedProfile(userId, profile) {
  profileCache.set(userId, { profile, cachedAt: Date.now() });
  // Prevent unbounded growth — evict oldest entries beyond 500 users
  if (profileCache.size > 500) {
    const oldest = profileCache.keys().next().value;
    profileCache.delete(oldest);
  }
}

// Call this from your role-assignment endpoint so the new role
// is reflected immediately without waiting for TTL expiry.
export function invalidateProfileCache(userId) {
  profileCache.delete(userId);
}

// ── Middleware ─────────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = header.split(" ")[1];

  try {
    // Step 1: Verify the JWT with Supabase Auth (unavoidable — this is the security check)
    const { data: { user: authUser }, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authUser) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // Step 2: Get the app profile — from cache if warm, DB otherwise
    let userData = getCachedProfile(authUser.id);

    if (!userData) {
      const { data, error: userError } = await supabaseAdmin
        .from("users")
        .select("id, email, role")
        .eq("id", authUser.id)
        .single();

      if (userError || !data) {
        return res.status(401).json({ message: "User profile not found" });
      }

      userData = data;
      setCachedProfile(authUser.id, userData);
    }

    if (!userData.role || userData.role === "UNASSIGNED") {
      return res.status(403).json({ message: "Account not approved" });
    }

    req.user = userData;
    next();
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

export default authenticate;