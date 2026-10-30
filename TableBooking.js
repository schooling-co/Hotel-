const mongoose = require('mongoose');
const Counter = require('./Counter');

const bookingSchema = new mongoose.Schema({
  bookingId: { type: String, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  date: { type: String, required: true }, // 'YYYY-MM-DD' (avoids timezone bugs)
  timeSlot: { type: String, required: true }, // 'HH:mm'
  guests: { type: Number, required: true, min: 1 },
  specialRequest: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['pending', 'confirmed', 'cancelled'], default: 'pending' },
  tableNumber: { type: Number, required: true },
  // true while status is pending/confirmed. Lets the unique index ignore cancelled bookings.
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// Race-condition guard: the DB itself rejects a second active booking for the same table+date+slot.
bookingSchema.index(
  { tableNumber: 1, date: 1, timeSlot: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

bookingSchema.pre('validate', async function () {
  this.active = this.status !== 'cancelled';
  if (!this.bookingId) {
    const seq = await Counter.next('booking');
    this.bookingId = `BKG-${String(seq).padStart(5, '0')}`;
  }
});

module.exports = mongoose.model('TableBooking', bookingSchema);
