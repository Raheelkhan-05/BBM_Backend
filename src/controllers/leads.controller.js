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

// GET /api/leads
export const getLeads = async (req, res) => {
  try {
    const { id: userId, role } = req.user;

    let query = supabaseAdmin
      .from("leads")
      .select("*, users(id, email, role)")
      .order("created_at", { ascending: false });

    if (role !== "Admin") {
      query = query.eq("created_by", userId);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.json({
      success: true,
      leads: data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// POST /api/leads
export const createLead = async (req, res) => {
  try {
    const { id: userId, email: salespersonEmail } = req.user;

    const {
      company_name,
      city,
      zone,
      route,
      mobile_number,
      contact_name,
      nature_of_business,
      manufacturing_industry,
      email,
      designation,
      alternate_mobile_number,
      whatsapp_same_as_mobile,
      whatsapp_number,
      company_website,
    } = req.body;

    if (!company_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([
        {
          company_name: company_name.trim(),
          city,
          zone,
          route,
          mobile_number,
          contact_name,
          nature_of_business,
          manufacturing_industry,
          email,
          designation,
          alternate_mobile_number,
          whatsapp_same_as_mobile: whatsapp_same_as_mobile ?? false,
          whatsapp_number: whatsapp_same_as_mobile
            ? mobile_number
            : whatsapp_number,
          company_website,
          created_by: userId,
        },
      ])
      .select()
      .single();

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    // Acknowledgement to the salesperson who created the lead
    if (salespersonEmail) {
      sendMail(leadCreatedSalesperson({
        salespersonEmail,
        lead: data,
      }));
    }

    // Welcome mail to the customer, only if an email was captured
    if (data.email) {
      sendMail(leadWelcomeCustomer({
        customerEmail: data.email,
        lead: data,
      }));
    }

    return res.status(201).json({
      success: true,
      lead: data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// PUT /api/leads/:id
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;

    const {
      company_name,
      city,
      zone,
      route,
      mobile_number,
      contact_name,
      nature_of_business,
      manufacturing_industry,
      email,
      designation,
      alternate_mobile_number,
      whatsapp_same_as_mobile,
      whatsapp_number,
      company_website,
    } = req.body;

    if (!company_name?.trim()) {
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
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (role !== "Admin" && existing.created_by !== userId) {
      return res.status(403).json({
        success: false,
        message: "Not authorized",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("leads")
      .update({
        company_name: company_name.trim(),
        city,
        zone,
        route,
        mobile_number,
        contact_name,
        nature_of_business,
        manufacturing_industry,
        email,
        designation,
        alternate_mobile_number,
        whatsapp_same_as_mobile: whatsapp_same_as_mobile ?? false,
        whatsapp_number: whatsapp_same_as_mobile
          ? mobile_number
          : whatsapp_number,
        company_website,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.json({
      success: true,
      lead: data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
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
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (role !== "Admin" && existing.created_by !== userId) {
      return res.status(403).json({
        success: false,
        message: "Not authorized",
      });
    }

    const { error } = await supabaseAdmin
      .from("leads")
      .delete()
      .eq("id", id);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.json({
      success: true,
      message: "Lead deleted",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};