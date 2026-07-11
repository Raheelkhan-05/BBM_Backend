// controllers/routes.controller.js — optimised
//
// createRoute: replaced SELECT-then-INSERT with a single upsert
//   (unique constraint on country+state+city+zone+route required in DB — see note below)

import { createClient } from "@supabase/supabase-js";
import { logAudit } from "../utils/auditLog.js";

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

export const createRoute = async (req, res) => {
  try {
    const { country, state, city, zone, route } = req.body;
    const actor = req.user;

    if (!city?.trim() || !zone?.trim() || !route?.trim())
      return res.status(400).json({ success: false, message: "City, Zone and Route are required" });

    const payload = {
      country: country?.trim() || "India",
      state:   state?.trim()   || "",
      city:    city.trim(),
      zone:    zone.trim(),
      route:   route.trim(),
    };

    const { data, error } = await supabaseAdmin
      .from("routes")
      .upsert(payload, { onConflict: "country,state,city,zone,route", ignoreDuplicates: false })
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logAudit({ entityType: "route", entityId: data.id, action: "create", actor, after: data });

    return res.status(201).json({ success: true, route: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { country, state, city, zone, route } = req.body;
    const actor = req.user;

    if (!city?.trim() || !zone?.trim() || !route?.trim())
      return res.status(400).json({ success: false, message: "All fields are required" });

    const { data: before } = await supabaseAdmin
      .from("routes")
      .select("*")
      .eq("id", id)
      .single();

    const { data, error } = await supabaseAdmin
      .from("routes")
      .update({
        country: country?.trim() || "India",
        state:   state?.trim()   || "",
        city:    city.trim(),
        zone:    zone.trim(),
        route:   route.trim(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logAudit({ entityType: "route", entityId: id, action: "update", actor, before, after: data });

    return res.json({ success: true, route: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const actor = req.user;

    const { data: deleted, error } = await supabaseAdmin
      .from("routes")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logAudit({ entityType: "route", entityId: id, action: "delete", actor, before: deleted });

    return res.json({ success: true, message: "Route deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};