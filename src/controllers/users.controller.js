import { createClient } from "@supabase/supabase-js";
import { invalidateProfileCache } from "../middleware/auth.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const getUsers = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, users: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin creates a user with a specific role immediately ──────────────────
export const adminCreateUser = async (req, res) => {
  try {
    const { email, first_name, last_name, phone, role } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }
    if (!role || role === "UNASSIGNED") {
      return res.status(400).json({ success: false, message: "A valid role is required." });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check if user already exists (active or inactive)
    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id, is_active")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existing) {
      if (existing.is_active === false) {
        // Reactivate — recreate Supabase auth entry
        const { data: authData, error: authError } =
          await supabaseAdmin.auth.admin.createUser({
            email:         cleanEmail,
            email_confirm: true,
            user_metadata: { first_name: first_name?.trim() || "", last_name: last_name?.trim() || "" },
          });

        // If auth creation failed, the auth user might still exist — find it
        let authId;
        if (authError) {
          const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
          const found = listData?.users?.find(u => u.email === cleanEmail);
          if (!found) {
            return res.status(400).json({ success: false, message: authError.message });
          }
          authId = found.id;
        } else {
          authId = authData.user.id;
        }

        const { error: dbError } = await supabaseAdmin
          .from("users")
          .update({
            id:         authId,
            is_active:  true,
            role:       role,             // ← admin-assigned role, not UNASSIGNED
            first_name: first_name?.trim() || "",
            last_name:  last_name?.trim()  || "",
            phone:      phone?.trim()      || null,
          })
          .eq("email", cleanEmail);

        if (dbError) {
          return res.status(400).json({ success: false, message: dbError.message });
        }

        return res.status(201).json({
          success: true,
          message: "User reactivated successfully.",
        });
      }

      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      });
    }

    // ── Brand new user ──────────────────────────────────────────────────
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email:         cleanEmail,
        email_confirm: true,
        user_metadata: {
          first_name: first_name?.trim() || "",
          last_name:  last_name?.trim()  || "",
        },
      });

    if (authError) {
      return res.status(400).json({ success: false, message: authError.message });
    }

    const { error: dbError } = await supabaseAdmin.from("users").insert([{
      id:         authData.user.id,
      email:      cleanEmail,
      first_name: first_name?.trim() || "",
      last_name:  last_name?.trim()  || "",
      phone:      phone?.trim()      || null,
      role:       role,               // ← admin-assigned role, not UNASSIGNED
      is_active:  true,
    }]);

    if (dbError) {
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return res.status(400).json({ success: false, message: dbError.message });
    }

    return res.status(201).json({
      success: true,
      message: "User created successfully.",
    });
  } catch (err) {
    console.error("adminCreateUser error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authError) console.warn("Auth deletion failed (non-fatal):", authError.message);

    const { error: dbError } = await supabaseAdmin
      .from("users")
      .update({ is_active: false, role: "UNASSIGNED" })
      .eq("id", userId);

    if (dbError) return res.status(400).json({ success: false, message: dbError.message });

    invalidateProfileCache(userId);
    return res.json({ success: true, message: "User deactivated" });
  } catch (err) {
    console.error("deactivateUser error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, first_name, last_name, phone } = req.body;

    const updates = {};
    if (role       !== undefined) updates.role       = role;
    if (first_name !== undefined) updates.first_name = first_name.trim();
    if (last_name  !== undefined) updates.last_name  = last_name.trim();
    if (phone      !== undefined) updates.phone      = phone?.trim() || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update" });
    }

    const { error } = await supabaseAdmin
      .from("users")
      .update(updates)
      .eq("id", userId);

    if (error) return res.status(400).json({ success: false, message: error.message });

    invalidateProfileCache(userId);
    return res.json({ success: true, message: "User updated" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};