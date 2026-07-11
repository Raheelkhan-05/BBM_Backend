// controllers/productAuditLogs.controller.js
export const getProductAuditLogs = async (req, res) => {
  try {
    const { product_id, limit = 100 } = req.query;
    let query = supabaseAdmin
      .from("product_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Number(limit));

    if (product_id) query = query.eq("product_id", product_id);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};