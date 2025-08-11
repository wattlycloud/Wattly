// ---------- Helpers ----------
const getMatch = (re, s, i = 1) => {
  const m = re.exec(s);
  return m ? m[i].trim().replace(/\s+/g, ' ') : null;
};
const moneyToNumber = (s) => {
  if (!s) return null;
  const n = s.replace(/[,$]/g, '');
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const numberFrom = (s) => {
  if (!s) return null;
  const n = s.replace(/[^\d.]/g, '');
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const parseDate = (s) => {
  if (!s) return null;
  // Try MMM DD, YYYY  or  MM/DD/YY
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0,10);
};

// ---------- Main Bill Parser ----------
function parseBillText(textRaw) {
  // Normalize spacing – but keep line breaks to help regex anchors
  const text = textRaw
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/ *\n */g, '\n');

  // 1) Top-level items commonly present on ConEd gas bills
  const account = getMatch(/Account\s*number:\s*([0-9\-]+)/i, text);
  const serviceAddress = getMatch(/Service\s+delivered\s+to:\s*([^\n]+)/i, text);
  const totalDue = moneyToNumber(getMatch(/Total (?:amount )?due\s*\$?([\d,]+\.\d{2})/i, text));

  // Billing period + days
  // e.g. "Billing period: Jan 26, 2023 to Feb 28, 2023 (33 days)"
  const billingRange = getMatch(/Billing period:\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})\s*to\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})(?:\s*\((\d+)\s*days?\))?/i, text);
  let startDate = null, endDate = null, days = null;
  if (billingRange) {
    const m = /Billing period:\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})\s*to\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})(?:\s*\((\d+)\s*days?\))?/i.exec(text);
    startDate = parseDate(m[1]);
    endDate   = parseDate(m[2]);
    days      = m[3] ? Number(m[3]) : null;
  }

  // 2) Usage – capture ccf, conversion factor, therms
  // e.g.:
  // "Total usage in ccf 119 ccf"
  // "Therm conversion factor 1.026"
  // "Total Gas Use 122 therms"
  const ccf = numberFrom(getMatch(/Total usage in ccf\s+(\d+(?:\.\d+)?)/i, text));
  const conv = numberFrom(getMatch(/Therm conversion factor\s+(\d+(?:\.\d+)?)/i, text));
  let therms = numberFrom(getMatch(/Total (?:Gas )?Use\s+(\d+(?:\.\d+)?)\s*therms?/i, text));
  if (!therms && ccf && conv) therms = +(ccf * conv).toFixed(2);

  // 3) Charges (delivery lines shown on ConEd delivery bill)
  const basicService = moneyToNumber(getMatch(/Basic service charge.*?\$([\d,]+\.\d{2})/i, text));
  const monthlyAdj   = moneyToNumber(getMatch(/Monthly rate adjustment.*?\$([\d,]+\.\d{2})/i, text));
  const remaining    = moneyToNumber(getMatch(/Remaining.*?\$([\d,]+\.\d{2})/i, text));
  const taxes        = moneyToNumber(getMatch(/GRT\s*&\s*other tax surcharges.*?\$([\d,]+\.\d{2})/i, text));
  const salesTax     = moneyToNumber(getMatch(/Sales tax.*?\$([\d,]+\.\d{2})/i, text));

  // 4) Average daily usage if not shown, compute from therms + days
  const avgDailyThermsExplicit = numberFrom(getMatch(/average daily gas usage\s*([\d.]+)\s*therms?/i, text));
  const avgDailyTherms = avgDailyThermsExplicit ?? (
    therms && days ? +(therms / days).toFixed(2) : null
  );

  // 5) Commodity guess
  const commodity = /gas/i.test(text) ? 'gas' : (/electric/i.test(text) ? 'electric' : null);

  return {
    utility: getMatch(/\bCon\s*Edison|ConEd|Consolidated\s+Edison/i, text) ? 'coned' :
             getMatch(/\bSCE\b|Southern California Edison/i, text) ? 'sce' : null,
    account,
    service_address: serviceAddress,
    billing_period: startDate && endDate ? { start: startDate, end: endDate, days } : null,
    total_due: totalDue,
    usage: {
      ccf: ccf ?? null,
      therms: therms ?? null,
      avg_daily_therms: avgDailyTherms ?? null,
      therm_conversion_factor: conv ?? null
    },
    charges: {
      basic_service: basicService ?? null,
      monthly_adjustment: monthlyAdj ?? null,
      remaining: remaining ?? null,
      taxes: taxes ?? null,
      sales_tax: salesTax ?? null
    },
    commodity: commodity || 'gas'
  };
}

// ---------- Audit formatter (adds “Volume” section) ----------
function buildAudit(parsed, pricing) {
  const { usage, commodity } = parsed;
  const therms = usage?.therms ?? null;
  const ccf = usage?.ccf ?? (therms && usage?.therm_conversion_factor
    ? +(therms / usage.therm_conversion_factor).toFixed(2)
    : null);
  const avg = usage?.avg_daily_therms ?? null;

  // pricing = { currentRate, offeredRate } — assumed you already have
  const monthlyVol = commodity === 'gas' ? (therms ?? ccf) : null; // therms preferred

  const monthlySavings =
    monthlyVol && pricing?.currentRate && pricing?.offeredRate
      ? +((pricing.currentRate - pricing.offeredRate) * monthlyVol).toFixed(2)
      : null;

  const annualSavings =
    monthlySavings != null ? +(monthlySavings * 12).toFixed(2) : null;

  return {
    rates: {
      current_supplier_rate: pricing?.currentRate ?? null,
      offered_supplier_rate: pricing?.offeredRate ?? null
    },
    volume: {
      commodity,
      therms,
      ccf,
      avg_daily_therms: avg,
      period_days: parsed?.billing_period?.days ?? null
    },
    savings: {
      monthly: monthlySavings,
      annual: annualSavings
    },
    details: parsed
  };
}
