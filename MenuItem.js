const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 500 },
  price: { type: Number, required: true, min: 0 },
  category: { type: String, required: true, enum: ['starter', 'main', 'dessert', 'drink'], index: true },
  image: { type: String, default: '' },
  isVeg: { type: Boolean, default: true },
  isAvailable: { type: Boolean, default: true },
  preparationTime: { type: Number, default: 15, min: 0 }, // minutes
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MenuItem', menuItemSchema);
