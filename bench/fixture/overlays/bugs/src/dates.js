// Dates are "YYYY-MM-DD" strings; comparisons are lexicographic on purpose
// so no timezone is ever involved.
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(s) {
  const m = RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function monthOf(date) {
  return date.slice(0, 7);
}

// Inclusive on both ends. undefined means open.
export function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date >= to) return false;
  return true;
}
