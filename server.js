// server.js
// Wattly Bill Audit API (Node/Express + pdf-parse + optional email via SMTP)

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const nodemailer = require("nodemailer");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

// Optional email (set in Render > Environment)
const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,      // optional; defaults to SMTP_USER
  TO_EMAIL,        // where to send audit (comma-separated ok)
  REPLY_TO_EMAIL,  // optional reply-to
  APP_BASE_URL,    // optional canonical URL for links in email
  // Optional savings calc if you want fixed reference rates
  CURRENT_RATE,    // e.g. "1.20"  (your bill's current supply rate)
  OFFER_RATE       // e.g. "0.69"  (your offer rate)
} = process.env;

const canEmail = SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && TO_EMAIL;

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    useTempFiles: false,
    abortOnLimit: true,
  })
);

// ---------- Helpers ----------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function findMoney(text, labels = []) {
  // Look for $123.45 near a label; otherwise fallback to max value in doc
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const labelRegex = labels.length ? new RegExp(labels.join("|"), "i") : null;

  if (labelRegex) {
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }

  // Fallback: largest dollar value in entire doc
  let max = null;
  const moneyAll = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g) || [];
  for (const s of moneyAll) {
    const v = parseFloat(s.replace(/[$,\s]/g, ""));
    if (!isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function guessUtility(text) {
  if (/con\s*ed(ison)?/i.test(text)) return "Con Edison";
  if (/\bPGE\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/duke energy/i.test(text)) return "Duke Energy";
  if (/sdge|san diego gas/i.test(text)) return "SDG&E";
  if (/southern california edison|(^|\W)SCE(\W|$)/i.test(text)) return "SCE";
  return (
    firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,40})\s+(Bill|Invoice|Statement)/m) ||
    "Unknown Utility"
  );
}

function parseDates(text) {
  const m1 = text.match(
    /Billing period.*?(\b[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*(?:to|-|–)\s*(\b[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i
  );
  if (m1) return { start: m1[1], end: m1[2] };

  const m2 = text.match(
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  );
  if (m2) return { start: m2[1], end: m2[2] };

  return { start: null, end: null };
}

function parseUsage(text) {
  // Gas
  const therms =
    firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*therms?/i) ||
    firstMatch(text, /(\d+)\s*therms?\b/i);

  const ccf =
    firstMatch(text, /Total\s+usage.*?(\d{1,7})\s*ccf/i) ||
    firstMatch(text, /\b(\d{1,7})\s*ccf\b/i);

  // Electric
  const kwh = firstMatch(text, /(\d{2,7})\s*kWh\b/i);

  return {
    gas_therms: therms ? parseInt(therms, 10) : null,
    gas_ccf: ccf ? parseInt(ccf, 10) : null,
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
  };
}

function parseAccount(text) {
  return (
    firstMatch(text, /Account\s+(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
}

function inferMonthlyVolume(usage) {
  // Choose best available unit for “volume”
  if (usage.gas_therms) return { value: usage.gas_therms, unit: "therms" };
  if (usage.gas_ccf) return { value: usage.gas_ccf, unit: "ccf" };
  if (usage.electricity_kwh) return { value: usage.electricity_kwh, unit: "kWh" };
  return { value: null, unit: null };
}

function auditFromText(text) {
  const utility = guessUtility(text);
  const account_number = parseAccount(text);
  const { start, end } = parseDates(text);

  const total_due = findMoney(text, [
    "Total amount due",
    "Amount due",
    "Current balance due",
    "Total due",
  ]);

  const delivery_charges = findMoney(text, [
    "delivery charges",
    "distribution",
    "basic service charge",
    "remaining",
  ]);

  const supply_charges = findMoney(text, [
    "supply charges",
    "energy supply",
    "gas supply",
    "generation",
  ]);

  const taxes = findMoney(text, ["sales tax", "tax", "grt"]);

  const usage = parseUsage(text);
  const volume = inferMonthlyVolume(usage);

  // Effective rate from the bill (if we have supply_charges + volume)
  let effective_supply_rate = null;
  if (supply_charges && volume.value) {
    effective_supply_rate = +(supply_charges / volume.value).toFixed(6);
  }

  // Optional savings estimate if we have a reference offer/current rate
  // (env OR querystring; querystring handled later in /proposal)
  let current_rate = CURRENT_RATE ? +CURRENT_RATE : null;
  let offer_rate = OFFER_RATE ? +OFFER_RATE : null;

  let monthly_savings = null;
  let annual_savings = null;

  if (!current_rate && effective_supply_rate) current_rate = effective_supply_rate;

  if (volume.value && current_rate && offer_rate) {
    monthly_savings = +((current_rate - offer_rate) * volume.value).toFixed(2);
    annual_savings = +(monthly_savings * 12).toFixed(2);
  }

  return {
    utility,
    account_number,
    billing_period: { start, end },

    totals: {
      total_due,
      delivery_charges,
      supply_charges,
      taxes,
    },

    usage, // raw usage we found
    volume, // chosen unit/value for “monthly volume”
    rates: {
      effective_supply_rate, // from the bill if we could compute it
      current_rate: current_rate ?? null,
      offer_rate: offer_rate ?? null,
    },
    savings_estimate: {
      monthly_savings,
      annual_savings,
      basis: volume.value && (offer_rate || effective_supply_rate) ? "supply-only" : null,
    },

    meta: {
      parsed_at: new Date().toISOString(),
      confidence: "heuristic",
      notes: "Generic patterns; add utility-specific rules over time for better accuracy."
    }
  };
}

async function sendEmail(subject, html) {
  if (!canEmail) return { sent: false, reason: "Email env vars not set" };

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from: FROM_EMAIL || SMTP_USER,
    to: TO_EMAIL,
    replyTo: REPLY_TO_EMAIL || undefined,
    subject,
    html,
  });

  return { sent: true, messageId: info.messageId };
}

// ---------- Routes ----------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  const base = APP_BASE_URL || "";
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wattly Bill Audit</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif;background:#0b0b0c;color:#eee;margin:0}
  .wrap{max-width:900px;margin:32px auto;padding:16px}
  h1{font-size:24px;margin:0 0 12px}
  .box{background:#16161a;border:1px solid #26262b;border-radius:12px;padding:16px;margin:16px 0}
  label{display:block;margin:8px 0 4px}
  input,button{font:inherit}
  input[type=file]{width:100%}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  .row>*{flex:1 1 160px}
  button{background:#f6c945;border:0;border-radius:10px;padding:10px 14px;font-weight:600}
  small{opacity:.75}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Wattly Bill Audit</h1>
    <div class="box">
      <form action="/proposal" method="post" enctype="multipart/form-data">
        <label>Upload your bill PDF</label>
        <input type="file" name="bill" accept=".pdf" required>
        <div class="row">
          <div>
            <label>Offer supply rate (optional)</label>
            <input name="offer_rate" type="number" step="0.000001" placeholder="e.g. 0.6900" style="width:100%">
          </div>
          <div>
            <label>Current rate (optional)</label>
            <input name="current_rate" type="number" step="0.000001" placeholder="leave blank to infer" style="width:100%">
          </div>
        </div>
        <p style="margin-top:12px">
          <button type="submit">Upload & Analyze</button>
        </p>
        <small>Tip: We try to infer volume (therms/ccf/kWh) and an effective supply rate from your bill.</small>
      </form>
    </div>
    <div class="box">
      <small>API: POST <code>${base}/proposal</code> with <code>multipart/form-data</code> field <code>bill</code> (PDF). You can also send fields <code>offer_rate</code> and <code>current_rate</code>.</small>
    </div>
  </div>
</body>
</html>`);
});

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'bill'." });
    }
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) {
      return res.status(400).json({ error: "Please upload a PDF file." });
    }

    const parsed = await pdfParse(file.data);
    const text = parsed.text || "";
    if (!text.trim()) {
      return res.status(422).json({ error: "Could not extract text from PDF." });
    }

    // Build audit
    const audit = auditFromText(text);

    // Allow per-request rates to override env for savings calc
    const qOffer = req.body.offer_rate ? +req.body.offer_rate : null;
    const qCurrent = req.body.current_rate ? +req.body.current_rate : null;

    if (audit.volume.value) {
      const current = (qCurrent ?? audit.rates.current_rate);
      const offer = (qOffer ?? audit.rates.offer_rate);
      if (current && offer) {
        const monthly = +((current - offer) * audit.volume.value).toFixed(2);
        audit.savings_estimate.monthly_savings = monthly;
        audit.savings_estimate.annual_savings = +(monthly * 12).toFixed(2);
        audit.savings_estimate.basis = "supply-only";
        audit.rates.current_rate = current;
        audit.rates.offer_rate = offer;
      }
    }

    // Optional email
    let emailResult = { sent: false };
    if (canEmail) {
      const pretty = `<pre style="white-space:pre-wrap;font-size:13px">${JSON.stringify(audit, null, 2)}</pre>`;
      const subjectParts = [
        "Wattly Bill Audit",
        audit.utility || null,
        audit.account_number ? `Acct ${audit.account_number}` : null
      ].filter(Boolean);
      emailResult = await sendEmail(subjectParts.join(" – "), `<h3>Bill Audit</h3>${pretty}`);
    }

    res.json({ ok: true, audit, email: emailResult });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

// ---------- Start ----------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
