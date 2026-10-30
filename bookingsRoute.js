const router = require('express').Router();
const mongoose = require('mongoose');
const Table = require('./Table');
const TableBooking = require('./TableBooking');
const adminAuth = require('./authMiddleware');
const { ok, fail, serverError } = require('./respond');
const { sendEmail, sendSMS, esc } = require('./notify');
const { PHONE_RE, EMAIL_RE, isRealDate, todayStr } = require('./validate');

// Lunch + dinner service
const TIME_SLOTS = ['12:00', '13:00', '14:00', '15:00', '18:00', '19:00', '20:00', '21:00', '22:00'];
const MAX_ADVANCE_DAYS = 60;

const nowMinutes = () => new Date().getHours() * 60 + new Date().getMinutes();
const slotMinutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

function checkDate(date) {
  if (!isRealDate(date)) return 'Date must be in YYYY-MM-DD format';
  if (date < todayStr()) return 'Date cannot be in the past';
  const max = new Date();
  max.setDate(max.getDate() + MAX_ADVANCE_DAYS);
  if (new Date(`${date}T00:00:00`) > max) return `Bookings open up to ${MAX_ADVANCE_DAYS} days ahead`;
  return null;
}

// slot is in the past if the date is today and the time has passed
const slotPassed = (date, slot) => date === todayStr() && slotMinutes(slot) <= nowMinutes();

// GET /api/bookings/available?date=&timeSlot=&guests=
router.get('/bookings/available', async (req, res) => {
  try {
    const { date, timeSlot } = req.query;
    const guests = req.query.guests === undefined ? 1 : Number(req.query.guests);
    const dateErr = checkDate(String(date || ''));
    if (dateErr) return fail(res, 400, dateErr);
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) return fail(res, 400, 'Guests must be between 1 and 20');
    if (timeSlot && !TIME_SLOTS.includes(timeSlot)) return fail(res, 400, 'Invalid time slot');

    const tables = await Table.find({ isActive: true, capacity: { $gte: guests } }).sort({ capacity: 1, tableNumber: 1 }).lean();
    const taken = await TableBooking.find({ date, active: true, tableNumber: { $in: tables.map((t) => t.tableNumber) } }).lean();
    const takenSet = new Set(taken.map((b) => `${b.tableNumber}|${b.timeSlot}`));

    const freeFor = (slot) => tables.filter((t) => !takenSet.has(`${t.tableNumber}|${slot}`));
    const slots = TIME_SLOTS.map((slot) => {
      const free = slotPassed(date, slot) ? [] : freeFor(slot);
      return { timeSlot: slot, available: free.length > 0, availableTables: free.length };
    });

    const data = { date, guests, slots };
    if (timeSlot) data.tables = slotPassed(date, timeSlot) ? [] : freeFor(timeSlot).map((t) => ({ tableNumber: t.tableNumber, capacity: t.capacity }));
    return ok(res, data);
  } catch (e) {
    return serverError(res, e);
  }
});

// POST /api/bookings — the partial unique index on {tableNumber,date,timeSlot} (active only) prevents double-booking.
router.post('/bookings', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const date = String(b.date || '');
    const timeSlot = String(b.timeSlot || '');
    const guests = Number(b.guests);
    const specialRequest = String(b.specialRequest || '').trim().slice(0, 300);

    const errors = [];
    if (name.length < 2 || name.length > 60) errors.push('Name must be 2-60 characters');
    if (!PHONE_RE.test(phone)) errors.push('Enter a valid 10-digit mobile number');
    if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address');
    const dateErr = checkDate(date);
    if (dateErr) errors.push(dateErr);
    if (!TIME_SLOTS.includes(timeSlot)) errors.push('Invalid time slot');
    else if (!dateErr && slotPassed(date, timeSlot)) errors.push('That time slot has already passed');
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) errors.push('Guests must be between 1 and 20');
    if (errors.length) return fail(res, 400, errors[0], errors);

    const tables = await Table.find({ isActive: true, capacity: { $gte: guests } }).sort({ capacity: 1, tableNumber: 1 }).lean();
    if (!tables.length) return fail(res, 400, 'We have no table that large. Please call us for big groups.');

    const taken = await TableBooking.find({ date, timeSlot, active: true }).lean();
    const takenSet = new Set(taken.map((x) => x.tableNumber));
    const candidates = tables.filter((t) => !takenSet.has(t.tableNumber));

    // Smallest suitable table first. If a concurrent request grabs it, the unique index throws 11000 and we try the next.
    for (const t of candidates) {
      try {
        const booking = await TableBooking.create({ name, phone, email, date, timeSlot, guests, specialRequest, tableNumber: t.tableNumber });
        sendEmail(
          email,
          `Booking request ${booking.bookingId} received`,
          `<h2>Hi ${esc(name)},</h2><p>We received your request for ${guests} on ${date} at ${timeSlot}. We'll confirm shortly.</p><p>Booking ID: <b>${booking.bookingId}</b></p>`
        );
        sendSMS(phone, `Booking ${booking.bookingId} for ${guests} on ${date} ${timeSlot} received. We'll confirm shortly.`);
        return ok(res, booking, 201);
      } catch (e) {
        if (e.code === 11000) continue;
        throw e;
      }
    }
    return fail(res, 409, 'Sorry, that slot just filled up. Please pick another time.');
  } catch (e) {
    return serverError(res, e);
  }
});

// GET /api/admin/bookings?status=&date=
router.get('/admin/bookings', adminAuth, async (req, res) => {
  try {
    const filter = {};
    if (['pending', 'confirmed', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.date) {
      if (!isRealDate(String(req.query.date))) return fail(res, 400, 'Invalid date');
      filter.date = req.query.date;
    }
    const bookings = await TableBooking.find(filter).sort({ date: 1, timeSlot: 1 }).lean();
    return ok(res, bookings);
  } catch (e) {
    return serverError(res, e);
  }
});

// PUT /api/admin/bookings/:id — confirm / cancel (cancelling frees the table via active=false)
router.put('/admin/bookings/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['confirmed', 'cancelled'].includes(status)) return fail(res, 400, 'Status must be confirmed or cancelled');
    const id = req.params.id;
    const booking = mongoose.isValidObjectId(id) ? await TableBooking.findById(id) : await TableBooking.findOne({ bookingId: id.toUpperCase() });
    if (!booking) return fail(res, 404, 'Booking not found');
    if (booking.status === 'cancelled') return fail(res, 400, 'A cancelled booking cannot be changed. Ask the guest to book again.');

    booking.status = status;
    await booking.save();
    const word = status === 'confirmed' ? 'confirmed' : 'cancelled';
    sendEmail(booking.email, `Booking ${booking.bookingId} ${word}`, `<p>Hi ${esc(booking.name)}, your booking for ${booking.date} at ${booking.timeSlot} is <b>${word}</b>.</p>`);
    sendSMS(booking.phone, `Booking ${booking.bookingId} (${booking.date} ${booking.timeSlot}) is ${word}.`);
    return ok(res, booking);
  } catch (e) {
    return serverError(res, e);
  }
});

module.exports = router;
