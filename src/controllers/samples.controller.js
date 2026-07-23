// samples.controller.js
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  sampleUpdatedCoordinator,
  sampleUpdatedSalesperson,
} from "../config/emailTemplates.js";
import { syncRfqStatus } from "./rfq-status-sync.js"; // ⬅ NEW

import { SAMPLE_STAGES, REJECTED_STAGE } from "../constants/stages.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

// add near the top, after sendMailAsync
const SIBLING_STATUS_COL = { samples: "sample_status", quotations: "quotation_status" };
const CLOSED = new Set(["Approved", REJECTED_STAGE]);

function syncSiblingFields(rfqId, table, fields) {
  if (!rfqId) return;
  const statusCol = SIBLING_STATUS_COL[table];
  supabaseAdmin
    .from(table)
    .select(`id, ${statusCol}`)
    .eq("rfq_id", rfqId)
    .is("deleted_at", null)
    .maybeSingle()
    .then(({ data: sibling, error }) => {
      if (error || !sibling) return;
      // If the sibling itself is already Approved/Rejected, don't push a
      // date/time onto it — it doesn't need a follow-up anymore. Priority
      // and notes still sync regardless, since those stay common either way.
      const siblingClosed = CLOSED.has(sibling[statusCol]);
      const patch = siblingClosed
        ? { priority: fields.priority, notes: fields.notes }
        : fields;
      supabaseAdmin
        .from(table)
        .update(patch)
        .eq("id", sibling.id)
        .then(({ error: updErr }) => {
          if (updErr) console.error(`sync -> ${table}:`, updErr.message);
        });
    });
}

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
          created_by, updated_by,
          creator:users!rfqs_created_by_fkey(id, email, first_name, last_name),
          updater:users!rfqs_updated_by_fkey(id, email, first_name, last_name),
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

    const CLOSED_STAGES = new Set(["Approved", REJECTED_STAGE]);
    if (!CLOSED_STAGES.has(sample_status) && !follow_up_date) {
      return res.status(400).json({ success: false, message: "Follow-up date is required until Approved/Rejected" });
    }

    const derivedResult = CLOSED_STAGES.has(sample_status) ? sample_status : null;

    const [
      { data: current, error: fetchErr },
      { data: updated, error: updateErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("samples")
        .select("id, rfq_id, sample_status, rfqs(id, company_name, product_category, product_sub_category, product_name, sample_description, created_by)")
        .eq("id", id)
        .single(),
      supabaseAdmin
        .from("samples")
        .update({
          sample_status,
          result: derivedResult,
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
    
    
    const curIdx    = SAMPLE_STAGES.indexOf(current.sample_status);
    const targetIdx = SAMPLE_STAGES.indexOf(sample_status);

    if (sample_status !== REJECTED_STAGE) {
      if (targetIdx !== -1 && curIdx !== -1 && targetIdx < curIdx) {
        return res.status(400).json({ success: false, message: "Cannot move to an earlier stage" });
      }
      if (targetIdx > curIdx + 1) {
        const skipped = [];
        for (let i = curIdx + 1; i < targetIdx; i++) {
          skipped.push({
            sample_id: id,
            sample_status: SAMPLE_STAGES[i],
            notes: "Auto-completed (stage skipped)",
            updated_by: userId,
          });
        }
        if (skipped.length) await supabaseAdmin.from("sample_logs").insert(skipped);
      }
    }

    const rfq = current.rfqs || {};

    Promise.all([
      supabaseAdmin.from("sample_logs").insert([{
        sample_id: id,
        sample_status,
        result: derivedResult,
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
      // Sample updates are enquiry-level activity too — without this, rfqs.updated_by
      // stays stale (still showing whoever last touched the rfqs row directly),
      // even though a sample stage change is clearly the most recent thing that
      // happened on this enquiry.
      supabaseAdmin.from("rfqs")
        .update({ updated_by: userId, updated_at: new Date().toISOString() })
        .eq("id", rfqId)
        .then(({ error: e }) => { if (e) console.error("rfqs.updated_by (via sample):", e.message); });

      syncSiblingFields(rfqId, "quotations", {
        follow_up_date: follow_up_date || null,
        follow_up_time: req.body.follow_up_time || null,
        priority:       req.body.priority || null,
        notes:          req.body.notes || null,
      });
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
          consumption_per_month, unit, existing_supplier_brand,
          created_by, updated_by,
          creator:users!rfqs_created_by_fkey(id, email, first_name, last_name),
          updater:users!rfqs_updated_by_fkey(id, email, first_name, last_name),
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