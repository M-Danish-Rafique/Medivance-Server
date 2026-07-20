const PKT_TZ = 'Asia/Karachi';

function toDate(value = new Date()) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Date-only strings as UTC midnight → same calendar day in PKT (UTC+5)
    return new Date(`${value}T00:00:00Z`);
  }
  return new Date(value);
}

function getPKTParts(date = new Date()) {
  const baseDate = toDate(date);
  if (Number.isNaN(baseDate.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PKT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(baseDate);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** YYYY-MM-DD in Asia/Karachi */
function todayPKT(date = new Date()) {
  const p = getPKTParts(date);
  if (!p) return null;
  return `${p.year}-${p.month}-${p.day}`;
}

/** DD/MM/YYYY in Asia/Karachi */
function formatDatePKT(dateValue) {
  if (!dateValue && dateValue !== 0) return '—';
  const p = getPKTParts(dateValue);
  if (!p) return '—';
  return `${p.day}/${p.month}/${p.year}`;
}

/** DD/MM/YYYY, HH:MM:SS in Asia/Karachi */
function formatDateTimePKT(dateValue = new Date()) {
  const p = getPKTParts(dateValue);
  if (!p) return '—';
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}

/** MySQL DATETIME string in Asia/Karachi */
function nowPKT(date = new Date()) {
  const p = getPKTParts(date);
  if (!p) return null;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function yearPKT(date = new Date()) {
  const p = getPKTParts(date);
  return p ? Number(p.year) : NaN;
}

function monthPKT(date = new Date()) {
  const p = getPKTParts(date);
  return p ? Number(p.month) : NaN;
}

function dayPKT(date = new Date()) {
  const p = getPKTParts(date);
  return p ? Number(p.day) : NaN;
}

/** Add calendar months to a date; returns YYYY-MM-DD (PKT calendar). */
function addMonthsPKT(dateValue, months) {
  const str =
    typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateValue)
      ? dateValue.slice(0, 10)
      : todayPKT(dateValue);
  if (!str) return null;

  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

module.exports = {
  PKT_TZ,
  todayPKT,
  formatDatePKT,
  formatDateTimePKT,
  nowPKT,
  yearPKT,
  monthPKT,
  dayPKT,
  addMonthsPKT,
};
