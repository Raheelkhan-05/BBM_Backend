import { supabase } from "../config/supabase.js";

import { createClient } from "@supabase/supabase-js";
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/routes — all roles
export const getRoutes = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("routes")
      .select("*")
      .order("city").order("zone").order("route");

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, routes: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/routes — all authenticated (salesperson can create while filling lead)
export const createRoute = async (req, res) => {
  try {
    const { city, zone, route } = req.body;
    if (!city?.trim() || !zone?.trim() || !route?.trim())
      return res.status(400).json({ success: false, message: "City, Zone and Route are required" });

    // Check duplicate
    const { data: existing } = await supabaseAdmin
      .from("routes")
      .select("id")
      .eq("city", city.trim()).eq("zone", zone.trim()).eq("route", route.trim())
      .single();

    if (existing) return res.json({ success: true, route: existing, existed: true });

    const { data, error } = await supabaseAdmin
      .from("routes")
      .insert([{ city: city.trim(), zone: zone.trim(), route: route.trim() }])
      .select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.status(201).json({ success: true, route: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/routes/:id — Admin only
export const updateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { city, zone, route } = req.body;
    if (!city?.trim() || !zone?.trim() || !route?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data, error } = await supabaseAdmin
      .from("routes")
      .update({ city: city.trim(), zone: zone.trim(), route: route.trim() })
      .eq("id", id).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, route: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/routes/:id — Admin only
export const deleteRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from("routes").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, message: "Route deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};