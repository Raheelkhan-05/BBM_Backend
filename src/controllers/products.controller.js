// products.controller.js — optimised
// Changes:
//  - All emails are fire-and-forget (don't block response on SMTP)
//  - deleteProduct: fetch-then-delete replaced with delete-then-email using stored data
//    (1 DB call instead of 2)

import { createClient } from "@supabase/supabase-js";
import { sendMail } from "../config/mailer.js";
import {
  productCreatedCoordinator,
  productUpdatedCoordinator,
  productDeletedCoordinator,
} from "../config/emailTemplates.js";
import { logAudit } from "../utils/auditLog.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sendMailAsync = (opts) =>
  sendMail(opts).catch((e) => console.error("Mail error:", e.message));

// GET /api/products — all roles
export const getProducts = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("products")
      .select("*")
      .order("category")
      .order("sub_category")
      .order("product_name");

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, products: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createProduct = async (req, res) => {
  try {
    const { category, sub_category, product_name, brochure_url } = req.body;
    const actor = req.user;

    if (!category?.trim() || !sub_category?.trim() || !product_name?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data, error } = await supabaseAdmin
      .from("products")
      .insert([{
        category:     category.trim(),
        sub_category: sub_category.trim(),
        product_name: product_name.trim(),
        brochure_url: brochure_url?.trim() || null,
      }])
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logAudit({ entityType: "product", entityId: data.id, action: "create", actor, after: data });

    if (actor?.email) {
      sendMailAsync(productCreatedCoordinator({ coordinatorEmail: actor.email, product: data, actorEmail: actor.email }));
    }

    return res.status(201).json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, sub_category, product_name, brochure_url } = req.body;
    const actor = req.user;

    if (!category?.trim() || !sub_category?.trim() || !product_name?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data: before } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", id)
      .single();

    const { data, error } = await supabaseAdmin
      .from("products")
      .update({
        category:     category.trim(),
        sub_category: sub_category.trim(),
        product_name: product_name.trim(),
        brochure_url: brochure_url?.trim() || null,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logAudit({ entityType: "product", entityId: id, action: "update", actor, before, after: data });

    if (actor?.email) {
      sendMailAsync(productUpdatedCoordinator({ coordinatorEmail: actor.email, product: data, actorEmail: actor.email }));
    }

    return res.json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const actor = req.user;

    const { data: deleted, error } = await supabaseAdmin
      .from("products")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Product not found" });
      return res.status(400).json({ success: false, message: error.message });
    }

    logAudit({ entityType: "product", entityId: id, action: "delete", actor, before: deleted });

    if (actor?.email) {
      sendMailAsync(productDeletedCoordinator({ coordinatorEmail: actor.email, product: deleted, actorEmail: actor.email }));
    }

    return res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};