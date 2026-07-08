// quotations.controller.js
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  quotationUpdatedCoordinator,
  quotationUpdatedSalesperson,
} from "../config/emailTemplates.js";
import { syncRfqStatus } from "./rfq-status-sync.js"; // ⬅ NEW

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

function syncSiblingFollowUp(rfqId, table, follow_up_date, follow_up_time) {
  if (!rfqId) return;
  supabaseAdmin
    .from(table)
    .select("id")
    .eq("rfq_id", rfqId)
    .is("deleted_at", null)
    .maybeSingle()
    .then(({ data: sibling, error }) => {
      if (error || !sibling) return;
      supabaseAdmin
        .from(table)
        .update({ follow_up_date: follow_up_date || null, follow_up_time: follow_up_time || null })
        .eq("id", sibling.id)
        .then(({ error: updErr }) => {
          if (updErr) console.error(`sync follow-up -> ${table}:`, updErr.message);
        });
    });
}

// GET /api/quotations
export const getQuotations = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("quotations")
      .select(`
        *,
        rfqs(
          id, company_name, product_category, product_sub_category,
          product_name, quotation_description, product_description,
          consumption_per_month, unit, existing_supplier_brand,
          created_by,
          leads(company_name, primary_contact_name, city, primary_phone)
        ),
        creator:users!quotations_created_by_fkey(id, email, first_name, last_name),
        updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name)
      `)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, quotations: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/quotations/:id/logs — no longer Admin-only, see samples.controller.js note
export const getQuotationLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("quotation_logs")
      .select("*, users:updated_by(id, email, first_name, last_name)")
      .eq("quotation_id", id)
      .order("updated_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/quotations/:id
export const updateQuotation = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, email: updaterEmail } = req.user;
    const { quotation_status, follow_up_date } = req.body;

    const [
      { data: current, error: fetchErr },
      { data: updated, error: updateErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("quotations")
        .select("id, rfq_id, rfqs(id, company_name, product_category, product_sub_category, product_name, quotation_description, created_by)")
        .eq("id", id)
        .single(),
      supabaseAdmin
        .from("quotations")
        .update({
          quotation_status,
          result: req.body.result || null,
          priority: req.body.priority || null,
          description:    req.body.description    || null,
          reject_reason:  req.body.reject_reason  || null,
          follow_up_time: req.body.follow_up_time || null,
          notes:          req.body.notes          || null,
          follow_up_date: follow_up_date || null,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*, creator:users!quotations_created_by_fkey(id, email, first_name, last_name), updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name)")
        .single(),
    ]);

    if (fetchErr || !current)
      return res.status(404).json({ success: false, message: "Quotation not found" });
    if (updateErr)
      return res.status(400).json({ success: false, message: updateErr.message });

    const rfq = current.rfqs || {};

    Promise.all([
      supabaseAdmin.from("quotation_logs").insert([{
        quotation_id: id,
        quotation_status,
        result: req.body.result || null,
        priority: req.body.priority || null,
        description:    req.body.description    || null,
        reject_reason:  req.body.reject_reason  || null,
        follow_up_time: req.body.follow_up_time || null,
        notes:          req.body.notes          || null,
        follow_up_date: follow_up_date || null,
        updated_by: userId,
      }]),
      rfq.created_by
        ? supabaseAdmin.from("users").select("email").eq("id", rfq.created_by).single()
        : Promise.resolve({ data: null }),
    ]).then(([, { data: spUser }]) => {
      const salespersonEmail = spUser?.email;

      if (COORDINATOR_EMAIL) {
        sendMailAsync(quotationUpdatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL,
          quotation: updated,
          rfq,
          updaterEmail: updaterEmail || COORDINATOR_EMAIL,
        }));
      }
      if (salespersonEmail) {
        sendMailAsync(quotationUpdatedSalesperson({
          salespersonEmail,
          quotation: updated,
          rfq,
        }));
      }
    }).catch((e) => console.error("Post-update tasks error:", e.message));

    // Re-derive the enquiry's next_action/status from this quotation's new
    // state (and the sample's, if any) so the enquiry-level status stays
    // in sync without a manual "resolve" step.
    const rfqId = current.rfq_id || rfq.id;
    if (rfqId) {
      syncRfqStatus(rfqId, userId).catch((e) =>
        console.error("syncRfqStatus (quotation):", e.message)
      );
      syncSiblingFollowUp(rfqId, "samples", follow_up_date, req.body.follow_up_time);
    }

    return res.json({ success: true, quotation: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const ACTIVE_QUOTATION_STATUSES_DUE = new Set([
  "Pending",
  "In Preparation",
  "Sent to Customer",
  "Under Review",
]);

// GET /api/quotations/due
export const getDueQuotations = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("quotations")
      .select(`
        *,
        rfqs(
          id, company_name, product_category, product_sub_category,
          product_name, quotation_description, product_description,
          consumption_per_month, unit, existing_supplier_brand, created_by,
          leads(company_name, primary_contact_name, city, primary_phone)
        ),
        creator:users!quotations_created_by_fkey(id, email, first_name, last_name),
        updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name)
      `)
      .is("deleted_at", null)
      .order("follow_up_date", { ascending: true, nullsFirst: false });

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, quotations: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};