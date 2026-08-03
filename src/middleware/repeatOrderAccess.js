// middleware/repeatOrderAccess.js
//
// Unlike PO/bills, the Repeat Order module is NOT gated by a fixed
// VIEW_ALLOWED allow-list — every authenticated user can open the page,
// because everyone can potentially have records assigned to them. What
// differs by role is WHAT they see and WHAT they can do:
//
//   • REPEAT_ORDER_MANAGERS  → see every record, can upload the sales
//                               dump, assign/reassign, edit, delete.
//   • everyone else           → only ever see records where
//                               assigned_to = themselves, and can only
//                               log follow-ups / take orders on records
//                               assigned to them.
//
// The "is this record assigned to me" check needs a DB row, so it can't
// live in this file as simple middleware — it happens inside the
// controller (see `canActOnRecord` in repeatOrders.controller.js). This
// file only handles the parts that are decidable from req.user alone.

const REPEAT_ORDER_MANAGERS = new Set([
  "jay@bbmpvtltd.com",
  "communication@bbmpvtltd.com",
]);

function norm(email) {
  return (email || "").trim().toLowerCase();
}

export function isRepeatOrderManager(email) {
  return REPEAT_ORDER_MANAGERS.has(norm(email));
}

// Any authenticated user may open the module — `authenticate` (upstream)
// already guarantees req.user exists; this is just an explicit gate in
// case that ever changes, and a single place to tighten later (e.g. if
// you want to restrict to a specific allow-list the way PO does, swap
// this body for a Set.has() check like poAccess.js).
export function requireRepeatOrderAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  next();
}

export function requireRepeatOrderManagerAccess(req, res, next) {
  if (!isRepeatOrderManager(req.user?.email)) {
    return res.status(403).json({
      success: false,
      message: "Only Admin can perform this action on Repeat Orders",
    });
  }
  next();
}