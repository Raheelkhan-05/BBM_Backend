import { createClient } from "@supabase/supabase-js";

import { sendMail } from "../config/mailer.js";
import {
  sampleUpdatedCoordinator,
  sampleUpdatedSalesperson,
} from "../config/emailTemplates.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;

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
        users(id, email)
      `)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, samples: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getSampleLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("sample_logs")
      .select("*, users:updated_by(email)")
      .eq("sample_id", id)
      .order("updated_at", { ascending: false });

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateSample = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, email: updaterEmail } = req.user;
    const { sample_status, follow_up_date } = req.body;

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from("samples")
      .select(`
        *,
        rfqs(
          id, company_name, product_category, product_sub_category,
          product_name, sample_description, product_description,
          consumption_per_month, unit, existing_supplier_brand, created_by
        )
      `)
      .eq("id", id).single();

    if (fetchErr || !current)
      return res.status(404).json({ success: false, message: "Sample not found" });

    const { data, error } = await supabaseAdmin
      .from("samples")
      .update({
        sample_status,
        follow_up_date: follow_up_date || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Write log
    await supabaseAdmin.from("sample_logs").insert([{
      sample_id: id,
      sample_status,
      follow_up_date: follow_up_date || null,
      updated_by: userId,
    }]);

    // Get salesperson email
    const rfq = current.rfqs || {};
    const { data: spUser } = await supabaseAdmin
      .from("users").select("email").eq("id", rfq.created_by).single();
    const salespersonEmail = spUser?.email;

    // Send emails
    if (COORDINATOR_EMAIL) {
      sendMail(sampleUpdatedCoordinator({
        coordinatorEmail: COORDINATOR_EMAIL,
        sample: data,
        rfq,
        updaterEmail: updaterEmail || COORDINATOR_EMAIL,
      }));
    }
    if (salespersonEmail) {
      sendMail(sampleUpdatedSalesperson({
        salespersonEmail,
        sample: data,
        rfq,
      }));
    }

    return res.json({ success: true, sample: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};