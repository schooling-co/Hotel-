const router = require('express').Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { v2: cloudinary } = require('cloudinary');
const MenuItem = require('./MenuItem');
const adminAuth = require('./authMiddleware');
const { ok, fail, serverError } = require('./respond');

const CATEGORIES = ['starter', 'main', 'dessert', 'drink'];

const cloudinaryReady = () => !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryReady()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, WEBP or GIF images are allowed')),
});

const uploadToCloudinary = (buffer) =>
  new Promise((resolve, reject) =>
    cloudinary.uploader
      .upload_stream({ folder: 'restaurant/menu' }, (err, result) => (err ? reject(err) : resolve(result.secure_url)))
      .end(buffer)
  );

const toBool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

// Builds a validated payload from JSON or multipart body. `partial` allows PUT with only some fields.
function parseBody(body, partial) {
  const errors = [];
  const data = {};
  const has = (k) => body[k] !== undefined && body[k] !== '';

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) errors.push('name is required (max 100 chars)');
    data.name = name;
  }
  if (!partial || has('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push('price must be a number >= 0');
    data.price = price;
  }
  if (!partial || has('category')) {
    if (!CATEGORIES.includes(body.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
    data.category = body.category;
  }
  if (body.description !== undefined) data.description = String(body.description).trim().slice(0, 500);
  if (body.isVeg !== undefined) data.isVeg = toBool(body.isVeg);
  if (body.isAvailable !== undefined) data.isAvailable = toBool(body.isAvailable);
  if (has('preparationTime')) {
    const t = Number(body.preparationTime);
    if (!Number.isFinite(t) || t < 0) errors.push('preparationTime must be a number >= 0');
    data.preparationTime = t;
  }
  if (has('image') && typeof body.image === 'string') data.image = body.image.trim();
  return { data, errors };
}

const checkId = (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, 'Invalid menu item id');
    return false;
  }
  return true;
};

// GET /api/menu?category=main
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category && req.query.category !== 'all') {
      if (!CATEGORIES.includes(req.query.category)) return fail(res, 400, 'Invalid category');
      filter.category = req.query.category;
    }
    const items = await MenuItem.find(filter).sort({ category: 1, name: 1 }).lean();
    return ok(res, items);
  } catch (e) {
    return serverError(res, e);
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const item = await MenuItem.findById(req.params.id).lean();
    if (!item) return fail(res, 404, 'Menu item not found');
    return ok(res, item);
  } catch (e) {
    return serverError(res, e);
  }
});

router.post('/', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { data, errors } = parseBody(req.body, false);
    if (errors.length) return fail(res, 400, errors[0], errors);
    if (req.file) {
      if (!cloudinaryReady()) return fail(res, 503, 'Image upload is not configured (Cloudinary keys missing)');
      data.image = await uploadToCloudinary(req.file.buffer);
    }
    const item = await MenuItem.create(data);
    return ok(res, item, 201);
  } catch (e) {
    return serverError(res, e);
  }
});

router.put('/:id', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const { data, errors } = parseBody(req.body, true);
    if (errors.length) return fail(res, 400, errors[0], errors);
    if (req.file) {
      if (!cloudinaryReady()) return fail(res, 503, 'Image upload is not configured (Cloudinary keys missing)');
      data.image = await uploadToCloudinary(req.file.buffer);
    }
    const item = await MenuItem.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
    if (!item) return fail(res, 404, 'Menu item not found');
    return ok(res, item);
  } catch (e) {
    return serverError(res, e);
  }
});

router.delete('/:id', adminAuth, async (req, res) => {
  try {
    if (!checkId(req, res)) return;
    const item = await MenuItem.findByIdAndDelete(req.params.id);
    if (!item) return fail(res, 404, 'Menu item not found');
    return ok(res, { deleted: true });
  } catch (e) {
    return serverError(res, e);
  }
});

module.exports = router;
