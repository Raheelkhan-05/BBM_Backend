// emailTemplates.js

import crypto from "crypto";


// Professional enterprise-grade email templates for BBM CRM

// ── Design tokens ─────────────────────────────────────────────────────────
const BRAND = {
  primary:    "#4338ca",
  dark:       "#1e1b4b",
  accent:     "#6366f1",
  teal:       "#0f766e",
  violet:     "#6d28d9",
  rose:       "#be123c",
  success:    "#15803d",
  bodyBg:     "transparent",
  cardBg:     "#ffffff",
  border:     "#e2e8f0",
  textPrimary:"#0f172a",
  textMuted:  "#64748b",
  textLight:  "#94a3b8",
};

// ── Thread ID helpers ─────────────────────────────────────────────────────
//
// Email clients (Gmail, Outlook, Apple Mail) group messages into threads when:
//   1. The Subject is identical across all messages in the thread, AND
//   2. The In-Reply-To / References headers chain back to the same root Message-ID
//
// Strategy:
//   • Every lead gets a deterministic "thread root" Message-ID derived from its ID.
//   • All emails to the SAME recipient role (salesperson / coordinator / customer)
//     about the SAME lead share one subject prefix and reference the same root ID.
//   • We use three separate root IDs per lead so each audience gets its own thread:
//       – salesperson thread:   <lead-{id}-sp@bbm.crm>
//       – coordinator thread:   <lead-{id}-sc@bbm.crm>
//       – customer thread:      <lead-{id}-cx@bbm.crm>
//   • RFQ/Sample/Quotation emails are all part of the same lead lifecycle,
//     so they share the same root and therefore appear in the same thread.

const threadId = {
  salesperson:  (leadId) => `<lead-${leadId}-sp@bbm.crm>`,
  coordinator:  (leadId) => `<lead-${leadId}-sc@bbm.crm>`,
  customer:     (leadId) => `<lead-${leadId}-cx@bbm.crm>`,
};

// Generates a unique Message-ID for THIS specific email,
// while In-Reply-To / References point back to the stable thread root.
// This is the correct RFC 2822 threading pattern:
//   - Message-ID must be unique per message (or clients dedupe/collapse it)
//   - In-Reply-To / References carry the thread linkage
const threadHeaders = (rootMessageId) => {
  const uniqueId = `<${crypto.randomUUID()}@bbm.crm>`;
  return {
    "Message-ID":  uniqueId,        // unique per send — was previously == rootMessageId (bug)
    "In-Reply-To": rootMessageId,   // links back to the thread root
    "References":  rootMessageId,   // links back to the thread root
  };
};

// Shared subject prefix so the subject line is identical across all
// messages in a thread (Gmail threads on subject + References).
const threadSubject = {
  salesperson:  (lead) => `[BBM] ${lead.company_name} — Lead Updates`,
  coordinator:  (lead) => `[BBM] ${lead.company_name} — Lead Updates`,
  customer:     (lead) => `[BBM] ${lead.company_name} — BBM Updates`,
};

// ── Base layout wrapper ───────────────────────────────────────────────────
const layout = (headerColor, headerTitle, headerSubtitle, bodyContent) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${headerTitle}</title>
</head>
<body style="margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:transparent;padding:40px 16px">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:580px">

          <!-- Top bar -->
          <tr>
            <td style="padding-bottom:0">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:${BRAND.dark};border-radius:12px 12px 0 0;padding:0">
                <tr>
                  <td style="padding:20px 32px;border-bottom:3px solid ${headerColor}">
                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td>
                          <span style="font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6366f1">
                            Brand Brigade Marketing
                          </span>
                        </td>
                        <td align="right">
                          <span style="font-size:11px;color:#94a3b8;letter-spacing:0.05em">
                            Automated Notification
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 32px 28px">
                    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#cbd5e1">
                      ${headerSubtitle}
                    </p>
                    <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;line-height:1.25">
                      ${headerTitle}
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body card -->
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-top:none;border-radius:0 0 12px 12px">
                <tr>
                  <td style="padding:32px">
                    ${bodyContent}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 8px 8px;text-align:center">
              <p style="margin:0;font-size:11px;color:${BRAND.textLight};line-height:1.6">
                This is an automated message from <strong style="color:${BRAND.textMuted}">Brand Brigade Marketing</strong>.
                Please do not reply to this email.
              </p>
              <p style="margin:6px 0 0;font-size:11px;color:${BRAND.textLight}">
                &copy; ${new Date().getFullYear()} BBM &middot; All rights reserved
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// ── Shared block components ───────────────────────────────────────────────

const sectionLabel = (text) => `
  <p style="margin:0 0 10px;font-size:10px;font-weight:800;letter-spacing:0.18em;
      text-transform:uppercase;color:${BRAND.textMuted}">
    ${text}
  </p>`;

const detailTable = (rows) => `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
    style="border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;
           background:#f8fafc;margin:0">
    <tbody>
      <tr><td colspan="2" style="height:4px"></td></tr>
      ${rows}
      <tr><td colspan="2" style="height:4px"></td></tr>
    </tbody>
  </table>`;

const innerRow = (label, value) => {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:9px 16px 9px 16px;vertical-align:top;
          font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
          color:${BRAND.textMuted};width:36%">
        ${label}
      </td>
      <td style="padding:9px 16px 9px 0;vertical-align:top;
          font-size:13px;color:${BRAND.textPrimary};font-weight:500;line-height:1.5;
          border-bottom:1px solid ${BRAND.border}">
        ${value}
      </td>
    </tr>`;
};

const statusPill = (label, status, followUpDate, color = BRAND.success) => `
  <div style="border:1px solid ${color}40;border-radius:10px;overflow:hidden;margin:0;background:#ffffff">
    <div style="background:${color}18;padding:10px 16px;border-bottom:1px solid ${color}30">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:${color}">${label}</span>
    </div>
    <div style="padding:14px 16px">
      <p style="margin:0;font-size:18px;font-weight:800;color:${color};letter-spacing:-0.01em">${status || "—"}</p>
      ${followUpDate
        ? `<p style="margin:6px 0 0;font-size:12px;color:${BRAND.textMuted}">
             Follow-up scheduled: <strong style="color:${BRAND.textPrimary}">${new Date(followUpDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</strong>
           </p>`
        : ""}
    </div>
  </div>`;

const tagBadge = (text, color) => `
  <span style="display:inline-block;background:${color}15;color:${color};
      border:1px solid ${color}40;padding:5px 14px;border-radius:6px;
      font-size:12px;font-weight:700;letter-spacing:0.04em;margin:3px 4px 3px 0">
    ${text}
  </span>`;

const divider = () => `<div style="border-top:1px solid ${BRAND.border};margin:24px 0"></div>`;

const bodyText = (text) => `
  <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textPrimary};line-height:1.65">
    ${text}
  </p>`;

const metaLine = (text) => `
  <p style="margin:24px 0 0;font-size:12px;color:${BRAND.textMuted};line-height:1.6;
      border-top:1px solid ${BRAND.border};padding-top:16px">
    ${text}
  </p>`;

// ── Reusable detail blocks ────────────────────────────────────────────────

const rfqDetailBlock = (rfq) => detailTable(`
  ${innerRow("Company",           rfq.company_name)}
  ${innerRow("Product",           rfq.product_name)}
  ${innerRow("Category",          [rfq.product_category, rfq.product_sub_category].filter(Boolean).join(" › "))}
  ${innerRow("Description",       rfq.product_description || rfq.sample_description || rfq.quotation_description)}
  ${innerRow("Consumption",       rfq.consumption_per_month ? `${rfq.consumption_per_month} ${rfq.unit || ""}` : null)}
  ${innerRow("Target Price",      rfq.target_price ? `₹${rfq.target_price}` : null)}
  ${innerRow("Existing Supplier", rfq.existing_supplier_brand)}
`);

const leadDetailBlock = (lead) => detailTable(`
  ${innerRow("Company",            lead.company_name)}
  ${innerRow("Contact Person",     lead.primary_contact_name || lead.contact_name)}
  ${innerRow("Designation",        lead.primary_designation  || lead.designation)}
  ${innerRow("Phone",              lead.primary_phone        || lead.mobile_number)}
  ${innerRow("Email",              lead.primary_email        || lead.email)}
  ${innerRow("City / Zone",        [lead.city, lead.zone].filter(Boolean).join(" / "))}
  ${innerRow("State",              lead.state)}
  ${innerRow("Route",              lead.route)}
  ${innerRow("Nature of Business", lead.nature_of_business)}
  ${innerRow("Industry",           lead.manufacturing_industry)}
  ${innerRow("Website",            lead.company_website)}
`);

const productDetailBlock = (product) => detailTable(`
  ${innerRow("Category",     product.category)}
  ${innerRow("Sub-Category", product.sub_category)}
  ${innerRow("Product Name", product.product_name)}
  ${product.brochure_url
    ? innerRow("Brochure", `<a href="${product.brochure_url}" style="color:#4338ca;text-decoration:underline;font-weight:600" target="_blank">View Brochure ↗</a>`)
    : ""}
`);

// ═════════════════════════════════════════════════════════════════════════
// EXPORTED TEMPLATES
// ═════════════════════════════════════════════════════════════════════════
//
// Every template now returns { to, subject, headers, html }.
//
// Pass `headers` directly to your mailer's `headers` option, e.g.:
//
//   nodemailer:  transporter.sendMail({ ..., headers: tpl.headers })
//   SendGrid:    msg.headers = tpl.headers
//   Resend:      resend.emails.send({ ..., headers: tpl.headers })
//
// The lead object must have an `id` field (e.g. lead.id = "abc123").
// RFQ objects should carry rfq.lead_id pointing to the parent lead's id.

// ── RFQ: Salesperson confirmation ─────────────────────────────────────────
export const rfqCreatedSalesperson = ({ salespersonEmail, rfq }) => {
  // rfq.lead_id links this RFQ back to its parent lead for threading
  const rootId = threadId.salesperson(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      salespersonEmail,
    subject: threadSubject.salesperson(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.accent,
      "RFQ Submitted Successfully",
      "Enquiry Confirmation",
      `
      ${bodyText("Your RFQ has been logged and is now visible to the Sales Coordinator. A summary is included below for your records.")}

      ${sectionLabel("Enquiry Details")}
      ${rfqDetailBlock(rfq)}

      ${rfq.sample_required || rfq.quotation_required ? `
        ${divider()}
        ${sectionLabel("Actions Required")}
        <div style="margin-top:4px">
          ${rfq.sample_required    ? tagBadge("Sample Required",    BRAND.violet) : ""}
          ${rfq.quotation_required ? tagBadge("Quotation Required", BRAND.primary) : ""}
        </div>
      ` : ""}

      ${metaLine(`Submitted by: <strong>${salespersonEmail}</strong>`)}
    `),
  };
};

// ── RFQ: Coordinator notification ─────────────────────────────────────────
export const rfqCreatedCoordinator = ({ coordinatorEmail, rfq, salespersonEmail }) => {
  const rootId = threadId.coordinator(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      coordinatorEmail,
    subject: threadSubject.coordinator(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.violet,
      "New RFQ Received",
      "Action Required",
      `
      ${bodyText(`A new RFQ has been submitted by <strong>${salespersonEmail}</strong> and requires your attention.`)}

      ${sectionLabel("Enquiry Details")}
      ${rfqDetailBlock(rfq)}

      ${rfq.sample_required || rfq.quotation_required ? `
        ${divider()}
        ${sectionLabel("Items Pending Your Action")}
        <div style="margin-top:4px">
          ${rfq.sample_required    ? tagBadge("Sample — Please Process",    BRAND.violet) : ""}
          ${rfq.quotation_required ? tagBadge("Quotation — Please Process", BRAND.primary) : ""}
        </div>
      ` : ""}

      ${metaLine(`Submitted by: <strong>${salespersonEmail}</strong>`)}
    `),
  };
};

// ── Sample: Coordinator acknowledgement ───────────────────────────────────
export const sampleUpdatedCoordinator = ({ coordinatorEmail, sample, rfq, updaterEmail }) => {
  const rootId = threadId.coordinator(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      coordinatorEmail,
    subject: threadSubject.coordinator(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.violet,
      "Sample Status Updated",
      "Update Acknowledgement",
      `
      ${bodyText("This confirms that you have updated the sample status for the following enquiry.")}

      ${sectionLabel("Enquiry Reference")}
      ${rfqDetailBlock(rfq)}

      ${divider()}
      ${sectionLabel("Sample Status")}
      ${statusPill("Current Status", sample.sample_status, sample.follow_up_date, BRAND.violet)}

      ${metaLine(`Updated by: <strong>${updaterEmail}</strong>`)}
    `),
  };
};

// ── Sample: Salesperson notification ──────────────────────────────────────
export const sampleUpdatedSalesperson = ({ salespersonEmail, sample, rfq }) => {
  const rootId = threadId.salesperson(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      salespersonEmail,
    subject: threadSubject.salesperson(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.accent,
      "Sample Status Update",
      "Status Notification",
      `
      ${bodyText("The Sales Coordinator has updated the sample status for your enquiry. Please review the details below.")}

      ${sectionLabel("Enquiry Reference")}
      ${rfqDetailBlock(rfq)}

      ${divider()}
      ${sectionLabel("Sample Status")}
      ${statusPill("Current Status", sample.sample_status, sample.follow_up_date, BRAND.violet)}

      ${metaLine("Please log in to BBM CRM to view full details or take further action.")}
    `),
  };
};

// ── Quotation: Coordinator acknowledgement ────────────────────────────────
export const quotationUpdatedCoordinator = ({ coordinatorEmail, quotation, rfq, updaterEmail }) => {
  const rootId = threadId.coordinator(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      coordinatorEmail,
    subject: threadSubject.coordinator(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.teal,
      "Quotation Status Updated",
      "Update Acknowledgement",
      `
      ${bodyText("This confirms that you have updated the quotation status for the following enquiry.")}

      ${sectionLabel("Enquiry Reference")}
      ${rfqDetailBlock(rfq)}

      ${divider()}
      ${sectionLabel("Quotation Status")}
      ${statusPill("Current Status", quotation.quotation_status, quotation.follow_up_date, BRAND.teal)}

      ${metaLine(`Updated by: <strong>${updaterEmail}</strong>`)}
    `),
  };
};

// ── Quotation: Salesperson notification ───────────────────────────────────
export const quotationUpdatedSalesperson = ({ salespersonEmail, quotation, rfq }) => {
  const rootId = threadId.salesperson(rfq.lead_id || rfq.id);
  const lead   = { company_name: rfq.company_name, id: rfq.lead_id || rfq.id };
  return {
    to:      salespersonEmail,
    subject: threadSubject.salesperson(lead),
    headers: threadHeaders(rootId),
    html: layout(
      BRAND.accent,
      "Quotation Status Update",
      "Status Notification",
      `
      ${bodyText("The Sales Coordinator has updated the quotation status for your enquiry. Please review the details below.")}

      ${sectionLabel("Enquiry Reference")}
      ${rfqDetailBlock(rfq)}

      ${divider()}
      ${sectionLabel("Quotation Status")}
      ${statusPill("Current Status", quotation.quotation_status, quotation.follow_up_date, BRAND.teal)}

      ${metaLine("Please log in to BBM CRM to view full details or take further action.")}
    `),
  };
};

// ── Product: Created ──────────────────────────────────────────────────────
// Product emails are catalog-wide, not per-lead, so they don't thread with leads.
export const productCreatedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to:      coordinatorEmail,
  subject: `[BBM Catalog] Product Added — ${product.product_name}`,
  headers: threadHeaders(`<catalog-${product.id}-created@bbm.crm>`),
  html: layout(
    BRAND.teal,
    "New Product Added",
    "Catalog Update",
    `
    ${bodyText("A new product has been added to the BBM product catalog.")}

    ${sectionLabel("Product Details")}
    ${productDetailBlock(product)}

    ${metaLine(`Added by: <strong>${actorEmail || "—"}</strong>`)}
  `),
});

// ── Product: Updated ──────────────────────────────────────────────────────
export const productUpdatedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to:      coordinatorEmail,
  subject: `[BBM Catalog] ${product.product_name} — Updates`,
  headers: threadHeaders(`<catalog-${product.id}-updates@bbm.crm>`),
  html: layout(
    BRAND.teal,
    "Product Updated",
    "Catalog Update",
    `
    ${bodyText("An existing product in the BBM catalog has been updated.")}

    ${sectionLabel("Product Details")}
    ${productDetailBlock(product)}

    ${metaLine(`Updated by: <strong>${actorEmail || "—"}</strong>`)}
  `),
});

// ── Product: Deleted ──────────────────────────────────────────────────────
export const productDeletedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to:      coordinatorEmail,
  subject: `[BBM Catalog] ${product.product_name} — Updates`,
  headers: threadHeaders(`<catalog-${product.id}-updates@bbm.crm>`),
  html: layout(
    BRAND.rose,
    "Product Removed from Catalog",
    "Catalog Update",
    `
    ${bodyText("The following product has been permanently removed from the BBM product catalog.")}

    ${sectionLabel("Removed Product")}
    ${productDetailBlock(product)}

    ${metaLine(`Removed by: <strong>${actorEmail || "—"}</strong>`)}
  `),
});

// ── Lead: Salesperson confirmation ────────────────────────────────────────
export const leadCreatedSalesperson = ({ salespersonEmail, lead }) => ({
  to:      salespersonEmail,
  subject: threadSubject.salesperson(lead),
  headers: threadHeaders(threadId.salesperson(lead.id)),
  html: layout(
    BRAND.accent,
    "Lead Added Successfully",
    "Lead Confirmation",
    `
    ${bodyText("Your new lead has been saved to BBM CRM. A summary is included below for your records.")}

    ${sectionLabel("Lead Details")}
    ${leadDetailBlock(lead)}

    ${metaLine("You can view and manage this lead at any time from your BBM dashboard.")}
  `),
});

// ── Lead: Customer welcome ────────────────────────────────────────────────
export const leadWelcomeCustomer = ({ customerEmail, lead }) => ({
  to:      customerEmail,
  subject: threadSubject.customer(lead),
  headers: threadHeaders(threadId.customer(lead.id)),
  html: layout(
    BRAND.accent,
    "Thank You for Connecting",
    "Welcome",
    `
    <p style="margin:0 0 16px;font-size:14px;color:${BRAND.textPrimary};line-height:1.65">
      Dear ${lead.primary_contact_name || lead.contact_name || lead.company_name},
    </p>

    ${bodyText(`Thank you for getting in touch with us. We are pleased to have <strong>${lead.company_name}</strong> as a potential partner and look forward to understanding your requirements in detail.`)}

    ${bodyText("One of our team members will reach out to you shortly. In the meantime, if you have any immediate questions, please do not hesitate to contact us.")}

    ${divider()}

    <p style="margin:0;font-size:13px;color:${BRAND.textMuted};line-height:1.7">
      Warm regards,<br />
      <strong style="color:${BRAND.textPrimary}">Team BBM</strong><br />
      <span style="font-size:12px;color:${BRAND.textLight}">Brand Brigade Marketing</span>
    </p>
  `),
});

// ── Prospect: Salesperson confirmation ───────────────────────────────────
export const prospectCreatedSalesperson = ({ salespersonEmail, prospect }) => ({
  to:      salespersonEmail,
  subject: `[BBM] Prospect Added — ${prospect.company_name}`,
  // Prospects are not part of a lead thread yet, so they get their own
  // lightweight thread root. If the prospect is later converted to a lead,
  // the lead thread takes over.
  headers: {
    "Message-ID":  `<prospect-${prospect.id}@bbm.crm>`,
    "In-Reply-To": `<prospect-${prospect.id}@bbm.crm>`,
    "References":  `<prospect-${prospect.id}@bbm.crm>`,
  },
  html: layout(
    BRAND.accent,
    "Prospect Added Successfully",
    "Prospect Confirmation",
    `
    ${bodyText("Your new prospect has been saved to BBM CRM. A summary is included below for your records.")}

    ${sectionLabel("Prospect Details")}
    ${detailTable(`
      ${innerRow("Company",          prospect.company_name)}
      ${innerRow("Industry",         prospect.industry)}
      ${innerRow("City / Zone",      [prospect.city, prospect.zone].filter(Boolean).join(" / "))}
      ${innerRow("State",            prospect.state)}
      ${innerRow("Route",            prospect.route)}
      ${innerRow("Source",           prospect.source)}
      ${innerRow("Next Action",      prospect.next_action)}
      ${innerRow("Next Action Date", prospect.next_action_date
          ? new Date(prospect.next_action_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
          : null)}
      ${innerRow("Feedback",         prospect.feedback)}
    `)}

    ${metaLine("You can view and manage this prospect at any time from your BBM dashboard.")}
  `),
});

export const otpEmail = ({ email, name, token }) => {
  // Guarantee exactly 6 digits, zero-padded just in case
  const code     = String(token).replace(/\D/g, "").slice(0, 6).padStart(6, "0");
  const display  = code.slice(0, 3) + " " + code.slice(3); // "083 941"

  // Deterministic thread root per recipient email so every OTP sent to the
  // same address lands in the same Gmail/Outlook/Apple Mail thread.
  // (crypto already imported at the top of this file.)
  const emailHash = crypto.createHash("sha256").update(email.toLowerCase().trim()).digest("hex").slice(0, 16);
  const rootId = `<otp-${emailHash}@bbm.crm>`;

  // One <td> per digit — clean, readable in all email clients
  const digitCells = code
    .split("")
    .map(
      (d) => `<td style="
          width:46px;height:58px;
          background:#eef2ff;
          border:2px solid #c7d2fe;
          border-radius:10px;
          text-align:center;
          vertical-align:middle;
          font-size:30px;
          font-weight:900;
          color:#3730a3;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;
          padding:0;
        ">${d}</td><td style="width:8px"></td>`
    )
    .join("");

  return {
    to:      email,
    subject: "[BBM] Your sign-in code",
    headers: threadHeaders(rootId),
    html: `<!DOCTYPE html>
...
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>BBM Sign-in Code</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:40px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px">

        <!-- Header -->
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#1e1b4b;border-radius:14px 14px 0 0">
            <tr>
              <td style="padding:20px 32px;border-bottom:3px solid #6366f1">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td><span style="font-size:13px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#6366f1">Brand Brigade Marketing</span></td>
                    <td align="right"><span style="font-size:11px;color:#94a3b8;letter-spacing:0.05em">Automated Notification</span></td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px">
                <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#cbd5e1">Authentication</p>
                <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;line-height:1.25">Your BBM sign-in code</h1>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px">
            <tr><td style="padding:36px 32px">

              <p style="margin:0 0 6px;font-size:14px;color:#0f172a;line-height:1.65">Hi${name ? ` <strong>${name}</strong>` : ""},</p>
              <p style="margin:0 0 28px;font-size:14px;color:#0f172a;line-height:1.65">
                Use the code below to sign in to your BBM account.
                This code is valid for <strong>10 minutes</strong> and can only be used once.
              </p>

              <!-- Code block -->
              <table cellpadding="0" cellspacing="0" role="presentation"
                style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:24px 28px;margin:0 auto 28px;width:100%">
                <tr><td align="center">
                  <p style="margin:0 0 16px;font-size:10px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#6366f1">Sign-in code</p>

                  <!-- 6 digit boxes -->
                  <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto">
                    <tr>${digitCells}</tr>
                  </table>

                </td></tr>
              </table>

              <!-- Security note -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;margin-bottom:24px">
                <tr>
                  <td style="padding:14px 16px;vertical-align:top;width:28px;font-size:16px">⚠️</td>
                  <td style="padding:14px 16px 14px 0;vertical-align:top">
                    <p style="margin:0;font-size:12px;color:#92400e;line-height:1.6">
                      <strong>Never share this code.</strong>
                      BBM staff will never ask for it. If you did not request this, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 8px 8px;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6">
            This is an automated message from <strong style="color:#64748b">Brand Brigade Marketing</strong>.
            Please do not reply to this email.
          </p>
          <p style="margin:6px 0 0;font-size:11px;color:#94a3b8">
            &copy; ${new Date().getFullYear()} BBM &middot; All rights reserved
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
};

export const pendingTasksDigest = ({ recipients, rows }) => {
  const overdue = rows.filter((r) => r.statusLabel === "Overdue");
  const dueToday = rows.filter((r) => r.statusLabel === "Due Today");
  const stillPending = rows.filter((r) => r.statusLabel === "Pending");
  const todayStr = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  const rowsToHtml = (list, color) => list.length
    ? list.map((r) => `
      <div style="border:1px solid ${color}30;border-radius:8px;padding:12px 14px;margin-bottom:8px;background:#ffffff">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${BRAND.textPrimary}">${r.company} <span style="font-weight:500;color:${BRAND.textMuted}">— Due ${r.dueDateFmt}</span></p>
        <p style="margin:0 0 4px;font-size:12px;color:${BRAND.textMuted}">${r.enquiryDetail}</p>
        <p style="margin:0;font-size:11.5px;color:${BRAND.textPrimary};white-space:pre-line">${r.newFollowup !== "—" ? r.newFollowup : "No update logged today"}</p>
      </div>`).join("")
    : `<p style="margin:0 0 12px;font-size:12px;color:${BRAND.textLight}">None</p>`;

  return {
    to: recipients,
    subject: `[BBM] Pending Tasks Digest — ${todayStr}`,
    headers: {
      "Message-ID": `<pending-digest-${Date.now()}@bbm.crm>`,
    },
    html: layout(
      BRAND.rose,
      "Daily Pending Tasks Digest",
      "End of Day Summary",
      `
      ${sectionLabel(`Overdue (${overdue.length})`)}
      ${rowsToHtml(overdue, BRAND.rose)}
      ${divider()}
      ${sectionLabel(`Due Today (${dueToday.length})`)}
      ${rowsToHtml(dueToday, "#d97706")}
      ${divider()}
      ${sectionLabel(`Still Pending — Upcoming (${stillPending.length})`)}
      ${rowsToHtml(stillPending, BRAND.accent)}
    `),
  };
};