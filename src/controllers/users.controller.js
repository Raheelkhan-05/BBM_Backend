import { createClient } from "@supabase/supabase-js";
import { supabase } from "../config/supabase.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);


export const getUsers = async (req, res) => {
  try {
    const { data, error } =
      await supabaseAdmin
        .from("users")
        .select("*");

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    return res.json({
      success: true,
      users: data
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};


export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // delete from users table
    const { error } =
      await supabaseAdmin
        .from("users")
        .delete()
        .eq("id", userId);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    // delete from auth
    await supabaseAdmin.auth.admin.deleteUser(userId);

    return res.json({
      success: true,
      message: "User deleted"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};


export const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, email } = req.body;

    const { error } =
      await supabaseAdmin
        .from("users")
        .update({
          role,
          email
        })
        .eq("id", userId);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    return res.json({
      success: true,
      message: "User updated"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};