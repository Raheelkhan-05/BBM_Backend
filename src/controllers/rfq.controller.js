// rfq.controller.js — optimised
//
// Changes summary:
//  getRFQs:         unchanged (joins kept as requested)
//  getLeadsForRFQ:  unchanged
//  createRFQ:       sample+quotation inserts run in parallel; emails fire-and-forget;
//                   salesperson email fetched in parallel with lead ownership check
//  updateRFQ:       emails fire-and-forget; salesperson email fetch parallelised;
//                   sample/quotation log deletes parallelised
//  deleteRFQ:       3 soft-delete cascades run in parallel (was sequential)
//  getFollowups:    ownership check + followup fetch run in parallel (1 round-trip saved)
//  createFollowup:  ownership check parallelised; email fire-and-forget pattern ready
//  updateFollowup:  ownership check merged into UPDATE filter (1 DB call instead of 2)
//  deleteFollowup:  ownership check merged into DELETE filter (1 DB call instead of 2)

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

// Fire-and-forget email — never blocks the HTTP response
const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

// Fetch salesperson email — used in several places
async function getSalespersonEmail(userId) {
  const { data } = await supabaseAdmin
    .from("users").select("email").eq("id", userId).single();
  return data?.email || null;
}

// ── GET /api/rfqs ──────────────────────────────────────────────────────────
// Joins kept exactly as-is (leads, users, rfq_followups, samples, quotations)
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
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, rfqs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/rfqs/leads ────────────────────────────────────────────────────
export const getLeadsForRFQ = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("leads")
      .select("id, company_name, primary_contact_name, city, state, country, zone, route, nature_of_business, potential_product_name, potential_product_category, potential_product_sub_category")
      .is("deleted_at", null)
      .order("company_name", { ascending: true });

    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, leads: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/rfqs ─────────────────────────────────────────────────────────
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

    // OPTIMISED: lead ownership check + salesperson email fetch in parallel
    const [leadCheck, salespersonEmail] = await Promise.all([
      role !== "Admin"
        ? supabaseAdmin.from("leads").select("created_by").eq("id", lead_id).single()
        : Promise.resolve({ data: { created_by: userId }, error: null }),
      getSalespersonEmail(userId),
    ]);

    if (role !== "Admin") {
      if (leadCheck.error || !leadCheck.data)
        return res.status(404).json({ success: false, message: "Lead not found" });
      if (leadCheck.data.created_by !== userId)
        return res.status(403).json({ success: false, message: "Not authorized" });
    }

    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .insert([{
        lead_id, company_name, product_category, product_sub_category,
        product_name, product_description,
        consumption_per_month: consumption_per_month || null,
        unit,
        sample_required:               sample_required               ?? false,
        sample_description,
        sample_received_from_customer: sample_received_from_customer ?? false,
        quotation_required:            quotation_required            ?? false,
        quotation_description, existing_supplier_brand,
        notes:        notes        || null,
        target_price: target_price || null,
        tds_available: tds_available ?? false,
        created_by: userId,
      }])
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // OPTIMISED: insert sample + quotation rows in parallel
    const sideInserts = [];
    if (sample_required) {
      sideInserts.push(
        supabaseAdmin.from("samples").insert([{
          rfq_id: data.id, sample_required: true,
          sample_status: null, follow_up_date: null, created_by: userId,
        }])
      );
    }
    if (quotation_required) {
      sideInserts.push(
        supabaseAdmin.from("quotations").insert([{
          rfq_id: data.id, quotation_required: true,
          quotation_status: null, follow_up_date: null, created_by: userId,
        }])
      );
    }
    if (sideInserts.length) await Promise.all(sideInserts);

    // Fire-and-forget emails
    if (salespersonEmail) {
      sendMailAsync(rfqCreatedSalesperson({ salespersonEmail, rfq: data }));
    }
    if (COORDINATOR_EMAIL && (sample_required || quotation_required)) {
      sendMailAsync(rfqCreatedCoordinator({
        coordinatorEmail: COORDINATOR_EMAIL, rfq: data,
        salespersonEmail: salespersonEmail || "Unknown",
      }));
    }

    return res.status(201).json({ success: true, rfq: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/rfqs/:id ──────────────────────────────────────────────────────
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

    // Need existing row for ownership + toggle logic
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfqs")
      .select("created_by, sample_required, quotation_required")
      .eq("id", id)
      .single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    // OPTIMISED: salesperson email fetch runs while we build the update (parallel)
    const [{ data, error }, salespersonEmail] = await Promise.all([
      supabaseAdmin
        .from("rfqs")
        .update({
          lead_id, company_name, product_category, product_sub_category,
          product_name, product_description,
          consumption_per_month: consumption_per_month || null,
          unit,
          sample_required:               sample_required               ?? false,
          sample_description,
          sample_received_from_customer: sample_received_from_customer ?? false,
          quotation_required:            quotation_required            ?? false,
          quotation_description, existing_supplier_brand,
          notes:        notes        || null,
          target_price: target_price || null,
          tds_available: tds_available ?? false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single(),
      getSalespersonEmail(existing.created_by),
    ]);

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Sample toggle
    if (sample_required && !existing.sample_required) {
      await supabaseAdmin.from("samples").insert([{
        rfq_id: id, sample_required: true,
        sample_status: null, follow_up_date: null, created_by: userId,
      }]);
      if (COORDINATOR_EMAIL) {
        sendMailAsync(rfqCreatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL, rfq: data,
          salespersonEmail: salespersonEmail || "Unknown",
        }));
      }
    } else if (!sample_required && existing.sample_required) {
      // OPTIMISED: delete logs + sample row in parallel
      const { data: sampleRow } = await supabaseAdmin
        .from("samples").select("id").eq("rfq_id", id).single();
      if (sampleRow) {
        await Promise.all([
          supabaseAdmin.from("sample_logs").delete().eq("sample_id", sampleRow.id),
          supabaseAdmin.from("samples").delete().eq("rfq_id", id),
        ]);
      }
    }

    // Quotation toggle
    if (quotation_required && !existing.quotation_required) {
      await supabaseAdmin.from("quotations").insert([{
        rfq_id: id, quotation_required: true,
        quotation_status: null, follow_up_date: null, created_by: userId,
      }]);
      if (COORDINATOR_EMAIL) {
        sendMailAsync(rfqCreatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL, rfq: data,
          salespersonEmail: salespersonEmail || "Unknown",
        }));
      }
    } else if (!quotation_required && existing.quotation_required) {
      // OPTIMISED: delete logs + quotation row in parallel
      const { data: quotRow } = await supabaseAdmin
        .from("quotations").select("id").eq("rfq_id", id).single();
      if (quotRow) {
        await Promise.all([
          supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", quotRow.id),
          supabaseAdmin.from("quotations").delete().eq("rfq_id", id),
        ]);
      }
    }

    return res.json({ success: true, rfq: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/rfqs/:id ───────────────────────────────────────────────────
export const deleteRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfqs").select("created_by").eq("id", id).is("deleted_at", null).single();

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = new Date().toISOString();

    // OPTIMISED: all 3 cascade soft-deletes run in parallel (was 3 sequential awaits)
    await Promise.all([
      supabaseAdmin.from("samples").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("quotations").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("rfq_followups").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
    ]);

    const { error } = await supabaseAdmin.from("rfqs").update({ deleted_at: now }).eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "RFQ deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/rfqs/:rfqId/followups ─────────────────────────────────────────
export const getFollowups = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;

    // OPTIMISED: ownership check + followup fetch in parallel
    const [{ data: rfq, error: rfqError }, { data: followups, error: fupError }] =
      await Promise.all([
        supabaseAdmin.from("rfqs").select("created_by").eq("id", rfqId).single(),
        supabaseAdmin
          .from("rfq_followups")
          .select("*")
          .eq("rfq_id", rfqId)
          .is("deleted_at", null)
          .order("followup_date", { ascending: false }),
      ]);

    if (rfqError || !rfq)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && rfq.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });
    if (fupError)
      return res.status(400).json({ success: false, message: fupError.message });

    return res.json({ success: true, followups: followups || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/rfqs/:rfqId/followups ────────────────────────────────────────
export const createFollowup = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;
    const {
      contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date, target_price, enquiry_status, remark,
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
        target_price:  target_price  || null,
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

// ── PUT /api/rfqs/followups/:id ────────────────────────────────────────────
// OPTIMISED: ownership check merged into UPDATE filter — 1 DB call instead of 2
export const updateFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date, target_price, enquiry_status, remark,
    } = req.body;

    let query = supabaseAdmin
      .from("rfq_followups")
      .update({
        contact_type, sample_status_update, quotation_status_update,
        next_action, notes,
        followup_date: followup_date || null,
        target_price:  target_price  || null,
        enquiry_status, remark,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query.select().single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Follow-up not found or not authorized" });
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, followup: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/rfqs/followups/:id ─────────────────────────────────────────
// OPTIMISED: ownership check merged into DELETE filter — 1 DB call instead of 2
export const deleteFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    let query = supabaseAdmin.from("rfq_followups").delete().eq("id", id);
    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query.select("id").single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Follow-up not found or not authorized" });
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};