// samples.controller.js
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  sampleUpdatedCoordinator,
  sampleUpdatedSalesperson,
} from "../config/emailTemplates.js";
import { syncRfqStatus } from "./rfq-status-sync.js"; // ⬅ NEW

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

// GET /api/samples
export const getSamples = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("samples")
      .select(`
        *,
        rfqs(
          id, company_name, product_category, product_sub_category,
          product_name, sample_description, product_description,
          consumption_per_month, unit, existing_supplier_brand,
          created_by,
          leads(company_name, primary_contact_name, city, primary_phone)
        ),
        creator:users!samples_created_by_fkey(id, email, first_name, last_name),
        updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)
      `)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, samples: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/samples/:id/logs
// No longer Admin-only — every team member updating the same record needs
// to see who did what before them.
export const getSampleLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("sample_logs")
      .select("*, users:updated_by(id, email, first_name, last_name)")
      .eq("sample_id", id)
      .order("updated_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/samples/:id
export const updateSample = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, email: updaterEmail } = req.user;
    const { sample_status, follow_up_date } = req.body;

    const [
      { data: current, error: fetchErr },
      { data: updated, error: updateErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("samples")
        .select("id, rfq_id, rfqs(id, company_name, product_category, product_sub_category, product_name, sample_description, created_by)")
        .eq("id", id)
        .single(),
      supabaseAdmin
        .from("samples")
        .update({
          sample_status,
          result: req.body.result || null,
          priority: req.body.priority || null,
          follow_up_date: follow_up_date || null,
          description:    req.body.description    || null,
          reject_reason:  req.body.reject_reason  || null,
          follow_up_time: req.body.follow_up_time || null,
          notes:          req.body.notes          || null,
          updated_by: userId, // whoever on the team makes this update becomes the new "last updated by"
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*, creator:users!samples_created_by_fkey(id, email, first_name, last_name), updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)")
        .single(),
    ]);

    if (fetchErr || !current)
      return res.status(404).json({ success: false, message: "Sample not found" });
    if (updateErr)
      return res.status(400).json({ success: false, message: updateErr.message });

    const rfq = current.rfqs || {};

    Promise.all([
      supabaseAdmin.from("sample_logs").insert([{
        sample_id: id,
        sample_status,
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
        sendMailAsync(sampleUpdatedCoordinator({
          coordinatorEmail: COORDINATOR_EMAIL,
          sample: updated,
          rfq,
          updaterEmail: updaterEmail || COORDINATOR_EMAIL,
        }));
      }
      if (salespersonEmail) {
        sendMailAsync(sampleUpdatedSalesperson({
          salespersonEmail,
          sample: updated,
          rfq,
        }));
      }
    }).catch((e) => console.error("Post-update tasks error:", e.message));

    // Re-derive the enquiry's next_action/status from this sample's new
    // state (and the quotation's, if any) so the enquiry-level status
    // stays in sync without a manual "resolve" step.
    const rfqId = current.rfq_id || rfq.id;
    if (rfqId) {
      syncRfqStatus(rfqId, userId).catch((e) =>
        console.error("syncRfqStatus (sample):", e.message)
      );
    }

    return res.json({ success: true, sample: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const ACTIVE_SAMPLE_STATUSES_DUE = new Set([
  "Pending",
  "Sent to Customer",
  "Received from Customer",
]);

// GET /api/samples/due
export const getDueSamples = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("samples")
      .select(`
        *,
        rfqs(
          id, company_name, product_category, product_sub_category,
          product_name, sample_description, product_description,
          consumption_per_month, unit, existing_supplier_brand, created_by,
          leads(company_name, primary_contact_name, city, primary_phone)
        ),
        creator:users!samples_created_by_fkey(id, email, first_name, last_name),
        updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)
      `)
      .is("deleted_at", null)
      .order("follow_up_date", { ascending: true, nullsFirst: false });

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, samples: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};