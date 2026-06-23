// controllers/leads.controller.js — optimised
//
// Changes:
//  updateLead:  ownership check merged into the UPDATE itself (1 DB call instead of 2)
//  deleteLead:  samples/quotations/followups/rfqs soft-deleted in parallel (4 calls → 1 round)
//  createLead:  email is fire-and-forget (don't block response on SMTP)

import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import { leadCreatedSalesperson } from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

function extractLeadFields(body) {
  const {
    prospect_id, company_name, country, state, city, zone, route,
    primary_contact_name, primary_designation, primary_phone, primary_email,
    secondary_contact_name, secondary_designation, secondary_phone, secondary_email,
    nature_of_business, manufacturing_industry, company_website, gst_number, linkedin_profile,
    potential_product_category, potential_product_sub_category, potential_product_name,
  } = body;

  return {
    prospect_id: prospect_id || null,
    company_name,
    country: country || "India",
    state, city, zone, route,
    primary_contact_name, primary_designation, primary_phone, primary_email,
    secondary_contact_name: secondary_contact_name || null,
    secondary_designation:  secondary_designation  || null,
    secondary_phone:        secondary_phone        || null,
    secondary_email:        secondary_email        || null,
    nature_of_business,
    manufacturing_industry: nature_of_business === "Manufacturer" ? manufacturing_industry : null,
    company_website,
    gst_number:        gst_number        || null,
    linkedin_profile:  linkedin_profile  || null,
    potential_product_category:     potential_product_category     || null,
    potential_product_sub_category: potential_product_sub_category || null,
    potential_product_name:         potential_product_name         || null,
  };
}

// GET /api/leads
export const getLeads = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("leads")
      .select("*, users(id, email, role)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, leads: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/leads
export const createLead = async (req, res) => {
  try {
    const { id: userId, email: salespersonEmail } = req.user;
    const fields = extractLeadFields(req.body);

    if (!fields.company_name?.trim())
      return res.status(400).json({ success: false, message: "Company name is required" });

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([{ ...fields, company_name: fields.company_name.trim(), created_by: userId }])
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Fire-and-forget — don't make the user wait for SMTP
    if (salespersonEmail) sendMailAsync(leadCreatedSalesperson({ salespersonEmail, lead: data }));

    return res.status(201).json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/leads/:id
// OPTIMISED: merge ownership check into the UPDATE filter — 1 DB call instead of 2
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const fields = extractLeadFields(req.body);

    if (!fields.company_name?.trim())
      return res.status(400).json({ success: false, message: "Company name is required" });

    // Build the query — Admin can update any row; others can only update their own
    let query = supabaseAdmin
      .from("leads")
      .update({ ...fields, company_name: fields.company_name.trim(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null);

    // Ownership enforced at DB level — no separate fetch needed
    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query.select().single();

    if (error) {
      // PGRST116 = no rows matched (either not found or not owned)
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Lead not found or not authorized" });
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/leads/:id
// OPTIMISED: cascade soft-deletes run in parallel instead of sequentially
export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    // Ownership check + get RFQ ids in one query
    const ownerQuery = supabaseAdmin
      .from("leads")
      .select("created_by")
      .eq("id", id)
      .is("deleted_at", null)
      .single();

    const rfqQuery = supabaseAdmin
      .from("rfqs")
      .select("id")
      .eq("lead_id", id)
      .is("deleted_at", null);

    // Fetch ownership + RFQ ids in parallel
    const [{ data: existing, error: fetchError }, { data: rfqs }] =
      await Promise.all([ownerQuery, rfqQuery]);

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "Lead not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = new Date().toISOString();

    if (rfqs?.length) {
      const rfqIds = rfqs.map((r) => r.id);

      // Soft-delete all children in parallel — was 4 sequential awaits
      await Promise.all([
        supabaseAdmin.from("samples").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("quotations").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("rfq_followups").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("rfqs").update({ deleted_at: now }).in("id", rfqIds).is("deleted_at", null),
      ]);
    }

    const { error } = await supabaseAdmin.from("leads").update({ deleted_at: now }).eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};