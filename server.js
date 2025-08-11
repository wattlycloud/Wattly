// server.js — Wattly Bill Audit (Render-ready)
const express = require("express");
const fileUpload = require("express-fileupload");
const pdf = require("pdf-parse");
const nodemailer = require("nodemailer");

const app = express();

// uploads + simple forms
app.use(fileUpload({ limits: { fileSize: 20 * 1024 * 1024 } })); // 20 MB
app.use(express.urlencoded({ extended: true }));

// ---------- utility-agnostic parser ----------
function parseBillText(raw) {
  const text = String(raw || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const pick = (arr) => { for (const r of arr) { const m = text.match(r); if (m) return m.groups?.v || m[1]; } return null; };
  const money = (s) => (s != null ? Number(String(s).replace(/[$,]/g, "")) : null);
  const num = (s) => (s != null ? Number(String(s).replace(/,/g, "")) : null);

  const result = {
    utility: pick([/(Con\s?Edison|ConEd|National Grid|PSE&G|PG&E|SCE|SDG&E|ComEd|CenterPoint|DTE|PECO|Duke Energy|FPL|SoCalGas)/i]),
    customer: pick([/^\s*([A-Z0-9 .,'&-]{3,})\s+Account\s*Number/m, /Customer\s*Name[:\s]*(?<v>.+?)(?:\n|$)/i]),
    account: pick([/Account\s*Number[:\s]*([0-9\-]+)/i, /Acct(?:\.|ount)?\s*#[:\s]*([0-9\-]+)/i]),
    service_address: pick([/Service\s*(?:Address|Location|delivered\s*to)[:\s]*(?<v>.+?)(?:\n|$)/i]),
    billing_period: pick([
      /Billing\s*period[:\s]*(?<v>[A-Za-z]{3}\s*\d{1,2},?\s*\d{4}\s*to\s*[A-Za-z]{3}\s*\d{1,2},?\s*\d{4}(?:,\s*\d+\s*days)?)/i,
      /Service\s*(?:from|period)[:\s]*(?<v>.+?)(?:\n|$)/i
    ]),
    total_due: money(pick([
      /Total\s*(?:Amount\s*)?Due(?:\s*by.*?)?[:\s]*\$?([0-9,]+\.\d{2})/i,
      /Amount\s*Due[:\s]*\$?([0-9,]+\.\d{2})/i
    ])),
    usage: {
      kwh: num(pick([/([0-9,]+(?:\.\d+)?)\s*kwh\b/i, /Total\s*(?:Electric)?\s*(?:Use|Usage)\s*([0-9,]+(?:\.\d+)?)\s*kwh/i])),
      therms: num(pick([/([0-9,]+(?:\.\d+)?)\s*therms?\b/i, /Total\s*Gas\s*Use\s*([0-9,]+(?:\.\d+)?)\s*therms?/i])),
      ccf: num(pick([/([0-9,]+(?:\.\d+)?)\s*ccf\b/i]))
    },
    charges: {
      basic_service: money(pick([/Basic\s*(?:service|customer)\s*charge.*?\$?([0-9,]+\.\d{2})/i])),
      delivery: money(pick([/(?:Delivery|Distribution)\s*(?:charges?)?.*?\$?([0-9,]+\.\d{2})/i, /Total\s*(?:electric|gas)\s*delivery\s*charges.*?\$?([0-9,]+\.\d{2})/i])),
      supply: money(pick([/Supply\s*Charges.*?\$?([0-9,]+\.\d{2})/i])),
      adjustments: money(pick([/(Fuel|Monthly|Rate|Rider)\s*(?:adj(?:ustment)?|factor).*?\$?([0-9,]+\.\d{2})/i])),
      taxes: money(pick([/(Sales\s*tax|GRT).*?\$?([0-9,]+\.\d{2})/i]))
    }
  };

  // Decide commodity & monthly usage value/unit
  let commodity = null, monthly_usage = null, unit = "units";
  if (result.usage.kwh != null) { commodity = "electric"; monthly_usage = result.usage.kwh; unit = "kWh"; }
  else if (result.usage.therms != null) { commodity = "gas"; monthly_usage = result.usage.therms; unit = "therms"; }
  else if (result.usage.ccf != null) { commodity = "gas"; monthly_usage = result.usage.ccf; unit = "ccf"; }

  return { ...result, commodity, monthly_usage, unit };
}

// ---------- simple UI ----------
app.get("/", (_req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<title>Wattly – Upload Bill</title>
<style>
body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;margin:0}
.wrap{max-width:900px;margin:32px auto;padding:0 16px}
.card{background:#0b0b0b;border:1px solid #1a1a1a;border-radius:12px;padding:16px;margin-bottom:16px}
input,button{font-size:16px}
label{color:#bbb}
.btn{background:#FFD700;color:#000;border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}
</style></head><body><div class="wrap">
  <h1>Wattly – Bill Audit</h1>
  <div class="card">
    <form action="/proposal" method="post" enctype="multipart/form-data" target="_blank">
      <label>PDF Bill</label><br>
      <input type="file" name="bill" accept=".pdf" required><br><br>
      <label>Current supply rate ($/unit)</label>
      <input name="rate_current" type="number" step="0.0001" value="1.2000">
      <label style="margin-left:10px">Offered supply rate ($/unit)</label>
      <input name="rate_offered" type="number" step="0.0001" value="0.6900">
      <button class="btn" type="submit" style="margin-left:10px">Analyze</button>
    </form>
    <p style="color:#888;margin-top:8px">Works for gas (therms) or electric (kWh). Annual = monthly × 12.</p>
  </div>
</div></body></html>`);
});

// ---------- main: upload → parse → detailed report ----------
app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) return res.status(400).send("Upload a PDF in the 'bill' field.");
    const rateCurrent = Number(req.body.rate_current || 1.2);
    const rateOffered = Number(req.body.rate_offered || 0.69);

    const parsed = await pdf(req.files.bill.data);
    const info = parseBillText(parsed.text || "");
    const m = info.monthly_usage || 0;
    const y = m * 12;

    // supply-only cost comparison (monthly × 12 as requested)
    const cm = m * rateCurrent, cy = y * rateCurrent;
    const om = m * rateOffered, oy = y * rateOffered;
    const ms = cm - om, ys = cy - oy;

    // optional email CC (uses SMTP_URL env if present)
    if (process.env.SMTP_URL) {
      try {
        const transporter = nodemailer.createTransport(process.env.SMTP_URL);
        await transporter.sendMail({
          from: process.env.MAIL_FROM || "no-reply@wattly.net",
          to: process.env.MAIL_TO || "sales@wattly.net",
          subject: `Bill audit: ${info.utility || "Utility"} / ${info.account || "Account"}`,
          text: JSON.stringify({ info, rates: { rateCurrent, rateOffered }, savings: { monthly: ms, annual: ys } }, null, 2)
        });
      } catch (e) { console.warn("Email send failed:", e.message); }
    }

    res.set("Content-Type", "text/html");
    res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<title>Wattly – Proposal</title>
<style>
  body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;margin:0}
  .wrap{max-width:900px;margin:32px auto;padding:0 16px}
  .card{background:#0b0b0b;border:1px solid #1a1a1a;border-radius:12px;padding:16px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #1a1a1a;padding:8px;text-align:left}
  th{color:#bfb473}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .k{background:#101010;border:1px solid #1a1a1a;border-radius:10px;padding:12px}
  .big{font-weight:800;font-size:20px;color:#FFD700}
  .ok{color:#2ee282}
</style></head><body><div class="wrap">
  <h1>Energy Savings Proposal</h1>

  <div class="card">
    <table>
      <tr><th style="width:220px">Utility</th><td>${info.utility || "—"}</td></tr>
      <tr><th>Customer</th><td>${info.customer || "—"}</td></tr>
      <tr><th>Service Address</th><td>${info.service_address || "—"}</td></tr>
      <tr><th>Account #</th><td>${info.account || "—"}</td></tr>
      <tr><th>Billing Period</th><td>${info.billing_period || "—"}</td></tr>
      <tr><th>Commodity</th><td>${info.commodity || "—"}</td></tr>
      <tr><th>Monthly Usage</th><td>${m ? m.toFixed(0) : "—"} ${info.unit || ""}</td></tr>
      <tr><th>Annual Usage</th><td>${m ? y.toFixed(0) : "—"} ${info.unit || ""}</td></tr>
      <tr><th>Total Due</th><td>${info.total_due != null ? `$${info.total_due.toFixed(2)}` : "—"}</td></tr>
    </table>
  </div>

  <div class="grid">
    <div class="k"><div>Current Rate</div><div class="big">$${rateCurrent.toFixed(4)}</div></div>
    <div class="k"><div>Offered Rate</div><div class="big">$${rateOffered.toFixed(4)}</div></div>
    <div class="k"><div>Monthly Savings</div><div class="big ok">$${ms.toFixed(2)}</div></div>
    <div class="k"><div>Annual Savings</div><div class="big ok">$${ys.toFixed(2)}</div></div>
  </div>

  <div class="card">
    <table>
      <thead><tr><th></th><th>Rate</th><th>Monthly Cost</th><th>Annual Cost</th></tr></thead>
      <tbody>
        <tr><td>Current Supplier</td><td>$${rateCurrent.toFixed(4)}</td><td>$${cm.toFixed(2)}</td><td>$${cy.toFixed(2)}</td></tr>
        <tr><td>Offered Supplier</td><td>$${rateOffered.toFixed(4)}</td><td>$${om.toFixed(2)}</td><td>$${oy.toFixed(2)}</td></tr>
        <tr><td><strong>Savings</strong></td><td></td><td class="ok">$${ms.toFixed(2)}</td><td class="ok">$${ys.toFixed(2)}</td></tr>
      </tbody>
    </table>
    <p style="color:#bbb;margin-top:8px">Supply-only savings. Annual = monthly × 12.</p>
  </div>

  <div class="card">
    <h3>Parsed Details (JSON)</h3>
    <pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px">${JSON.stringify(info, null, 2)}</pre>
  </div>
</div></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not read that PDF. Try another file or send me the exact bill you’re using.");
  }
});

// health check for Render
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Render port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Wattly listening on " + PORT));
