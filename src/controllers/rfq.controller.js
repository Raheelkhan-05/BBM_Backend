// controllers/rfq.controller.js
// Logs EVERY mutation: rfqs, rfq_followups, samples, quotations all get audit rows.

import { sendMail } from "../config/mailer.js";
import { rfqCreatedSalesperson, rfqCreatedCoordinator } from "../config/emailTemplates.js";
import { createClient } from "@supabase/supabase-js";
import { deriveNextAction } from "./followup-helpers.js";

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;
const nowUTC = () => new Date().toISOString();
const sendMailAsync = (opts) => sendMail(opts).catch((e) => console.error("Mail error:", e.message));

async function getSalespersonEmail(userId) {
  const { data } = await supabaseAdmin.from("users").select("email").eq("id", userId).single();
  return data?.email || null;
}

// ── fire-and-forget log helpers ────────────────────────────────────────────
function logRFQ(rfqId, action, changedBy, snapshot = {}) {
  supabaseAdmin.from("rfq_logs")
    .insert([{ rfq_id: rfqId, action, changed_by: changedBy, changed_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("rfq_logs:", error.message); });
}

function logFollowup(followupId, action, changedBy, snapshot = {}) {
  supabaseAdmin.from("rfq_followup_logs")
    .insert([{ followup_id: followupId, action, changed_by: changedBy, changed_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("rfq_followup_logs:", error.message); });
}

function logSample(sampleId, action, updatedBy, snapshot = {}) {
  supabaseAdmin.from("sample_logs")
    .insert([{ sample_id: sampleId, updated_by: updatedBy, updated_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("sample_logs:", error.message); });
}

function logQuotation(quotationId, action, updatedBy, snapshot = {}) {
  supabaseAdmin.from("quotation_logs")
    .insert([{ quotation_id: quotationId, updated_by: updatedBy, updated_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("quotation_logs:", error.message); });
}

// ── snapshot builders ───────────────────────────────────────────────────────
function rfqSnapshot(f) {
  return {
    product_category:              f.product_category              ?? null,
    product_sub_category:          f.product_sub_category          ?? null,
    product_name:                  f.product_name                  ?? null,
    product_description:           f.product_description           ?? null,
    consumption_per_month:         f.consumption_per_month         || null,
    unit:                          f.unit                          ?? null,
    sample_required:               f.sample_required               ?? false,
    sample_description:            f.sample_description            ?? null,
    sample_received_from_customer: f.sample_received_from_customer ?? false,
    quotation_required:            f.quotation_required            ?? false,
    quotation_description:         f.quotation_description         ?? null,
    existing_supplier_brand:       f.existing_supplier_brand       ?? null,
    notes:                         f.notes                         || null,
    target_price:                  f.target_price                  || null,
    tds_available:                 f.tds_available                 ?? false,
  };
}

function followupSnapshot(f) {
  return {
    contact_type:            f.contact_type            ?? null,
    sample_status_update:    f.sample_status_update    ?? null,
    quotation_status_update: f.quotation_status_update ?? null,
    next_action:             f.next_action             ?? null,
    notes:                   f.notes                   ?? null,
    followup_date:           f.followup_date           || null,
    target_price:            f.target_price            || null,
    enquiry_status:          f.enquiry_status          ?? null,
    remark:                  f.remark                  ?? null,
  };
}

// ── GET /api/rfqs ──────────────────────────────────────────────────────────
export const getRFQs = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    let query = supabaseAdmin.from("rfqs").select(`
      *, leads(id, company_name, primary_contact_name, primary_phone, primary_email, city, country, state),
      users(id, email, role), rfq_followups(*),
      samples(id, sample_code, sample_status, result, priority, notes, description, reject_reason, follow_up_date, follow_up_time, updated_at),
      quotations(id, quotation_code, quotation_status, result, priority, notes, description, reject_reason, follow_up_date, follow_up_time, updated_at)
    `).is("deleted_at", null).order("created_at", { ascending: false });
    if (role === "Admin" || role === "SalesCoordinator") {
      // no filter — SC needs all RFQs across all salespersons
    } else {
      query = query.eq("created_by", userId);
    }
    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, rfqs: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── GET /api/rfqs/leads ────────────────────────────────────────────────────
export const getLeadsForRFQ = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    let query = supabaseAdmin.from("leads")
      .select("id, company_name, primary_contact_name, city, state, country, zone, route, nature_of_business, potential_product_name, potential_product_category, potential_product_sub_category")
      .is("deleted_at", null).order("company_name", { ascending: true });
    if (role !== "Admin") query = query.eq("created_by", userId);
    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, leads: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── POST /api/rfqs ─────────────────────────────────────────────────────────
export const createRFQ = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const {
      lead_id, company_name, product_category, product_sub_category, product_name,
      product_description, consumption_per_month, unit, sample_required, sample_description,
      sample_received_from_customer, quotation_required, quotation_description,
      existing_supplier_brand, notes, target_price, tds_available,
    } = req.body;

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

    const { data, error } = await supabaseAdmin.from("rfqs").insert([{
      lead_id, company_name, product_category, product_sub_category, product_name,
      product_description, consumption_per_month: consumption_per_month || null, unit,
      sample_required: sample_required ?? false, sample_description,
      sample_received_from_customer: sample_received_from_customer ?? false,
      quotation_required: quotation_required ?? false, quotation_description,
      existing_supplier_brand, notes: notes || null, target_price: target_price || null,
      tds_available: tds_available ?? false, created_by: userId,
    }]).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logRFQ(data.id, "created", userId, rfqSnapshot(req.body));

    // Sample + quotation creates — WITH logs
    const sideInserts = [];
    if (sample_required) {
      sideInserts.push(
        supabaseAdmin.from("samples").insert([{
          rfq_id: data.id, sample_required: true,
          sample_status: null, follow_up_date: null, created_by: userId,
        }]).select().single().then(({ data: s }) => {
          if (s) logSample(s.id, "created", userId, { sample_status: null, follow_up_date: null });
        })
      );
    }
    if (quotation_required) {
      sideInserts.push(
        supabaseAdmin.from("quotations").insert([{
          rfq_id: data.id, quotation_required: true,
          quotation_status: null, follow_up_date: null, created_by: userId,
        }]).select().single().then(({ data: q }) => {
          if (q) logQuotation(q.id, "created", userId, { quotation_status: null, follow_up_date: null });
        })
      );
    }
    if (sideInserts.length) await Promise.all(sideInserts);

    if (salespersonEmail) sendMailAsync(rfqCreatedSalesperson({ salespersonEmail, rfq: data }));
    if (COORDINATOR_EMAIL && (sample_required || quotation_required)) {
      sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
    }

    return res.status(201).json({ success: true, rfq: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── PUT /api/rfqs/:id ──────────────────────────────────────────────────────
export const updateRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      lead_id, company_name, product_category, product_sub_category, product_name,
      product_description, consumption_per_month, unit, sample_required, sample_description,
      sample_received_from_customer, quotation_required, quotation_description,
      existing_supplier_brand, notes, target_price, tds_available,
    } = req.body;

    const { data: existing, error: fetchError } = await supabaseAdmin.from("rfqs")
      .select("created_by, sample_required, quotation_required").eq("id", id).single();
    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const [{ data, error }, salespersonEmail] = await Promise.all([
      supabaseAdmin.from("rfqs").update({
        lead_id, company_name, product_category, product_sub_category, product_name,
        product_description, consumption_per_month: consumption_per_month || null, unit,
        sample_required: sample_required ?? false, sample_description,
        sample_received_from_customer: sample_received_from_customer ?? false,
        quotation_required: quotation_required ?? false, quotation_description,
        existing_supplier_brand, notes: notes || null, target_price: target_price || null,
        tds_available: tds_available ?? false, updated_at: nowUTC(),
      }).eq("id", id).select().single(),
      getSalespersonEmail(existing.created_by),
    ]);

    if (error) return res.status(400).json({ success: false, message: error.message });
    logRFQ(id, "updated", userId, rfqSnapshot(req.body));

    // Sample toggle
    if (sample_required && !existing.sample_required) {
      supabaseAdmin.from("samples").insert([{
        rfq_id: id, sample_required: true, sample_status: null, follow_up_date: null, created_by: userId,
      }]).select().single().then(({ data: s }) => {
        if (s) logSample(s.id, "created", userId, { sample_status: null, follow_up_date: null });
      });
      if (COORDINATOR_EMAIL) sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
    } else if (!sample_required && existing.sample_required) {
      const { data: sRow } = await supabaseAdmin.from("samples").select("id").eq("rfq_id", id).single();
      if (sRow) {
        logSample(sRow.id, "deleted", userId, { sample_status: null, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("sample_logs").delete().eq("sample_id", sRow.id),
          supabaseAdmin.from("samples").delete().eq("rfq_id", id),
        ]);
      }
    }

    // Quotation toggle
    if (quotation_required && !existing.quotation_required) {
      supabaseAdmin.from("quotations").insert([{
        rfq_id: id, quotation_required: true, quotation_status: null, follow_up_date: null, created_by: userId,
      }]).select().single().then(({ data: q }) => {
        if (q) logQuotation(q.id, "created", userId, { quotation_status: null, follow_up_date: null });
      });
      if (COORDINATOR_EMAIL) sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
    } else if (!quotation_required && existing.quotation_required) {
      const { data: qRow } = await supabaseAdmin.from("quotations").select("id").eq("rfq_id", id).single();
      if (qRow) {
        logQuotation(qRow.id, "deleted", userId, { quotation_status: null, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", qRow.id),
          supabaseAdmin.from("quotations").delete().eq("rfq_id", id),
        ]);
      }
    }

    return res.json({ success: true, rfq: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── DELETE /api/rfqs/:id ───────────────────────────────────────────────────
export const deleteRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const { data: existing, error: fetchError } = await supabaseAdmin.from("rfqs")
      .select("created_by").eq("id", id).is("deleted_at", null).single();
    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = nowUTC();

    // Log sample + quotation deletions before soft-delete
    const [{ data: samplesArr }, { data: quotsArr }] = await Promise.all([
      supabaseAdmin.from("samples").select("id, sample_status").eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("quotations").select("id, quotation_status").eq("rfq_id", id).is("deleted_at", null),
    ]);
    (samplesArr || []).forEach(s => logSample(s.id, "deleted", userId, { sample_status: s.sample_status, follow_up_date: null }));
    (quotsArr  || []).forEach(q => logQuotation(q.id, "deleted", userId, { quotation_status: q.quotation_status, follow_up_date: null }));

    await Promise.all([
      supabaseAdmin.from("samples").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("quotations").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("rfq_followups").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
    ]);

    const { error } = await supabaseAdmin.from("rfqs").update({ deleted_at: now }).eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRFQ(id, "deleted", userId);
    return res.json({ success: true, message: "RFQ deleted" });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── GET /api/rfqs/:rfqId/followups ─────────────────────────────────────────
export const getFollowups = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;
    const [{ data: rfq, error: rfqError }, { data: followups, error: fupError }] = await Promise.all([
      supabaseAdmin.from("rfqs").select("created_by").eq("id", rfqId).single(),
      supabaseAdmin.from("rfq_followups").select("*").eq("rfq_id", rfqId).is("deleted_at", null).order("followup_date", { ascending: false }),
    ]);
    if (rfqError || !rfq) return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && rfq.created_by !== userId) return res.status(403).json({ success: false, message: "Not authorized" });
    if (fupError) return res.status(400).json({ success: false, message: fupError.message });
    return res.json({ success: true, followups: followups || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── POST /api/rfqs/:rfqId/followups ────────────────────────────────────────
export const createFollowup = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId, role } = req.user;
    const { contact_type, sample_status_update, quotation_status_update, next_action, notes, followup_date, target_price, enquiry_status, remark } = req.body;

    const { data: rfq, error: rfqError } = await supabaseAdmin.from("rfqs").select("created_by").eq("id", rfqId).single();
    if (rfqError || !rfq) return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && rfq.created_by !== userId) return res.status(403).json({ success: false, message: "Not authorized" });

    const { data, error } = await supabaseAdmin.from("rfq_followups").insert([{
      rfq_id: rfqId, contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date: followup_date || null,
      target_price: target_price || null, enquiry_status, remark, created_by: userId,
    }]).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });
    logFollowup(data.id, "created", userId, followupSnapshot(req.body));
    return res.status(201).json({ success: true, followup: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── PUT /api/rfqs/followups/:id ────────────────────────────────────────────
export const updateFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const { contact_type, sample_status_update, quotation_status_update, next_action, notes, followup_date, target_price, enquiry_status, remark } = req.body;

    let query = supabaseAdmin.from("rfq_followups").update({
      contact_type, sample_status_update, quotation_status_update, next_action, notes,
      followup_date: followup_date || null, target_price: target_price || null,
      enquiry_status, remark, updated_at: nowUTC(),
    }).eq("id", id);
    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query.select().single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Follow-up not found or not authorized" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logFollowup(id, "updated", userId, followupSnapshot(req.body));
    return res.json({ success: true, followup: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── DELETE /api/rfqs/followups/:id ─────────────────────────────────────────
export const deleteFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    let query = supabaseAdmin.from("rfq_followups").delete().eq("id", id);
    if (role !== "Admin") query = query.eq("created_by", userId);

    const { data, error } = await query.select("id").single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Follow-up not found or not authorized" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logFollowup(id, "deleted", userId);
    return res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── Samples controller (separate routes) ──────────────────────────────────
// PUT /api/samples/:id
export const updateSample = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      sample_status, follow_up_date, follow_up_time,
      result, priority, notes, description, reject_reason,
    } = req.body;

    let query = supabaseAdmin.from("samples")
      .update({
        sample_status,
        follow_up_date:  follow_up_date  || null,
        follow_up_time:  follow_up_time  || null,
        result:          result          || null,
        priority:        priority        || null,
        notes:           notes           || null,
        description:     description     || null,
        reject_reason:   reject_reason   || null,
        updated_at:      nowUTC(),
      })
      .eq("id", id);
    if (role !== "Admin" && role !== "SalesCoordinator") query = query.eq("created_by", userId);

    const { data, error } = await query.select().single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Sample not found" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logSample(id, "updated", userId, {
      sample_status,
      follow_up_date:  follow_up_date  || null,
      follow_up_time:  follow_up_time  || null,
      result:          result          || null,
      priority:        priority        || null,
      notes:           notes           || null,
      description:     description     || null,
      reject_reason:   reject_reason   || null,
    });
    return res.json({ success: true, sample: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// PUT /api/quotations/:id
export const updateQuotation = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const {
      quotation_status, follow_up_date, follow_up_time,
      result, priority, notes, description, reject_reason,
    } = req.body;

    let query = supabaseAdmin.from("quotations")
      .update({
        quotation_status,
        follow_up_date:  follow_up_date  || null,
        follow_up_time:  follow_up_time  || null,
        result:          result          || null,
        priority:        priority        || null,
        notes:           notes           || null,
        description:     description     || null,
        reject_reason:   reject_reason   || null,
        updated_at:      nowUTC(),
      })
      .eq("id", id);
    if (role !== "Admin" && role !== "SalesCoordinator") query = query.eq("created_by", userId);

    const { data, error } = await query.select().single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Quotation not found" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logQuotation(id, "updated", userId, {
      quotation_status,
      follow_up_date:  follow_up_date  || null,
      follow_up_time:  follow_up_time  || null,
      result:          result          || null,
      priority:        priority        || null,
      notes:           notes           || null,
      description:     description     || null,
      reject_reason:   reject_reason   || null,
    });
    return res.json({ success: true, quotation: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

const CLOSED_STATUSES = new Set(["Won", "Lost"]);
const CLOSED_ACTIONS  = new Set(["Close Enquiry", "No Further Action"]);
 
function isEnquiryClosedServer(followups) {
  const active = (followups || []).filter((f) => !f.deleted_at);
  if (!active.length) return false;
  const latest = [...active].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  )[0];
  return CLOSED_STATUSES.has(latest.enquiry_status) || CLOSED_ACTIONS.has(latest.next_action);
}
 
// ─────────────────────────────────────────────────────────────────────
// GET /api/rfqs/followups/due
// Salesperson: only their own rfqs (rfqs.created_by = me).
// Admin: everyone's.
// Returns ALL open enquiries (not closed: Won/Lost/Close Enquiry/No
// Further Action) that have at least one followup with a date — past,
// today, or future. Sorting/grouping (overdue first, completed last)
// is handled client-side so the list can re-sort instantly as tasks
// get resolved without a refetch.
// ─────────────────────────────────────────────────────────────────────
export const getDueFollowups = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
 
    let query = supabaseAdmin
      .from("rfqs")
      .select(`
        id, lead_id, company_name, product_category, product_sub_category,
        product_name, consumption_per_month, unit, target_price,
        sample_required, quotation_required, created_by,
        leads(company_name, primary_contact_name, primary_phone, primary_email, city, state),
        rfq_followups(
          id, contact_type, next_action, notes, followup_date,
          target_price, enquiry_status, remark, created_at, deleted_at
        )
      `)
      .is("deleted_at", null);
 
    if (role !== "Admin") query = query.eq("created_by", userId);
 
    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
 
    const due = (data || [])
      .map((rfq) => {
        const fups = (rfq.rfq_followups || []).filter((f) => !f.deleted_at);
        if (!fups.length) return null;
        const latest = [...fups].sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
        )[0];
        if (!latest.followup_date) return null;
        // if (isEnquiryClosedServer(fups)) return null; // closed — handled by separate "completed" logic client-side if ever needed
        return { ...rfq, latest_followup: latest, rfq_followups: undefined };
      })
      .filter(Boolean)
      .sort((a, b) => a.latest_followup.followup_date.localeCompare(b.latest_followup.followup_date));
 
    return res.json({ success: true, tasks: due });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
 
// ─────────────────────────────────────────────────────────────────────
// POST /api/rfqs/:id/followups/resolve
// Body: { outcome: "Won" | "Lost" | "Next", contact_type, remark,
//         next_followup_date, next_followup_time, manual_next_action }
//
// - Won/Lost: writes a single followup row closing the enquiry.
// - Next: writes a followup row with enquiry_status carried forward
//   (kept "Open"/"In Progress" — not closed), next_action auto-derived
//   from latest sample/quotation status (or manual_next_action if the
//   rfq has neither sample nor quotation attached).
// ─────────────────────────────────────────────────────────────────────
export const resolveFollowup = async (req, res) => {
  try {
    const { id } = req.params; // rfq id
    const { id: userId } = req.user;
    const {
      outcome,               // "Won" | "Lost" | "Next"
      contact_type,
      remark,
      next_followup_date,
      next_followup_time,
      manual_next_action,
    } = req.body;
 
    if (!["Won", "Lost", "Next"].includes(outcome)) {
      return res.status(400).json({ success: false, message: "Invalid outcome" });
    }
    if (!contact_type) {
      return res.status(400).json({ success: false, message: "contact_type is required" });
    }
 
    // Fetch rfq + latest sample + latest quotation for next-action derivation
    const [{ data: rfq, error: rfqErr }, { data: sampleRows }, { data: quoteRows }] = await Promise.all([
      supabaseAdmin
        .from("rfqs")
        .select("id, sample_required, quotation_required")
        .eq("id", id)
        .single(),
      supabaseAdmin
        .from("samples")
        .select("sample_status, updated_at")
        .eq("rfq_id", id)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("quotations")
        .select("quotation_status, updated_at")
        .eq("rfq_id", id)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(1),
    ]);
 
    if (rfqErr || !rfq) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }
 
    let payload;
    if (outcome === "Won" || outcome === "Lost") {
      payload = {
        rfq_id: id,
        contact_type,
        enquiry_status: outcome,
        next_action: null,
        remark: remark || null,
        followup_date: new Date().toISOString().slice(0, 10),
        created_by: userId,
      };
    } else {
      if (!next_followup_date) {
        return res.status(400).json({ success: false, message: "next_followup_date is required" });
      }
      const derived = deriveNextAction(rfq, sampleRows?.[0] || null, quoteRows?.[0] || null);
      payload = {
        rfq_id: id,
        contact_type,
        enquiry_status: "In Progress",
        next_action: manual_next_action || derived || null,
        remark: remark || null,
        followup_date: next_followup_date,
        notes: next_followup_time ? `[Time: ${next_followup_time}]` : null,
        created_by: userId,
      };
    }
 
    const { data: followup, error: insertErr } = await supabaseAdmin
      .from("rfq_followups")
      .insert([payload])
      .select()
      .single();
 
    if (insertErr) {
      return res.status(400).json({ success: false, message: insertErr.message });
    }
 
    return res.json({ success: true, followup });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};