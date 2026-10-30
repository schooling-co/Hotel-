const mongoose = require('mongoose');

module.exports = mongoose.model(
  'Table',
  new mongoose.Schema({
    tableNumber: { type: Number, required: true, unique: true },
    capacity: { type: Number, required: true, min: 1 },
    isActive: { type: Boolean, default: true },
  })
);
