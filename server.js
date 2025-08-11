// server.js
const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const nodemailer = require("nodemailer");

const app = express();

// file uploads + form posts
app.use(fileUpload({ limits: { fileSize: 20 * 1024 * 1024 } })); // 20 MB
app.use(express.urlencoded({ extended: true }));

// --------- very simple, utility-agnostic text parser ----------
function parseBillText(t) {
  const text = t.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const pick = (regexes) => {
    for (const r of regexes) {
      const m = text.match(r);
      if (m) return m.groups?.v || m[1];
    }
    return null;
  };

  const out = {
    utility: pick([/(?:Con\s?Edison|ConEd|National Grid|PG&E|Duke Energy|FPL|PECO|PSE&G|SoCalGas)/i]),
    customer: pick([/^\s*([A-Z0-9 .,'&-]{3,})\s+Account\s*Number/m,
                    /(?:Customer|Account)\s*Name:\s*(?<v>.+?)\s*(?:\n|$)/i]),
    account: pick([/Account\s*Number[:\s]*([0-9\-]+)/i, /Acct(?:\.|ount)?\s*#[:\s]*([0-9\-]+)/i]),
    service_address: pick([/Service\s*(?:Location|Address|delivered\s*to)[:\s]*(?<v>.+?)(?:\n|$)/i]),
    billing_period: pick([
      /Billing\s*period[:\s]*(?<v>[A-Za-z]{3}\s*\d{1,2},?\s*\d{4}\s*to\s*[A-Za-z]{3}\s*\d{1,2},?\s*\d{4}(?:,\s*\d+\s*days)?)/i,
      /Billing\s*Period[:\s]*(?<v>[^ \n]+.*?\d{4}.*?(?:\d+\s*days)?)/i
    ]),
    total_due: pick([
      /Total\s*(?:Amount\s*)?Due(?:\s*by.*?)?[:\s]*\$?([0-9,]+\.\d{2})/i,
      /Amount\s*Due[:\s]*\$?([0-9,]+\.\d{2})/i,
    ]),
    usage: {
      therms: pick([/(\d+(?:\.\d+)?)\s*therms/i]),
      kwh: pick([/(\d+(?:\.\d+)?)\s*kwh/i, /(\d+(?:\.\d+)?)\s*kW[hH]/i]),
      ccf: pick([/(\d+(?:\.\d+)?)\s*ccf/i]),
    },
    charges: {
      gas_delivery: pick([/Total\s*gas\s*delivery\s*charges[:\s]*\$?([0-9,]+\.\d{2})/i]),
      electric_delivery: pick([/Total\s*electric\s*delivery\s*charges[:\s]*\$?([0-9,]+\.\d{2})/i]),
      supply: pick([/Supply\s*Charges[:\s]*\$?([0-9,]+\.\d{2})/i]),
      basic_service: pick([/Basic\s*service\s*charge.*?\$?([0-9,]+\.\d{2})/i]),
      taxes: pick([/(?:Sales\s*tax|GRT).*?\$?([0-9,]+\.\d{2})/i]),
    }
  };

  // tidy numbers
  const money = (s) => s ? Number(String(s).replace(/[$,]/g, "")) : null;
  out.total_due = money(out.total_due);
  if (out.charges) {
    for (const k of Object.keys(out.charges)) out.charges[k] = money(out.charges[k]);
  }
  for (const k of ["therms","kwh","ccf"]) {
    if (out.usage[k]) out.usage[k] = Number(out.usage[k]);
  }

  return out;
}

// ---------- web UI (simple form) ----------
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Wattly Bill Audit</title></head>
  <body style="font-family: system-ui, Arial; padding: 24px; max-width: 680px; margin:auto;">
    <h2>Upload Bill → Audit</h2>
    <form action="/proposal" method="post" enctype="multipart/form-data">
      <input type="file" name="bill" accept=".pdf,.png,.jpg,.jpeg" required />
      <button type="submit">Generate Audit</button>
    </form>
    <p style="opacity:.7">Accepts most US utility bills (gas/electric). PDF works best.</p>
  </body></html>`);
});

// ---------- main handler ----------
app.post("/proposal", async (req, res) => {
  try {
    if (!req.files?.bill) return res.status(400).send("No file uploaded (use field name 'bill').");
    const f = req.files.bill;

    // Parse PDF text (if an image, you’d add OCR later)
    const data = await pdfParse(f.data);
    const result = parseBillText(data.text || "");

    // Optional email CC
    const ccTo = process.env.MAIL_TO || "sales@wattly.net";
    if (process.env.SMTP_URL) {
      try {
        const transporter = nodemailer.createTransport(process.env.SMTP_URL);
        await transporter.sendMail({
          from: process.env.MAIL_FROM || "no-reply@wattly.net",
          to: ccTo,
          subject: `Bill audit: ${result.utility || "Utility"} / ${result.account || "Unknown"}`,
          text: JSON.stringify(result, null, 2),
        });
      } catch (e) {
        console.warn("Email failed:", e.message);
      }
    }

    // Show a friendly report + raw JSON
    res.send(`<!doctype html><html><body style="font-family:system-ui; padding:24px">
      <h2>Bill Audit</h2>
      <ul>
        <li><b>Utility:</b> ${result.utility || "—"}</li>
        <li><b>Customer:</b> ${result.customer || "—"}</li>
        <li><b>Account #:</b> ${result.account || "—"}</li>
        <li><b>Service Address:</b> ${result.service_address || "—"}</li>
        <li><b>Billing Period:</b> ${result.billing_period || "—"}</li>
        <li><b>Total Due:</b> ${result.total_due != null ? `$${result.total_due.toFixed(2)}` : "—"}</li>
        <li><b>Usage:</b> ${[
          result.usage.kwh != null ? `${result.usage.kwh} kWh` : null,
          result.usage.therms != null ? `${result.usage.therms} therms` : null,
          result.usage.ccf != null ? `${result.usage.ccf} ccf` : null,
        ].filter(Boolean).join(", ") || "—"}</li>
      </ul>
      <h3>JSON</h3>
      <pre style="white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:8px">${JSON.stringify(result, null, 2)}</pre>
      <p style="opacity:.7">Tip: set <code>SMTP_URL</code> in Render to CC results to ${ccTo}.</p>
    </body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to parse bill.");
  }
});

// Render injects PORT; listen on it.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wattly listening on ${PORT}`));
