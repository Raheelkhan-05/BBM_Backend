// controllers/prospectsController.js
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import { prospectCreatedSalesperson } from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ─── Helpers ─────────────────────────────────────────────────── */
function extractProspectFields(body) {
  const {
    company_name,
    industry,
    country,
    state,
    city,
    zone,
    route,
    source,
    next_action,
    next_action_date,
    feedback,
  } = body;

  return {
    company_name,
    industry,
    country:          country || "India",
    state:            state   || null,
    city:             city    || null,
    zone:             zone    || null,
    route:            route   || null,
    source:           source  || null,
    next_action:      next_action      || null,
    next_action_date: next_action_date || null,
    feedback:         feedback         || null,
  };
}

/* ─── GET /api/prospects ──────────────────────────────────────── */
export const getProspects = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("prospects")
      .select("*, users(id, email, role)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    // Salesperson sees only their own prospects
    if (role !== "Admin") {
      query = query.eq("created_by", userId);
    }

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, prospects: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── GET /api/prospects/mine ─────────────────────────────────── */
export const getMyProspects = async (req, res) => {
  try {
    const { id: userId } = req.user;

    const { data, error } = await supabaseAdmin
      .from("prospects")
      .select("id, company_name, industry, city, zone, route, state, country, source, next_action, next_action_date, feedback")
      .is("deleted_at", null)
      .eq("created_by", userId)
      .order("company_name", { ascending: true });

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, prospects: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── POST /api/prospects ─────────────────────────────────────── */
export const createProspect = async (req, res) => {
  try {
    const { id: userId, email: salespersonEmail } = req.user;

    const fields = extractProspectFields(req.body);

    if (!fields.company_name?.trim()) {
      return res.status(400).json({ success: false, message: "Company name is required" });
    }

    const { data, error } = await supabaseAdmin
      .from("prospects")
      .insert([{ ...fields, company_name: fields.company_name.trim(), created_by: userId }])
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Acknowledge the salesperson who filed the prospect
    if (salespersonEmail) {
      sendMail(prospectCreatedSalesperson({ salespersonEmail, prospect: data }));
    }

    return res.status(201).json({ success: true, prospect: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── PUT /api/prospects/:id ──────────────────────────────────── */
export const updateProspect = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const fields = extractProspectFields(req.body);

    if (!fields.company_name?.trim()) {
      return res.status(400).json({ success: false, message: "Company name is required" });
    }

    // Ownership check
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("prospects")
      .select("created_by")
      .eq("id", id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: "Prospect not found" });
    }
    if (role !== "Admin" && existing.created_by !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { data, error } = await supabaseAdmin
      .from("prospects")
      .update({ ...fields, company_name: fields.company_name.trim(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, prospect: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── DELETE /api/prospects/:id ───────────────────────────────── */
export const deleteProspect = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("prospects")
      .select("created_by")
      .eq("id", id)
      .is("deleted_at", null)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: "Prospect not found" });
    }
    if (role !== "Admin" && existing.created_by !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { error } = await supabaseAdmin
      .from("prospects")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "Prospect deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};