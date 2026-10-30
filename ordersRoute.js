const router = require('express').Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const MenuItem = require('./MenuItem');
const Order = require('./Order');
const Table = require('./Table');
const adminAuth = require('./authMiddleware');
const { ok, fail, serverError } = require('./respond');
const { sendEmail, sendSMS, esc } = require('./notify');
const { PHONE_RE, EMAIL_RE } = require('./validate');

const ORDER_TYPES = ['delivery', 'pickup', 'dine-in'];
const PAYMENT_METHODS = ['online', 'cod'];
const ORDER_STATUSES = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['pending', 'paid', 'failed'];

const DELIVERY_FEE = Number(process.env.DELIVERY_FEE ?? 40);
const FREE_DELIVERY_ABOVE = Number(process.env.FREE_DELIVERY_ABOVE ?? 500);
const TAX_RATE = Number(process.env.TAX_RATE ?? 0.05);
const round2 = (n) => Math.round(n * 100) / 100;

let rzpClient;
const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  return (rzpClient ||= new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }));
};

// Fire-and-forget customer notifications + admin socket event
function announce(req, order, event = 'new-order') {
  req.app.get('io')?.to('admins').emit(event, order.toObject ? order.toObject() : order);
  if (event !== 'new-order') return;
  const summary = order.items.map((i) => `${esc(i.name)} x${i.quantity}`).join(', ');
  sendEmail(
    order.customer.email,
    `Order ${order.orderId} received`,
    `<h2>Thanks, ${esc(order.customer.name)}!</h2><p>Order <b>${order.orderId}</b>: ${summary}</p><p>Total: ₹${order.total}</p>`
  );
  sendSMS(order.customer.phone, `Order ${order.orderId} received. Total Rs.${order.total}. Thank you!`);
}

// ---------- PUBLIC ----------

// POST /api/orders/create — prices are ALWAYS read from the DB; any totals from the client are ignored.
router.post('/orders/create', async (req, res) => {
  try {
    const { customer = {}, items, orderType, tableNumber, deliveryAddress, paymentMethod } = req.body || {};
    const errors = [];

    const name = String(customer.name || '').trim();
    const phone = String(customer.phone || '').trim();
    const email = String(customer.email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 60) errors.push('Name must be 2-60 characters');
    if (!PHONE_RE.test(phone)) errors.push('Enter a valid 10-digit mobile number');
    if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address');
    if (!ORDER_TYPES.includes(orderType)) errors.push('Invalid order type');
    if (!PAYMENT_METHODS.includes(paymentMethod)) errors.push('Invalid payment method');

    // Merge duplicate lines and validate quantities
    const qtyById = new Map();
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      errors.push('Cart must contain 1-50 items');
    } else {
      for (const it of items) {
        const q = Number(it?.quantity);
        if (!mongoose.isValidObjectId(it?.menuItemId)) errors.push('Invalid menu item');
        else if (!Number.isInteger(q) || q < 1 || q > 20) errors.push('Quantity must be a whole number between 1 and 20');
        else qtyById.set(String(it.menuItemId), (qtyById.get(String(it.menuItemId)) || 0) + q);
      }
    }

    let cleanAddress;
    let cleanTable;
    if (orderType === 'delivery') {
      cleanAddress = String(deliveryAddress || '').trim();
      if (cleanAddress.length < 10 || cleanAddress.length > 300) errors.push('Delivery address must be 10-300 characters');
    }
    if (orderType === 'dine-in') {
      cleanTable = Number(tableNumber);
      if (!Number.isInteger(cleanTable) || cleanTable < 1) errors.push('Table number is required for dine-in');
      else if (!(await Table.exists({ tableNumber: cleanTable, isActive: true }))) errors.push('Unknown table number');
    }
    if (errors.length) return fail(res, 400, errors[0], errors);

    const rzp = getRazorpay();
    if (paymentMethod === 'online' && !rzp) return fail(res, 503, 'Online payments are not configured');

    // Authoritative prices from DB
    const dbItems = await MenuItem.find({ _id: { $in: [...qtyById.keys()] } }).lean();
    const dbMap = new Map(dbItems.map((d) => [String(d._id), d]));
    const lineItems = [];
    for (const [id, quantity] of qtyById) {
      const d = dbMap.get(id);
      if (!d) return fail(res, 400, 'Some items in your cart no longer exist. Please refresh your cart.');
      if (!d.isAvailable) return fail(res, 400, `"${d.name}" is currently unavailable`);
      lineItems.push({ menuItemId: d._id, name: d.name, price: d.price, quantity });
    }

    const subtotal = round2(lineItems.reduce((s, i) => s + i.price * i.quantity, 0));
    const deliveryFee = orderType === 'delivery' && subtotal < FREE_DELIVERY_ABOVE ? DELIVERY_FEE : 0;
    const tax = round2(subtotal * TAX_RATE);
    const total = round2(subtotal + deliveryFee + tax);

    const order = await Order.create({
      customer: { name, phone, email },
      items: lineItems,
      orderType,
      tableNumber: cleanTable,
      deliveryAddress: cleanAddress,
      subtotal,
      deliveryFee,
      tax,
      total,
      paymentMethod,
    });

    if (paymentMethod === 'cod') {
      announce(req, order);
      return ok(res, { orderId: order.orderId, total }, 201);
    }

    // Online: create Razorpay order (amount in paise)
    try {
      const rzpOrder = await rzp.orders.create({
        amount: Math.round(total * 100),
        currency: 'INR',
        receipt: order.orderId,
        notes: { orderId: order.orderId },
      });
      order.razorpayOrderId = rzpOrder.id;
      await order.save();
      return ok(
        res,
        {
          orderId: order.orderId,
          total,
          razorpay: { orderId: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency, keyId: process.env.RAZORPAY_KEY_ID },
        },
        201
      );
    } catch (e) {
      await Order.deleteOne({ _id: order._id }); // don't leave an unpayable order behind
      console.error('Razorpay order creation failed:', e);
      return fail(res, 502, 'Could not start payment. Please try again.');
    }
  } catch (e) {
    return serverError(res, e);
  }
});

// POST /api/orders/verify — marks paid ONLY after HMAC signature check passes.
router.post('/orders/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every((v) => typeof v === 'string' && v)) {
      return fail(res, 400, 'Missing payment details');
    }
    if (!process.env.RAZORPAY_KEY_SECRET) return fail(res, 503, 'Online payments are not configured');

    const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
    if (!order) return fail(res, 404, 'Order not found');
    if (order.paymentStatus === 'paid') return ok(res, { orderId: order.orderId, paymentStatus: 'paid' }); // idempotent

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(razorpay_signature);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!valid) {
      order.paymentStatus = 'failed';
      await order.save();
      return fail(res, 400, 'Payment verification failed');
    }

    order.paymentStatus = 'paid';
    order.razorpayPaymentId = razorpay_payment_id;
    if (order.orderStatus === 'placed') order.orderStatus = 'confirmed';
    await order.save();
    announce(req, order);
    return ok(res, { orderId: order.orderId, paymentStatus: 'paid' });
  } catch (e) {
    return serverError(res, e);
  }
});

// GET /api/orders/:orderId — public tracking. Order IDs are sequential, so only non-sensitive fields are returned.
router.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: String(req.params.orderId).toUpperCase() }).lean();
    if (!order) return fail(res, 404, 'Order not found');
    const first = order.customer.name.split(' ')[0];
    return ok(res, {
      orderId: order.orderId,
      customerFirstName: first,
      items: order.items.map(({ name, price, quantity }) => ({ name, price, quantity })),
      orderType: order.orderType,
      tableNumber: order.tableNumber,
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      tax: order.tax,
      total: order.total,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      createdAt: order.createdAt,
    });
  } catch (e) {
    return serverError(res, e);
  }
});

// ---------- ADMIN ----------

// GET /api/admin/orders?status=&orderType=&paymentStatus=&from=&to=&search=&page=&limit=
router.get('/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status, orderType, paymentStatus, from, to, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const filter = {};
    if (status && ORDER_STATUSES.includes(status)) filter.orderStatus = status;
    if (orderType && ORDER_TYPES.includes(orderType)) filter.orderType = orderType;
    if (paymentStatus && PAYMENT_STATUSES.includes(paymentStatus)) filter.paymentStatus = paymentStatus;
    if (from || to) {
      filter.createdAt = {};
      if (from && !isNaN(new Date(from))) filter.createdAt.$gte = new Date(from);
      if (to && !isNaN(new Date(to))) filter.createdAt.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }
    if (search) {
      const s = String(search).trim();
      const safe = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ orderId: new RegExp(safe, 'i') }, { 'customer.phone': new RegExp(safe) }, { 'customer.name': new RegExp(safe, 'i') }];
    }
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);
    return ok(res, orders, 200, { pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) {
    return serverError(res, e);
  }
});

// GET /api/admin/stats — today's revenue, order count, top items (last 30 days)
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    // Revenue counts orders that are paid online, or COD orders not cancelled
    const counted = { orderStatus: { $ne: 'cancelled' }, $or: [{ paymentStatus: 'paid' }, { paymentMethod: 'cod' }] };

    const [today] = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lt: end }, ...counted } },
      { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    ]);
    const topItems = await Order.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 86400000) }, ...counted } },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
      { $sort: { quantity: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, name: '$_id', quantity: 1, revenue: 1 } },
    ]);
    const pending = await Order.countDocuments({ orderStatus: { $in: ['placed', 'confirmed', 'preparing'] } });
    return ok(res, { todayRevenue: round2(today?.revenue || 0), todayOrders: today?.orders || 0, activeOrders: pending, topItems });
  } catch (e) {
    return serverError(res, e);
  }
});

// PUT /api/admin/orders/:id — :id may be Mongo _id or orderId
router.put('/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { orderStatus, paymentStatus } = req.body || {};
    if (orderStatus === undefined && paymentStatus === undefined) return fail(res, 400, 'Nothing to update');
    if (orderStatus !== undefined && !ORDER_STATUSES.includes(orderStatus)) return fail(res, 400, 'Invalid order status');
    if (paymentStatus !== undefined && !PAYMENT_STATUSES.includes(paymentStatus)) return fail(res, 400, 'Invalid payment status');

    const id = req.params.id;
    const order = mongoose.isValidObjectId(id) ? await Order.findById(id) : await Order.findOne({ orderId: id.toUpperCase() });
    if (!order) return fail(res, 404, 'Order not found');

    // Online payments can only be marked paid via signature verification, never manually.
    if (paymentStatus === 'paid' && order.paymentMethod === 'online' && order.paymentStatus !== 'paid') {
      return fail(res, 400, 'Online orders can only be marked paid through payment verification');
    }
    if (paymentStatus !== undefined) order.paymentStatus = paymentStatus;
    if (orderStatus !== undefined) {
      order.orderStatus = orderStatus;
      if (orderStatus === 'delivered' && order.paymentMethod === 'cod') order.paymentStatus = 'paid'; // cash collected
    }
    await order.save();

    req.app.get('io')?.to('admins').emit('order-updated', order.toObject());
    if (orderStatus) {
      sendSMS(order.customer.phone, `Order ${order.orderId} is now: ${orderStatus.replace(/_/g, ' ')}.`);
    }
    return ok(res, order);
  } catch (e) {
    return serverError(res, e);
  }
});

module.exports = router;
