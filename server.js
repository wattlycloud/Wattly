// server.js
// Minimal bill-audit API for Render (Node/Express + pdf-parse)

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

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
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (labels.length) {
    const labelRegex = new RegExp(labels.join("|"), "i");
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }
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
  if (/pge\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/duke energy/i.test(text)) return "Duke Energy";
  if (/sdge|san diego gas/i.test(text)) return "SDG&E";
  if (/southern california edison|sce/i.test(text)) return "SCE";
  return firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,40})\s+(Bill|Invoice|Statement)/m) || "Unknown Utility";
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
  const gasTherms = firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*therms?/i)
    || firstMatch(text, /Usage\s*[:\-]?\s*(\d+)\s*therms?/i);
  const kwh = firstMatch(text, /(\d{2,6})\s*kWh\b/i);
  return {
    gas_therms: gasTherms ? parseInt(gasTherms, 10) : null,
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
  };
}

function parseAccount(text) {
  return (
    firstMatch(text, /Account\s+(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
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
  ]);
  const supply_charges = findMoney(text, [
    "supply charges",
    "generation",
    "energy supply",
    "gas supply",
  ]);
  const taxes = findMoney(text, ["sales tax", "tax", "grt"]);

  const usage = parseUsage(text);

  return {
    utility,
    account_number,
    billing_period: { start, end },
    totals: { total_due, delivery_charges, supply_charges, taxes },
    usage,
    meta: {
      parsed_at: new Date().toISOString(),
      confidence: "low/heuristic",
    },
    _notes: "For best accuracy, add vendor-specific patterns over time."
  };
}

// ---------- Routes ----------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wattly Bill Audit</title>
<style>
  body{background:#0b0b0d;color:#eee;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0}
  .wrap{max-width:940px;margin:32px auto;padding:0 16px}
  .card{background:#121214;border:1px solid #23232a;border-radius:12px;padding:18px}
  label{display:block;margin:8px 0 6px;color:#c9c9d1}
  input[type=file],input[type=text]{width:100%;background:#0e0e12;color:#eee;border:1px solid #2a2a33;border-radius:8px;padding:10px}
  button{background:#ffd36a;border:0;border-radius:10px;padding:12px 16px;font-weight:600}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Wattly Bill Audit</h1>
    <div class="card">
      <form action="/proposal" method="post" enctype="multipart/form-data">
        <label>Upload your bill PDF</label>
        <input type="file" name="bill" accept=".pdf" required>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div>
            <label>Offer supply rate (optional)</label>
            <input type="text" name="offer_rate" placeholder="e.g. 0.6900">
          </div>
          <div>
            <label>Current rate (optional)</label>
            <input type="text" name="current_rate" placeholder="leave blank to infer">
          </div>
        </div>
        <div style="margin-top:14px"><button type="submit">Upload & Analyze</button></div>
      </form>
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

    const audit = auditFromText(text);
    res.json({ ok: true, audit });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

// ---------- Start ----------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
