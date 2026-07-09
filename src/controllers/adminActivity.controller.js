// controllers/adminActivity.controller.js
import {
  buildDailyReportData, buildStatusReport, buildCompanyTimeline, searchCompanies,
  buildActivityFeed, buildAllTimeByEmployee,
  searchBillParties, buildPartyBillTimeline, buildSingleBillTimeline,
} from "../services/dailyReport.service.js";



function requireAdmin(req, res) {
//   if (req.user?.role !== "Admin") {
//     res.status(403).json({ success: false, message: "Admin only" });
//     return false;
//   }
  return true;
}

export const searchBillPartiesEndpoint = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await searchBillParties(req.query.q || "");
    return res.json({ success: true, ...data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getPartyBillTimeline = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { return res.json({ success: true, data: await buildPartyBillTimeline(decodeURIComponent(req.params.partyName)) }); }
  catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

export const getSingleBillTimeline = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { return res.json({ success: true, data: await buildSingleBillTimeline(req.params.billId) }); }
  catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/admin/activity/today — every user's activity today, live
export const getTodayActivity = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await buildDailyReportData();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/activity/status — grouped lead-stage/enquiry/sample/quotation logs
export const getStatusBoard = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await buildStatusReport();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/activity/companies?q=... — search for the timeline picker
export const searchCompaniesEndpoint = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await searchCompanies(req.query.q || "");
    return res.json({ success: true, companies: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/activity/companies/:leadId — full timeline for one company
export const getCompanyTimeline = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await buildCompanyTimeline(req.params.leadId);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getActivityFeed = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;
    const employeeId = req.query.employeeId || null;
    const data = await buildActivityFeed({ limit, offset, employeeId });
    return res.json({ success: true, ...data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAllTimeByEmployee = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await buildAllTimeByEmployee();
    return res.json({ success: true, employees: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};