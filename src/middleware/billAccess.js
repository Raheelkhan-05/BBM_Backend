// middleware/billAccess.js

const VIEW_ALLOWED = new Set([
  "info@bbmpvtltd.com",
  "account@bbmpvtltd.com",
  "communication@bbmpvtltd.com",
  "jay@bbmpvtltd.com",
]);

const UPLOAD_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com",
]);

const EDIT_DELETE_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com"
]);

// Manual single-record add
const ADD_ALLOWED = new Set([
  "communication@bbmpvtltd.com",
  "account@bbmpvtltd.com",
]);

// Manual override of the Collection Active toggle, and resolving
// pending cheques (mark received / bounced).
const COLLECTION_TOGGLE_ALLOWED = new Set([
  "account@bbmpvtltd.com",
  "communication@bbmpvtltd.com",
]);

function norm(email) {
  return (email || "").trim().toLowerCase();
}

export function requireBillAccess(req, res, next) {
  const email = norm(req.user?.email);
  if (!VIEW_ALLOWED.has(email)) {
    return res.status(403).json({ success: false, message: "Not authorized to view bill dues" });
  }
  next();
}

export function requireBillUploadAccess(req, res, next) {
  const email = norm(req.user?.email);
  if (!UPLOAD_ALLOWED.has(email)) {
    return res.status(403).json({ success: false, message: "Only Communication team can upload bill files" });
  }
  next();
}

export function requireBillAddAccess(req, res, next) {
  const email = norm(req.user?.email);
  if (!ADD_ALLOWED.has(email)) {
    return res.status(403).json({ success: false, message: "You're not authorized to add bill records manually" });
  }
  next();
}

export function requireBillEditDeleteAccess(req, res, next) {
  const email = norm(req.user?.email);
  if (!EDIT_DELETE_ALLOWED.has(email)) {
    return res.status(403).json({ success: false, message: "Only Communication team can edit or delete bill records" });
  }
  next();
}

export function requireBillToggleAccess(req, res, next) {
  const email = norm(req.user?.email);
  if (!COLLECTION_TOGGLE_ALLOWED.has(email)) {
    return res.status(403).json({ success: false, message: "Only Account/Communication team can override collection status or resolve cheques" });
  }
  next();
}