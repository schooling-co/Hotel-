const PHONE_RE = /^[6-9]\d{9}$/; // Indian 10-digit mobile
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const isRealDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !isNaN(d) && `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === s;
};

module.exports = { PHONE_RE, EMAIL_RE, DATE_RE, todayStr, isRealDate };
