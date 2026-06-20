// emailTemplates.js
// Professional enterprise-grade email templates for BBM CRM

// ── Design tokens ─────────────────────────────────────────────────────────
const BRAND = {
  primary:    "#4338ca", // indigo-700
  dark:       "#1e1b4b", // indigo-950
  accent:     "#6366f1", // indigo-500
  teal:       "#0f766e", // teal-700
  violet:     "#6d28d9", // violet-700
  rose:       "#be123c", // rose-700
  success:    "#15803d", // green-700
  bodyBg:     "#f8fafc",
  cardBg:     "#ffffff",
  border:     "#e2e8f0",
  textPrimary:"#0f172a",
  textMuted:  "#64748b",
  textLight:  "#94a3b8",
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
<body style="margin:0;padding:0;background:${BRAND.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BRAND.bodyBg};padding:40px 16px">
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
                          <span style="font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${headerColor}">
                            BBM Sales CRM
                          </span>
                        </td>
                        <td align="right">
                          <span style="font-size:11px;color:#475569;letter-spacing:0.05em">
                            Automated Notification
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 32px 28px">
                    <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:${headerColor}60">
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
                This is an automated message from <strong style="color:${BRAND.textMuted}">BBM Sales CRM</strong>.
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

const infoRow = (label, value) => {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:9px 16px 9px 0;vertical-align:top;white-space:nowrap;
          font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;
          color:${BRAND.textMuted};width:38%">
        ${label}
      </td>
      <td style="padding:9px 0;vertical-align:top;font-size:13px;color:${BRAND.textPrimary};
          font-weight:500;line-height:1.5;border-bottom:1px solid #f1f5f9">
        ${value}
      </td>
    </tr>`;
};

const sectionLabel = (text) => `
  <p style="margin:0 0 10px;font-size:10px;font-weight:800;letter-spacing:0.18em;
      text-transform:uppercase;color:${BRAND.textLight}">
    ${text}
  </p>`;

const detailTable = (rows) => `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
    style="border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;
           background:#fafbfc;margin:0">
    <tbody style="padding:0 16px">
      <tr><td colspan="2" style="height:4px"></td></tr>
      ${rows}
      <tr><td colspan="2" style="height:4px"></td></tr>
    </tbody>
  </table>`;

const innerRow = (label, value) => {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:8px 16px 8px 16px;vertical-align:top;
          font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
          color:${BRAND.textMuted};width:36%">
        ${label}
      </td>
      <td style="padding:8px 16px 8px 0;vertical-align:top;
          font-size:13px;color:${BRAND.textPrimary};font-weight:500;line-height:1.5;
          border-bottom:1px solid #f1f5f9">
        ${value}
      </td>
    </tr>`;
};

const statusPill = (label, status, followUpDate, color = BRAND.success) => `
  <div style="border:1px solid ${color}30;border-radius:10px;overflow:hidden;margin:0">
    <div style="background:${color}12;padding:10px 16px;border-bottom:1px solid ${color}20">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:${color}">${label}</span>
    </div>
    <div style="padding:14px 16px">
      <p style="margin:0;font-size:18px;font-weight:800;color:${color};letter-spacing:-0.01em">${status || "—"}</p>
      ${followUpDate
        ? `<p style="margin:6px 0 0;font-size:12px;color:${BRAND.textMuted}">
             Follow-up scheduled: <strong>${new Date(followUpDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</strong>
           </p>`
        : ""}
    </div>
  </div>`;

const tagBadge = (text, color) => `
  <span style="display:inline-block;background:${color}15;color:${color};
      border:1px solid ${color}30;padding:5px 14px;border-radius:6px;
      font-size:12px;font-weight:700;letter-spacing:0.04em;margin:3px 4px 3px 0">
    ${text}
  </span>`;

const divider = () => `<div style="border-top:1px solid ${BRAND.border};margin:24px 0"></div>`;

const bodyText = (text) => `
  <p style="margin:0 0 20px;font-size:14px;color:${BRAND.textPrimary};line-height:1.65">
    ${text}
  </p>`;

const metaLine = (text) => `
  <p style="margin:24px 0 0;font-size:12px;color:${BRAND.textLight};line-height:1.6;
      border-top:1px solid #f1f5f9;padding-top:16px">
    ${text}
  </p>`;

// ── Reusable detail blocks ────────────────────────────────────────────────

const rfqDetailBlock = (rfq) => detailTable(`
  ${innerRow("Company",         rfq.company_name)}
  ${innerRow("Product",         rfq.product_name)}
  ${innerRow("Category",        [rfq.product_category, rfq.product_sub_category].filter(Boolean).join(" › "))}
  ${innerRow("Description",     rfq.product_description || rfq.sample_description || rfq.quotation_description)}
  ${innerRow("Consumption",     rfq.consumption_per_month ? `${rfq.consumption_per_month} ${rfq.unit || ""}` : null)}
  ${innerRow("Target Price",    rfq.target_price ? `₹${rfq.target_price}` : null)}
  ${innerRow("Existing Supplier", rfq.existing_supplier_brand)}
`);

const leadDetailBlock = (lead) => detailTable(`
  ${innerRow("Company",           lead.company_name)}
  ${innerRow("Contact Person",    lead.primary_contact_name || lead.contact_name)}
  ${innerRow("Designation",       lead.primary_designation  || lead.designation)}
  ${innerRow("Phone",             lead.primary_phone        || lead.mobile_number)}
  ${innerRow("Email",             lead.primary_email        || lead.email)}
  ${innerRow("City / Zone",       [lead.city, lead.zone].filter(Boolean).join(" / "))}
  ${innerRow("State",             lead.state)}
  ${innerRow("Route",             lead.route)}
  ${innerRow("Nature of Business",lead.nature_of_business)}
  ${innerRow("Industry",          lead.manufacturing_industry)}
  ${innerRow("Website",           lead.company_website)}
`);

const productDetailBlock = (product) => detailTable(`
  ${innerRow("Category",     product.category)}
  ${innerRow("Sub-Category", product.sub_category)}
  ${innerRow("Product Name", product.product_name)}
`);

// ═════════════════════════════════════════════════════════════════════════
// EXPORTED TEMPLATES
// ═════════════════════════════════════════════════════════════════════════

// ── RFQ: Salesperson confirmation ─────────────────────────────────────────
export const rfqCreatedSalesperson = ({ salespersonEmail, rfq }) => ({
  to: salespersonEmail,
  subject: `RFQ Submitted — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── RFQ: Coordinator notification ─────────────────────────────────────────
export const rfqCreatedCoordinator = ({ coordinatorEmail, rfq, salespersonEmail }) => ({
  to: coordinatorEmail,
  subject: `New RFQ — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── Sample: Coordinator acknowledgement ───────────────────────────────────
export const sampleUpdatedCoordinator = ({ coordinatorEmail, sample, rfq, updaterEmail }) => ({
  to: coordinatorEmail,
  subject: `Sample Status Updated — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── Sample: Salesperson notification ──────────────────────────────────────
export const sampleUpdatedSalesperson = ({ salespersonEmail, sample, rfq }) => ({
  to: salespersonEmail,
  subject: `Sample Update — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── Quotation: Coordinator acknowledgement ────────────────────────────────
export const quotationUpdatedCoordinator = ({ coordinatorEmail, quotation, rfq, updaterEmail }) => ({
  to: coordinatorEmail,
  subject: `Quotation Status Updated — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── Quotation: Salesperson notification ───────────────────────────────────
export const quotationUpdatedSalesperson = ({ salespersonEmail, quotation, rfq }) => ({
  to: salespersonEmail,
  subject: `Quotation Update — ${rfq.company_name} · ${rfq.product_name}`,
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
});

// ── Product: Created ──────────────────────────────────────────────────────
export const productCreatedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to: coordinatorEmail,
  subject: `Product Added — ${product.product_name}`,
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
  to: coordinatorEmail,
  subject: `Product Updated — ${product.product_name}`,
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
  to: coordinatorEmail,
  subject: `Product Removed — ${product.product_name}`,
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
  to: salespersonEmail,
  subject: `Lead Added — ${lead.company_name}`,
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
  to: customerEmail,
  subject: `Thank you for connecting with BBM — ${lead.company_name}`,
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
      <span style="font-size:12px;color:${BRAND.textLight}">BBM Sales CRM</span>
    </p>
  `),
});