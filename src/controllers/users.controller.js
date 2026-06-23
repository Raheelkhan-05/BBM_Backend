// users.controller.js — optimised
//
// deleteUser: table delete + auth delete now run in parallel

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const getUsers = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("users").select("*");
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, users: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// OPTIMISED: table delete + auth delete in parallel (was sequential)
export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const [{ error: dbError }] = await Promise.all([
      supabaseAdmin.from("users").delete().eq("id", userId),
      supabaseAdmin.auth.admin.deleteUser(userId),
    ]);

    if (dbError) return res.status(400).json({ success: false, message: dbError.message });
    return res.json({ success: true, message: "User deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, email } = req.body;

    const { error } = await supabaseAdmin
      .from("users").update({ role, email }).eq("id", userId);

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, message: "User updated" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};