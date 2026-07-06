// controllers/liveReport.controller.js
//
// GET /api/reports/live?section=overview|today|lifetime|status|bills|all
//
// Powers the in-app live Reports page — the same data the daily PDF is
// built from, but fetchable on demand, section by section, so the page
// can paint fast and pull the heavier sections in the background
// (same two-phase pattern as prospectHistory.controller.js).
//
// All heavy lifting is delegated to the existing builders in
// dailyReport.service.js — this controller adds NO query logic of its
// own, so the live page and the emailed PDF can never drift apart:
// they are always two views of the exact same data shapes.
//
//   ?section=overview  → today's headline counts + no-activity list +
//                        lifetime contribution summary (fast — this is
//                        what the page requests first)
//   ?section=today     → today's detailed activity (full field diffs)
//   ?section=lifetime  → all-time condensed activity log per employee
//   ?section=status    → prospect/enquiry/sample/quotation status logs
//                        + current status snapshot
//   ?section=bills     → the whole Payment (Bill Dues) block
//   ?section=all       → everything in one payload (used by "refresh all")
//
// Admin only, same as the PDF recipients' level of access.

import {
  buildDailyReportData,
  buildLifetimeSummary,
  buildLifetimeActivityLog,
  buildStatusReport,
  buildBillsReport,
} from "../services/dailyReport.service.js";

const VALID_SECTIONS = new Set(["overview", "today", "lifetime", "status", "bills", "all"]);

export const getLiveReport = async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "Admin") {
      return res.status(403).json({ success: false, message: "Admin only" });
    }

    const section = String(req.query.section || "all").toLowerCase();
    if (!VALID_SECTIONS.has(section)) {
      return res.status(400).json({
        success: false,
        message: `Unknown section "${section}". Valid: ${[...VALID_SECTIONS].join(", ")}`,
      });
    }

    const payload = { generatedAt: new Date().toISOString(), section };

    if (section === "overview") {
      // buildDailyReportData carries the headline counts AND the
      // per-entry detail; for overview we strip the heavy `changes`
      // arrays so the first paint is a small payload.
      const [reportData, lifetimeSummary] = await Promise.all([
        buildDailyReportData(),
        buildLifetimeSummary(),
      ]);
      payload.overview = {
        generatedAt: reportData.generatedAt,
        rangeStart: reportData.rangeStart,
        totalActions: reportData.totalActions,
        activeTodayCount: reportData.activeToday.length,
        noActivityToday: reportData.noActivityToday.map(({ name, email }) => ({ name, email })),
        activeToday: reportData.activeToday.map((e) => ({
          name: e.name,
          email: e.email,
          actionCount: e.entries.length,
          lastActionAt: e.entries[0]?.timestamp || null,
          lastActionLabel: e.entries[0] ? `${e.entries[0].type} — ${e.entries[0].company}` : null,
        })),
        lifetimeSummary,
      };
    } else if (section === "today") {
      payload.today = await buildDailyReportData();
    } else if (section === "lifetime") {
      payload.lifetime = await buildLifetimeActivityLog();
    } else if (section === "status") {
      payload.status = await buildStatusReport();
    } else if (section === "bills") {
      payload.bills = await buildBillsReport();
    } else {
      // section === "all"
      const [today, lifetimeSummary, lifetime, status, bills] = await Promise.all([
        buildDailyReportData(),
        buildLifetimeSummary(),
        buildLifetimeActivityLog(),
        buildStatusReport(),
        buildBillsReport(),
      ]);
      payload.today = today;
      payload.lifetimeSummary = lifetimeSummary;
      payload.lifetime = lifetime;
      payload.status = status;
      payload.bills = bills;
    }

    return res.json({ success: true, data: payload });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};