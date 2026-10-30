const mongoose = require('mongoose');
const Counter = mongoose.model('Counter', new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }));

// Atomic, race-safe sequence generator
Counter.next = async (key) => (await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, upsert: true })).seq;

module.exports = Counter;
