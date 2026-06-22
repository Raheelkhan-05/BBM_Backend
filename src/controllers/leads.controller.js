import { supabase } from "../config/supabase.js";
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  leadCreatedSalesperson,
  leadWelcomeCustomer,
} from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ────────────────────────────────────────────────────
function extractLeadFields(body) {
  const {
    prospect_id,
    company_name,
    country,
    state,
    city,
    zone,
    route,

    // Primary contact
    primary_contact_name,
    primary_designation,
    primary_phone,
    primary_email,

    // Secondary contact
    secondary_contact_name,
    secondary_designation,
    secondary_phone,
    secondary_email,

    // Business
    nature_of_business,
    manufacturing_industry,
    company_website,
    gst_number,
    linkedin_profile,

    // Potential product
    potential_product_category,
    potential_product_sub_category,
    potential_product_name,
  } = body;

  return {
    prospect_id: prospect_id || null,
    company_name,
    country: country || "India",
    state,
    city,
    zone,
    route,

    primary_contact_name,
    primary_designation,
    primary_phone,
    primary_email,

    secondary_contact_name: secondary_contact_name || null,
    secondary_designation: secondary_designation || null,
    secondary_phone: secondary_phone || null,
    secondary_email: secondary_email || null,

    nature_of_business,
    manufacturing_industry:
      nature_of_business === "Manufacturer" ? manufacturing_industry : null,
    company_website,
    gst_number: gst_number || null,
    linkedin_profile: linkedin_profile || null,

    potential_product_category: potential_product_category || null,
    potential_product_sub_category: potential_product_sub_category || null,
    potential_product_name: potential_product_name || null,
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

    if (role !== "Admin") {
      query = query.eq("created_by", userId);
    }

    const { data, error } = await query;

    if (error) {
      
      return res.status(400).json({ success: false, message: error.message });
    }

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

    if (!fields.company_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([{ ...fields, company_name: fields.company_name.trim(), created_by: userId }])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (salespersonEmail) {
      sendMail(leadCreatedSalesperson({ salespersonEmail, lead: data }));
      console.log(data);
      
    }
    // if (data.primary_email || data.secondary_email) {
    //   sendMail(
    //     leadWelcomeCustomer({
    //       customerEmail: data.primary_email || data.secondary_email,
    //       lead: data,
    //     })
    //   );
    // }

    return res.status(201).json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/leads/:id
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const fields = extractLeadFields(req.body);

    if (!fields.company_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    // Check ownership
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("leads")
      .select("created_by")
      .eq("id", id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }
    if (role !== "Admin" && existing.created_by !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { data, error } = await supabaseAdmin
      .from("leads")
      .update({ ...fields, company_name: fields.company_name.trim(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/leads/:id
export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("leads")
      .select("created_by")
      .eq("id", id)
      .is("deleted_at", null)
      .single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "Lead not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = new Date().toISOString();

    // 1. Get all RFQ ids under this lead
    const { data: rfqs } = await supabaseAdmin
      .from("rfqs")
      .select("id")
      .eq("lead_id", id)
      .is("deleted_at", null);

    if (rfqs?.length) {
      const rfqIds = rfqs.map((r) => r.id);

      // 2. Soft-delete samples, quotations, followups under these RFQs
      await supabaseAdmin
        .from("samples")
        .update({ deleted_at: now })
        .in("rfq_id", rfqIds)
        .is("deleted_at", null);

      await supabaseAdmin
        .from("quotations")
        .update({ deleted_at: now })
        .in("rfq_id", rfqIds)
        .is("deleted_at", null);

      await supabaseAdmin
        .from("rfq_followups")
        .update({ deleted_at: now })
        .in("rfq_id", rfqIds)
        .is("deleted_at", null);

      // 3. Soft-delete the RFQs
      await supabaseAdmin
        .from("rfqs")
        .update({ deleted_at: now })
        .in("id", rfqIds)
        .is("deleted_at", null);
    }

    // 4. Soft-delete the lead itself
    const { error } = await supabaseAdmin
      .from("leads")
      .update({ deleted_at: now })
      .eq("id", id);

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};