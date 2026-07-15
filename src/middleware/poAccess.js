// middleware/poAccess.js
// Same role split as billAccess.js — Account/Communication run collections
// AND purchasing in this org, so re-using the same allow-lists keeps admin
// simple. Swap these sets independently if Purchase ever becomes its own team.

const VIEW_ALLOWED = new Set([
  "account@bbmpvtltd.com",
  "communication@bbmpvtltd.com",
  "jay@bbmpvtltd.com",
]);

const UPLOAD_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com",
]);

const ADD_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com",
]);

const EDIT_DELETE_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com",
]);

// Manual override of Tracking Active, recording deliveries, cancelling a PO.
const TOGGLE_ALLOWED = new Set([
  "account@bbmpvtltd.com",
  "communication@bbmpvtltd.com",
]);

function norm(email) {
  return (email || "").trim().toLowerCase();
}

export function requirePOAccess(req, res, next) {
  if (!VIEW_ALLOWED.has(norm(req.user?.email))) {
    return res.status(403).json({ success: false, message: "Not authorized to view purchase orders" });
  }
  next();
}

export function requirePOUploadAccess(req, res, next) {
  if (!UPLOAD_ALLOWED.has(norm(req.user?.email))) {
    return res.status(403).json({ success: false, message: "Only Communication/Account team can upload PO files" });
  }
  next();
}

export function requirePOAddAccess(req, res, next) {
  if (!ADD_ALLOWED.has(norm(req.user?.email))) {
    return res.status(403).json({ success: false, message: "You're not authorized to add PO records manually" });
  }
  next();
}

export function requirePOEditDeleteAccess(req, res, next) {
  if (!EDIT_DELETE_ALLOWED.has(norm(req.user?.email))) {
    return res.status(403).json({ success: false, message: "Only Communication/Account team can edit or delete POs" });
  }
  next();
}

export function requirePOToggleAccess(req, res, next) {
  if (!TOGGLE_ALLOWED.has(norm(req.user?.email))) {
    return res.status(403).json({ success: false, message: "Only Account/Communication team can override tracking status or record deliveries" });
  }
  next();
}