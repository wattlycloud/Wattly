// server.js
// Minimal, Render-ready bill audit API (JSON only)
// - POST /proposal  (multipart/form-data with field "bill") -> JSON audit + savings math
// - GET  /healthz   -> "ok"
// Optional body fields: offer_rate, current_rate (numbers). If current_rate absent, we try to infer.

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");

const app = express();
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

// ---------------- Middleware ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    useTempFiles: false,
    abortOnLimit: true,
  })
);

// ---------------- Helpers: generic parsing ----------------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function findMoney(text, labels = []) {
  // Look for dollar amounts near specific labels; fallback to largest dollar value.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (labels.length) {
    const re = new RegExp(labels.join("|"), "i");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }
  let max = null;
  const all = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g) || [];
  for (const s of all) {
    const v = parseFloat(s.replace(/[$,\s]/g, ""));
    if (!isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function guessUtility(text) {
  if (/con\s*ed(ison)?/i.test(text)) return "Con Edison";
  if (/southern california edison|sce/i.test(text)) return "SCE";
  if (/pge\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/duke energy/i.test(text)) return "Duke Energy";
  if (/sdge|san diego gas/i.test(text)) return "SDG&E";
  if (/pse&g|pseg/i.test(text)) return "PSE&G";
  if (/eversource/i.test(text)) return "Eversource";
  if (/peco/i.test(text)) return "PECO";
  if (/comed/i.test(text)) return "ComEd";
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
  const kwh = firstMatch(text, /(\d{2,7})\s*kWh\b/i);
  const gasTherms =
    firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*therms?/i) ||
    firstMatch(text, /(\d{2,7})\s*therms?\b/i);
  const gasCcf =
    firstMatch(text, /Total\s+usage\s+in\s+ccf\s+(\d+)/i) ||
    firstMatch(text, /\b(\d{2,7})\s*ccf\b/i);
  return {
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
    gas_therms: gasTherms ? parseInt(gasTherms, 10) : null,
    gas_ccf: gasCcf ? parseInt(gasCcf, 10) : null,
  };
}

function parseAccount(text) {
  return (
    firstMatch(text, /Account\s+(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
}

function buildAudit(text) {
  const utility = guessUtility(text);
  const account_number = parseAccount(text);
  const period = parseDates(text);

  const totals = {
    total_due: findMoney(text, ["Total amount due", "Amount due", "Current balance due", "Total due"]),
    delivery_charges: findMoney(text, ["delivery charges", "distribution", "basic service charge"]),
    supply_charges: findMoney(text, ["supply charges", "generation", "energy supply", "gas supply"]),
    taxes: findMoney(text, ["sales tax", "tax", "grt"]),
  };

  const usage = parseUsage(text);

  return {
    utility,
    account_number,
    billing_period: period,
    totals,
    usage,
    meta: {
      parsed_at: new Date().toISOString(),
      confidence: "heuristic",
    },
    _notes: "Generic patterns; add utility-specific rules for higher accuracy over time.",
  };
}

// ---------------- Helpers: rates + savings math ----------------
const toNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Infer a "current supply rate" if not provided, using supply_charges / monthly_qty.
function inferCurrentRate(audit) {
  const supply = audit?.totals?.supply_charges;
  if (!supply) return null;
  // Prefer kWh, then therms, then ccf
  const u = audit?.usage || {};
  const qty =
    (u.electricity_kwh && Number(u.electricity_kwh)) ||
    (u.gas_therms && Number(u.gas_therms)) ||
    (u.gas_ccf && Number(u.gas_ccf)) ||
    null;
  if (!qty) return null;
  const r = supply / qty;
  return Number.isFinite(r) ? +r.toFixed(4) : null;
}

function savingsFor(qty, unit, currentRate, offerRate) {
  if (!qty || !currentRate || !offerRate) {
    return {
      unit,
      monthly_qty: qty || null,
      current_rate: currentRate || null,
      offer_rate: offerRate || null,
      monthly_cost_current: null,
      monthly_cost_offer: null,
      monthly_savings: null,
      annual_savings: null,
      term_savings: { "2yr": null, "3yr": null, "4yr": null, "5yr": null },
      math: ["Not enough info: need monthly qty, current_rate, and offer_rate."],
    };
  }
  const mCur = qty * currentRate;
  const mOff = qty * offerRate;
  const mSav = mCur - mOff;
  const ySav = mSav * 12;
  const mathLines = [
    `Monthly cost @ current: ${qty} × ${currentRate} = $${mCur.toFixed(2)}`,
    `Monthly cost @ offer:   ${qty} × ${offerRate} = $${mOff.toFixed(2)}`,
    `Monthly savings:        $${mSav.toFixed(2)}`,
    `Annual savings:         $${ySav.toFixed(2)}`,
  ];

  return {
    unit,
    monthly_qty: qty,
    current_rate: currentRate,
    offer_rate: offerRate,
    monthly_cost_current: +mCur.toFixed(2),
    monthly_cost_offer: +mOff.toFixed(2),
    monthly_savings: +mSav.toFixed(2),
    annual_savings: +ySav.toFixed(2),
    term_savings: {
      "2yr": +(ySav * 2).toFixed(2),
      "3yr": +(ySav * 3).toFixed(2),
      "4yr": +(ySav * 4).toFixed(2),
      "5yr": +(ySav * 5).toFixed(2),
    },
    math: mathLines,
  };
}

function buildSavings(audit, givenCurrentRate, givenOfferRate) {
  // Use one pair of rates for both commodities unless you later pass separate ones.
  const currentRate = toNum(givenCurrentRate) ?? inferCurrentRate(audit) ?? null;
  const offerRate = toNum(givenOfferRate) ?? null;

  const u = audit.usage || {};
  const kwh = u.electricity_kwh ? Number(u.electricity_kwh) : null;
  const thm = u.gas_therms ? Number(u.gas_therms) : null;
  const ccf = !thm && u.gas_ccf ? Number(u.gas_ccf) : null; // if only ccf present

  const electric = kwh ? savingsFor(kwh, "kWh", currentRate, offerRate) : null;
  const gas = thm
    ? savingsFor(thm, "therms", currentRate, offerRate)
    : ccf
    ? savingsFor(ccf, "ccf", currentRate, offerRate)
    : null;

  // Combined monthly/annual (only if both have numbers)
  const combined = (() => {
    const m =
      (electric?.monthly_savings || 0) + (gas?.monthly_savings || 0);
    const y = m * 12;
    if (!Number.isFinite(m)) return null;
    return {
      monthly_savings: +m.toFixed(2),
      annual_savings: +y.toFixed(2),
      term_savings: {
        "2yr": +(y * 2).toFixed(2),
        "3yr": +(y * 3).toFixed(2),
        "4yr": +(y * 4).toFixed(2),
        "5yr": +(y * 5).toFixed(2),
      },
    };
  })();

  // Pretty math block (end of response)
  const math_lines = ["=== Math Breakdown ==="];
  if (electric) {
    math_lines.push("");
    math_lines.push("[Electric]");
    math_lines.push(...electric.math);
  }
  if (gas) {
    math_lines.push("");
    math_lines.push("[Gas]");
    math_lines.push(...gas.math);
  }
  if (math_lines.length === 1) {
    math_lines.push("");
    math_lines.push("No usage quantities found to show math.");
  }

  return { current_rate_used: currentRate, offer_rate_used: offerRate, electric, gas, combined, math_lines };
}

// ---------------- Routes ----------------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  // Tiny helper page for manual testing
  res.status(200).send(`<!doctype html><meta charset="utf-8">
  <title>Wattly Audit (JSON)</title>
  <body style="font-family:system-ui;background:#0b0b0b;color:#eee;padding:24px">
    <h2>Wattly Bill Audit (JSON)</h2>
    <form action="/proposal" method="post" enctype="multipart/form-data">
      <p><input type="file" name="bill" accept=".pdf" required></p>
      <p>Offer rate (optional): <input name="offer_rate" placeholder="e.g. 0.149"></p>
      <p>Current rate (optional): <input name="current_rate" placeholder="leave blank to infer"></p>
      <p><button type="submit">Upload & Analyze</button></p>
    </form>
    <p style="opacity:.7">This endpoint returns JSON with the audit + savings math.</p>
  </body>`);
});

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res.status(400).json({ ok: false, error: "No file uploaded. Field name must be 'bill'." });
    }
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) {
      return res.status(400).json({ ok: false, error: "Please upload a PDF file." });
    }

    // Extract text
    const parsed = await pdfParse(file.data);
    const text = parsed.text || "";
    if (!text.trim()) {
      return res.status(422).json({ ok: false, error: "Could not extract text from PDF." });
    }

    // Build audit
    const audit = buildAudit(text);

    // Rates from client (optional)
    const offerRate = req.body.offer_rate ?? null;
    const currentRate = req.body.current_rate ?? null;

    // Savings (electric + gas + combined) with explicit math lines
    const savings = buildSavings(audit, currentRate, offerRate);

    // Response
    return res.json({
      ok: true,
      audit,
      savings,
    });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ ok: false, error: "Server error", detail: String(err.message || err) });
  }
});

// ---------------- Start ----------------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
