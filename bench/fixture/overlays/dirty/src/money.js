// Amounts are integer cents everywhere inside the program.

// "12.50" -> 1250, "1,234.5" -> 123450, "-3" -> -300
export function parseAmount(text) {
  const cleaned = String(text).replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`invalid amount: ${text}`);
  }
  return Math.round(parseFloat(cleaned) * 100);
}

// 123450 -> "1,234.50", -50 -> "-0.50"; with { currency: "$" } -> "-$0.50"
export function formatAmount(cents, { currency = "" } = {}) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${currency}${whole}.${frac}`;
}
