const mongoose = require('mongoose');
const Counter = require('./Counter');

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, index: true },
  customer: {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    _id: false,
  },
  items: [
    {
      menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
      name: { type: String, required: true },
      price: { type: Number, required: true },
      quantity: { type: Number, required: true, min: 1 },
      _id: false,
    },
  ],
  orderType: { type: String, required: true, enum: ['delivery', 'pickup', 'dine-in'] },
  tableNumber: { type: Number },
  deliveryAddress: { type: String },
  subtotal: { type: Number, required: true },
  deliveryFee: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  paymentMethod: { type: String, required: true, enum: ['online', 'cod'] },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  razorpayOrderId: { type: String, index: true, sparse: true },
  razorpayPaymentId: { type: String },
  orderStatus: {
    type: String,
    enum: ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'],
    default: 'placed',
  },
  createdAt: { type: Date, default: Date.now, index: true },
});

// ORD-YYYY-XXXX, sequence resets per year
orderSchema.pre('validate', async function () {
  if (this.orderId) return;
  const year = new Date().getFullYear();
  const seq = await Counter.next(`order-${year}`);
  this.orderId = `ORD-${year}-${String(seq).padStart(4, '0')}`;
});

module.exports = mongoose.model('Order', orderSchema);
