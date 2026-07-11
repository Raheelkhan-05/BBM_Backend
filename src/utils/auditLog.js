// backend/utils/auditLog.js
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TABLES = {
  product: "product_audit_logs",
  route: "route_audit_logs",
};

const ID_COLUMNS = {
  product: "product_id",
  route: "route_id",
};

/**
 * Fire-and-forget audit log write — never blocks or fails the main request.
 * entityType: 'product' | 'route'
 */
export const logAudit = ({ entityType, entityId, action, actor, before = null, after = null }) => {
  const table = TABLES[entityType];
  const idColumn = ID_COLUMNS[entityType];

  if (!table) {
    console.error(`Audit log failed: unknown entityType "${entityType}"`);
    return;
  }

  supabaseAdmin
    .from(table)
    .insert([{
      [idColumn]: entityId,
      action,
      actor_id: actor?.id || null,
      actor_email: actor?.email || null,
      before_data: before,
      after_data: after,
    }])
    .then(({ error }) => {
      if (error) console.error(`Audit log failed [${table}/${action}]:`, error.message);
    });
};