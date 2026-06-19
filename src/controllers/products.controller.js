import { supabase } from "../config/supabase.js";
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

// POST /api/products — Admin & SalesCoordinator only
export const createProduct = async (req, res) => {
  try {
    const { category, sub_category, product_name } = req.body;
    const actorEmail = req.user?.email;

    if (!category?.trim() || !sub_category?.trim() || !product_name?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data, error } = await supabaseAdmin
      .from("products")
      .insert([{ category: category.trim(), sub_category: sub_category.trim(), product_name: product_name.trim() }])
      .select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Acknowledgement goes only to the current logged-in user (Sales Coordinator)
    if (actorEmail) {
      sendMail(productCreatedCoordinator({
        coordinatorEmail: actorEmail,
        product: data,
        actorEmail,
      }));
    }

    return res.status(201).json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/products/:id — Admin & SalesCoordinator only
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, sub_category, product_name } = req.body;
    const actorEmail = req.user?.email;

    if (!category?.trim() || !sub_category?.trim() || !product_name?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data, error } = await supabaseAdmin
      .from("products")
      .update({ category: category.trim(), sub_category: sub_category.trim(), product_name: product_name.trim(), updated_at: new Date().toISOString() })
      .eq("id", id).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    if (actorEmail) {
      sendMail(productUpdatedCoordinator({
        coordinatorEmail: actorEmail,
        product: data,
        actorEmail,
      }));
    }

    return res.json({ success: true, product: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/products/:id — Admin & SalesCoordinator only
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const actorEmail = req.user?.email;

    // Fetch product before deleting so we still have its details for the email
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !existing)
      return res.status(404).json({ success: false, message: "Product not found" });

    const { error } = await supabaseAdmin.from("products").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    if (actorEmail) {
      sendMail(productDeletedCoordinator({
        coordinatorEmail: actorEmail,
        product: existing,
        actorEmail,
      }));
    }

    return res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};