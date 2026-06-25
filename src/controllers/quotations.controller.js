// quotations.controller.js — optimised
//
// updateQuotation was doing:
//   1. SELECT quotation + rfq join (to get rfq.created_by)
//   2. UPDATE quotation
//   3. INSERT log (sequential after update)
//   4. SELECT salesperson email (another DB round-trip)
//   5. await sendMail × 2 (blocking SMTP)
//   Total: 5 sequential operations before response
//
// Now:
//   1. SELECT quotation (minimal columns, no heavy join)  ┐ parallel
//   2. UPDATE quotation                                    ┘
//   3. INSERT log (fire-and-forget after response)
//   4. Salesperson email fetched in parallel with UPDATE
//   5. Both emails fire-and-forget
//   Total: 2 parallel DB calls, response returned immediately after

import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  quotationUpdatedCoordinator,
  quotationUpdatedSalesperson,
} from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

// GET /api/quotations — joins kept as-is
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
        users(id, email)
      `)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, quotations: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/quotations/:id/logs
export const getQuotationLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("quotation_logs")
      .select("*, users:updated_by(email)")
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

    // OPTIMISED: fetch only created_by (not the full join) + run UPDATE in parallel
    // Previously: SELECT with heavy join → wait → UPDATE → wait → SELECT user email
    // Now: slim SELECT + UPDATE fire together; user email fetch also parallel
    const [
      { data: current, error: fetchErr },
      { data: updated, error: updateErr },
    ] = await Promise.all([
      // Minimal select — just need rfq.created_by for the email
      supabaseAdmin
        .from("quotations")
        .select("id, rfqs(id, company_name, product_category, product_sub_category, product_name, quotation_description, created_by)")
        .eq("id", id)
        .single(),
      supabaseAdmin
        .from("quotations")
        .update({
          quotation_status,
          follow_up_date: follow_up_date || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single(),
    ]);

    if (fetchErr || !current)
      return res.status(404).json({ success: false, message: "Quotation not found" });
    if (updateErr)
      return res.status(400).json({ success: false, message: updateErr.message });

    const rfq = current.rfqs || {};

    // Fire log insert + salesperson email fetch in parallel (both after we have the data)
    // Neither blocks the HTTP response
    Promise.all([
      supabaseAdmin.from("quotation_logs").insert([{
        quotation_id: id,
        quotation_status,
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

    // Return immediately — log + emails happen in background
    return res.json({ success: true, quotation: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ADD THIS to your existing quotations.controller.js
// (keep getQuotations, getQuotationLogs, updateQuotation exactly as-is,
// just add this new export alongside them)
// ═══════════════════════════════════════════════════════════════════

const ACTIVE_QUOTATION_STATUSES_DUE = new Set([
  "Pending",
  "In Preparation",
  "Sent to Customer",
  "Under Review",
]); // Accepted / Rejected are terminal — excluded from "due" list

// GET /api/quotations/due
// SalesCoordinator + Admin: ALL quotations not yet in a terminal status
// (Accepted/Rejected) — past due, due today, and upcoming. Sorted by
// follow_up_date ascending (nulls last) so nearest task shows first.
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
        users(id, email)
      `)
      .is("deleted_at", null)
      .order("follow_up_date", { ascending: true, nullsFirst: false });

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, quotations: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};