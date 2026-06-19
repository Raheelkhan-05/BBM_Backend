import { createClient } from "@supabase/supabase-js";
import { supabase } from "../config/supabase.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const signup = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Create Auth User
    const { data, error } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    const authUser = data.user;

    // 2. Insert into users table with UNASSIGNED role
    const { error: dbError } =
      await supabaseAdmin
        .from("users")
        .insert([
          {
            id: authUser.id,
            email,
            role: "UNASSIGNED"
          }
        ]);

    if (dbError) {
      return res.status(400).json({
        success: false,
        message: dbError.message
      });
    }

    return res.status(201).json({
      success: true,
      message: "User registered successfully. Await admin approval."
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Auth login
    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      return res.status(401).json({
        success: false,
        message: error.message
      });
    }

    const userId = data.user.id;

    // 2. Fetch user profile
    const { data: userData, error: userError } =
      await supabaseAdmin
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

    if (userError || !userData) {
      return res.status(400).json({
        success: false,
        message: "User profile not found"
      });
    }

    // 3. BLOCK LOGIN IF ROLE NOT ASSIGNED
    if (!userData.role || userData.role === "UNASSIGNED") {
      return res.status(403).json({
        success: false,
        message: "Account not approved by admin yet"
      });
    }

    return res.json({
      success: true,
      token: data.session.access_token,
      user: userData
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

export const assignRole = async (req, res) => {
  try {
    const { userId, role } = req.body;

    const { error } =
      await supabaseAdmin
        .from("users")
        .update({
          role
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
      message: "Role updated successfully"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};