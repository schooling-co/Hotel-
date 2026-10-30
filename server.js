require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
  console.error('Missing MONGODB_URI or JWT_SECRET. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

const origins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map((s) => s.trim());
const corsOptions = { origin: origins, credentials: true };

// Socket.io: only authenticated admins may connect
const io = new Server(server, { cors: corsOptions });
io.use((socket, next) => {
  try {
    socket.admin = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});
io.on('connection', (socket) => socket.join('admins'));
app.set('io', io);

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok' }));
app.use('/api/auth', require('./authRoute'));
app.use('/api/menu', require('./menuRoute'));
app.use('/api', require('./ordersRoute'));
app.use('/api', require('./bookingsRoute'));

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Consistent JSON errors for anything that slips through (bad JSON, multer, etc.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  if (err.name === 'MulterError' || err.message?.startsWith('Only JPEG')) return res.status(400).json({ success: false, message: err.message });
  if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: err.message });
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    await mongoose.model('TableBooking').init(); // make sure the unique index exists before taking bookings
    server.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('MongoDB connection failed:', e.message);
    process.exit(1);
  });
