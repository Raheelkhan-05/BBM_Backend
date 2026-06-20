import { supabase } from "../config/supabase.js";
import { sendMail } from "../config/mailer.js";
import {
  rfqCreatedSalesperson,
  rfqCreatedCoordinator,
} from "../config/emailTemplates.js";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

async function getSalespersonEmail(userId) {
  const { data } = await supabaseAdmin
    .from("users")
    .select("email")
    .eq("id", userId)
    .single();
  return data?.email || null;
}

// GET /api/rfqs
export const getRFQs = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("rfqs")
      .select(`
        *,
        leads(id, company_name, primary_contact_name, city, country, state),
        users(id, email, role),
        rfq_followups(*),
        samples(id, sample_status, follow_up_date, updated_at),
        quotations(id, quotation_status, follow_up_date, updated_at)
      `)
      .order("created_at", { ascending: false });

    if (role !== "Admin") {
      query = query.eq("created_by", userId);
    }

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, rfqs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/rfqs/leads
export const getLeadsForRFQ = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("leads")
      .select("id, company_name, primary_contact_name, city, country, state")
      .order("company_name", { ascending: true });

    if (role !== "Admin") {
      query = query.eq("created_by", userId);
    }

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, leads: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/rfqs
export const createRFQ = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const {
      lead_id, company_name, product_category, product_sub_category,
      product_name, product_description, consumption_per_month, unit,
      sample_required, sample_description, sample_received_from_customer,
      quotation_required, quotation_description, existing_supplier_brand,
      notes, target_price, tds_available,
    } = req.body;

    if (role !== "Admin") {
      const { data: lead, error: leadError } = await supabaseAdmin
        .from("leads").select("created_by").eq("id", lead_id).single();
      if (leadError || !lead)
        return res.status(404).json({ success: false, message: "Lead not found" });
      if (lead.created_by !== userId)
        return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .insert([{
        lead_id, company_name, product_category, product_sub_category,
        product_name, product_description,
        consumption_per_month: consumption_per_month || null,
        unit, sample_required: sample_required ?? false,
        sample_description,
        sample_received_from_customer: sample_received_from_customer ?? false,
        quotation_required: quotation_required ?? false,
        quotation_description, existing_supplier_brand,
        notes: notes || null,
        target_price: target_price || null,
        tds_available: tds_available ?? false,
        created_by: userId,
      }])
      .select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    if (sample_required) {
      await supabaseAdmin.from("samples").insert([{
        rfq_id: data.id, sample_required: true,
        sample_status: null, follow_up_date: null, created_by: userId,
      }]);
    }
    if (quotation_required) {
      await supabaseAdmin.from("quotations").insert([{
        rfq_id: data.id, quotation_required: true,
        quotation_status: null, follow_up_date: null, created_by: userId,
      }]);
    }

    const salespersonEmail = await getSalespersonEmail(userId);
    if (salespersonEmail) {
      sendMail(rfqCreatedSalesperson({ salespersonEmail, rfq: data }));
    }
    if (COORDINATOR_EMAIL && (sample_required || quotation_required)) {
      sendMail(rfqCreatedCoordinator({
        coordinatorEmail: COORDINATOR_EMAIL,
        rfq: data,
        salespersonEmail: salespersonEmail || "Unknown",
      }));
    }

    return res.status(201).json({ success: true, rfq: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/rfqs/:id
export const updateRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      lead_id, company_name, product_category, product_sub_category,
      product_name, product_description, consumption_per_month, unit,
      sample_required, sample_description, sample_received_from_customer,
      quotation_required, quotation_description, existing_supplier_brand,
      notes, target_price, tds_available,
    } = req.body;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfqs")
      .select("created_by, sample_required, quotation_required")
      .eq("id", id).single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .update({
        lead_id, company_name, product_category, product_sub_category,
        product_name, product_description,
        consumption_per_month: consumption_per_month || null,
        unit, sample_required: sample_required ?? false,
        sample_description,
        sample_received_from_customer: sample_received_from_customer ?? false,
        quotation_required: quotation_required ?? false,
        quotation_description, existing_supplier_brand,
        notes: notes || null,
        target_price: target_price || null,
        tds_available: tds_available ?? false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    const salespersonEmail = await getSalespersonEmail(existing.created_by);

    // Sample toggle
    if (sample_required && !existing.sample_required) {
      await supabaseAdmin.from("samples").insert([{
        rfq_id: id, sample_required: true,
        sample_status: null, follow_up_date: null, created_by: userId,
      }]);
      if (COORDINATOR_EMAIL) {
        sendMail(rfqCreatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL, rfq: data,
          salespersonEmail: salespersonEmail || "Unknown",
        }));
      }
    } else if (!sample_required && existing.sample_required) {
      const { data: sampleRow } = await supabaseAdmin
        .from("samples").select("id").eq("rfq_id", id).single();
      if (sampleRow) {
        await supabaseAdmin.from("sample_logs").delete().eq("sample_id", sampleRow.id);
        await supabaseAdmin.from("samples").delete().eq("rfq_id", id);
      }
    }

    // Quotation toggle
    if (quotation_required && !existing.quotation_required) {
      await supabaseAdmin.from("quotations").insert([{
        rfq_id: id, quotation_required: true,
        quotation_status: null, follow_up_date: null, created_by: userId,
      }]);
      if (COORDINATOR_EMAIL) {
        sendMail(rfqCreatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL, rfq: data,
          salespersonEmail: salespersonEmail || "Unknown",
        }));
      }
    } else if (!quotation_required && existing.quotation_required) {
      const { data: quotRow } = await supabaseAdmin
        .from("quotations").select("id").eq("rfq_id", id).single();
      if (quotRow) {
        await supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", quotRow.id);
        await supabaseAdmin.from("quotations").delete().eq("rfq_id", id);
      }
    }

    return res.json({ success: true, rfq: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/rfqs/:id
export const deleteRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfqs").select("created_by").eq("id", id).single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { error } = await supabaseAdmin.from("rfqs").delete().eq("id", id);
    if (error) 
      {
          console.log(error);
        return res.status(400).json({ success: false, message: error.message });
      }

    return res.json({ success: true, message: "RFQ deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── FOLLOW-UPS ─────────────────────────────────────────────────

// GET /api/rfqs/:rfqId/followups
export const getFollowups = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;

    const { data: rfq, error: rfqError } = await supabaseAdmin
      .from("rfqs").select("created_by").eq("id", rfqId).single();

    if (rfqError || !rfq)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && rfq.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { data, error } = await supabaseAdmin
      .from("rfq_followups")
      .select("*")
      .eq("rfq_id", rfqId)
      .order("followup_date", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, followups: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/rfqs/:rfqId/followups
export const createFollowup = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;
    const {
      contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date, target_price,
      enquiry_status, remark,
    } = req.body;

    const { data: rfq, error: rfqError } = await supabaseAdmin
      .from("rfqs").select("created_by").eq("id", rfqId).single();

    if (rfqError || !rfq)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && rfq.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { data, error } = await supabaseAdmin
      .from("rfq_followups")
      .insert([{
        rfq_id: rfqId, contact_type, sample_status_update,
        quotation_status_update, next_action, notes,
        followup_date: followup_date || null,
        target_price: target_price || null,
        enquiry_status, remark, created_by: userId,
      }])
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.status(201).json({ success: true, followup: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/rfqs/followups/:id
export const updateFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date, target_price,
      enquiry_status, remark,
    } = req.body;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfq_followups").select("created_by").eq("id", id).single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "Follow-up not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { data, error } = await supabaseAdmin
      .from("rfq_followups")
      .update({
        contact_type, sample_status_update, quotation_status_update,
        next_action, notes, followup_date: followup_date || null,
        target_price: target_price || null, enquiry_status, remark,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, followup: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/rfqs/followups/:id
export const deleteFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfq_followups").select("created_by").eq("id", id).single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "Follow-up not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const { error } = await supabaseAdmin.from("rfq_followups").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};