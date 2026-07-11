// controllers/routeAuditLogs.controller.js
export const getRouteAuditLogs = async (req, res) => {
  try {
    const { route_id, limit = 100 } = req.query;
    let query = supabaseAdmin
      .from("route_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Number(limit));

    if (route_id) query = query.eq("route_id", route_id);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};