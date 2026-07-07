// controllers/leads.controller.js
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import { leadCreatedSalesperson } from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

const nowUTC = () => new Date().toISOString();

function leadSnapshot(fields) {
  return {
    company_name:                   fields.company_name                   ?? null,
    country:                        fields.country                        ?? null,
    state:                          fields.state                          ?? null,
    city:                           fields.city                           ?? null,
    zone:                           fields.zone                           ?? null,
    route:                          fields.route                          ?? null,
    primary_contact_name:           fields.primary_contact_name           ?? null,
    primary_designation:            fields.primary_designation            ?? null,
    primary_phone:                  fields.primary_phone                  ?? null,
    primary_email:                  fields.primary_email                  ?? null,
    secondary_contact_name:         fields.secondary_contact_name         ?? null,
    secondary_designation:          fields.secondary_designation          ?? null,
    secondary_phone:                fields.secondary_phone                ?? null,
    secondary_email:                fields.secondary_email                ?? null,
    nature_of_business:             fields.nature_of_business             ?? null,
    manufacturing_industry:         fields.manufacturing_industry         ?? null,
    company_website:                fields.company_website                ?? null,
    gst_number:                     fields.gst_number                     ?? null,
    linkedin_profile:               fields.linkedin_profile               ?? null,
    potential_product_category:     fields.potential_product_category     ?? null,
    potential_product_sub_category: fields.potential_product_sub_category ?? null,
    potential_product_name:         fields.potential_product_name         ?? null,
    // NEW — prospect-stage fields, now on leads itself; previously dropped
    // entirely from the audit trail.
    source:            fields.source            ?? null,
    next_action:        fields.next_action        ?? null,
    next_action_date:   fields.next_action_date   ?? null,
    feedback:           fields.feedback           ?? null,
    status:             fields.status             ?? null,
  };
}

function logLead(leadId, action, changedBy, snapshot = {}) {
  supabaseAdmin
    .from("lead_logs")
    .insert([{
      lead_id:    leadId,
      action,
      changed_by: changedBy,
      changed_at: nowUTC(),
      ...snapshot,
    }])
    .then(({ error }) => {
      if (error) console.error("lead_logs write error:", error.message);
    });
}

function extractLeadFields(body) {
  const {
    company_name, country, state, city, zone, route,
    primary_contact_name, primary_designation, primary_phone, primary_email,
    secondary_contact_name, secondary_designation, secondary_phone, secondary_email,
    nature_of_business, manufacturing_industry, company_website, gst_number, linkedin_profile,
    potential_product_category, potential_product_sub_category, potential_product_name,
    source, next_action, next_action_date, feedback, status,
  } = body;
  return {
    company_name,
    country: country || "India",
    state: state || null, city: city || null, zone: zone || null, route: route || null,
    primary_contact_name: primary_contact_name || null,
    primary_designation:  primary_designation  || null,
    primary_phone:        primary_phone        || null,
    primary_email:        primary_email        || null,
    secondary_contact_name: secondary_contact_name || null,
    secondary_designation:  secondary_designation  || null,
    secondary_phone:        secondary_phone        || null,
    secondary_email:        secondary_email        || null,
    nature_of_business:      nature_of_business      || null,
    manufacturing_industry:  nature_of_business === "Manufacturer" ? (manufacturing_industry || null) : null,
    company_website:  company_website  || null,
    gst_number:       gst_number       || null,
    linkedin_profile: linkedin_profile || null,
    potential_product_category:     potential_product_category     || null,
    potential_product_sub_category: potential_product_sub_category || null,
    potential_product_name:         potential_product_name         || null,
    source:            source            || null,
    next_action:        next_action        || null,
    next_action_date:   next_action_date   || null,
    feedback:           feedback           || null,
    status:             status             || "Active",
  };
}

const WITH_CREATOR_UPDATER =
  "*, creator:users!leads_created_by_fkey(id, email, first_name, last_name, role), " +
  "updater:users!leads_updated_by_fkey(id, email, first_name, last_name)";

// ── GET /api/leads ──────────────────────────────────────────────────────
// TEAM VISIBILITY: everyone sees every lead (single team today). Mine vs
// Team is a client-side split using created_by/updated_by against the
// logged-in user's id.
export const getLeads = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("leads")
      .select(WITH_CREATOR_UPDATER)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, leads: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createLead = async (req, res) => {
  try {
    const { id: userId, email: salespersonEmail } = req.user;
    const fields = extractLeadFields(req.body);
    if (!fields.company_name?.trim())
      return res.status(400).json({ success: false, message: "Company name is required" });

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([{
        ...fields,
        company_name: fields.company_name.trim(),
        created_by: userId,
        updated_by: userId,
      }])
      .select(WITH_CREATOR_UPDATER)
      .single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logLead(data.id, "created", userId, leadSnapshot({ ...fields, company_name: fields.company_name.trim() }));
    if (salespersonEmail) sendMailAsync(leadCreatedSalesperson({ salespersonEmail, lead: data }));
    return res.status(201).json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const fields = extractLeadFields(req.body);
    if (!fields.company_name?.trim())
      return res.status(400).json({ success: false, message: "Company name is required" });

    // Team model: any team member can update; created_by/updated_by track
    // who did what rather than gating who's allowed to.
    const { data, error } = await supabaseAdmin
      .from("leads")
      .update({
        ...fields,
        company_name: fields.company_name.trim(),
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id)
      .is("deleted_at", null)
      .select(WITH_CREATOR_UPDATER)
      .single();
    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Lead not found" });
      return res.status(400).json({ success: false, message: error.message });
    }

    logLead(id, "updated", userId, leadSnapshot({ ...fields, company_name: fields.company_name.trim() }));
    return res.json({ success: true, lead: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const ownerQuery = supabaseAdmin
      .from("leads")
      .select("created_by, company_name, country, state, city, zone, route, primary_contact_name, primary_email, nature_of_business, potential_product_name")
      .eq("id", id)
      .is("deleted_at", null)
      .single();

    const rfqQuery = supabaseAdmin
      .from("rfqs")
      .select("id")
      .eq("lead_id", id)
      .is("deleted_at", null);

    const [{ data: existing, error: fetchError }, { data: rfqs }] =
      await Promise.all([ownerQuery, rfqQuery]);

    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "Lead not found" });
    // Deletion stays restricted (creator or Admin) even though edits are team-wide.
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = nowUTC();
    if (rfqs?.length) {
      const rfqIds = rfqs.map((r) => r.id);
      await Promise.all([
        supabaseAdmin.from("samples").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("quotations").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("rfq_followups").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        // Deleting a lead takes its enquiries with it — and any order that
        // came out of one of those enquiries needs to stop showing under
        // the Orders tab too. Soft-delete keeps the audit history intact;
        // the DB-level ON DELETE CASCADE (orders_cascade_fix.sql) only
        // kicks in for a hard purge, not this soft delete.
        supabaseAdmin.from("orders").update({ deleted_at: now }).in("rfq_id", rfqIds).is("deleted_at", null),
        supabaseAdmin.from("rfqs").update({ deleted_at: now }).in("id", rfqIds).is("deleted_at", null),
      ]);
    }

    const { error } = await supabaseAdmin.from("leads").update({ deleted_at: now, updated_by: userId }).eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    logLead(id, "deleted", userId, leadSnapshot(existing));
    return res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getLeadLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("lead_logs")
      .select("*, changer:users!lead_logs_changed_by_fkey(id, email, first_name, last_name)")
      .eq("lead_id", id)
      .order("changed_at", { ascending: true }); // ascending — diffed oldest→newest below
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};