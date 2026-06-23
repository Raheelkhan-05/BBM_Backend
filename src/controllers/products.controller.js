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

// POST /api/products
export const createProduct = async (req, res) => {
  try {
    const { category, sub_category, product_name, brochure_url } = req.body;
    const actorEmail = req.user?.email;

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

    // Fire-and-forget — don't block response on SMTP
    if (actorEmail) {
      sendMailAsync(productCreatedCoordinator({ coordinatorEmail: actorEmail, product: data, actorEmail }));
    }

    return res.status(201).json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/products/:id
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, sub_category, product_name, brochure_url } = req.body;
    const actorEmail = req.user?.email;

    if (!category?.trim() || !sub_category?.trim() || !product_name?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

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

    // Fire-and-forget
    if (actorEmail) {
      sendMailAsync(productUpdatedCoordinator({ coordinatorEmail: actorEmail, product: data, actorEmail }));
    }

    return res.json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/products/:id
// OPTIMISED: was SELECT then DELETE (2 calls).
// Now: DELETE with .select() returns the deleted row in one call.
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const actorEmail = req.user?.email;

    const { data: deleted, error } = await supabaseAdmin
      .from("products")
      .delete()
      .eq("id", id)
      .select()   // ← returns the deleted row so we can use it in the email
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ success: false, message: "Product not found" });
      return res.status(400).json({ success: false, message: error.message });
    }

    // Fire-and-forget
    if (actorEmail) {
      sendMailAsync(productDeletedCoordinator({ coordinatorEmail: actorEmail, product: deleted, actorEmail }));
    }

    return res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};