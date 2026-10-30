require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const MenuItem = require('./MenuItem');
const Table = require('./Table');
const Admin = require('./Admin');

const img = (label) => `https://placehold.co/600x400/FFF8F0/E63946?text=${encodeURIComponent(label)}`;
// Replace these with your own Cloudinary URLs later via the admin panel.

const menu = [
  ['Paneer Tikka', 'Smoky tandoor-grilled cottage cheese with peppers and mint chutney', 280, 'starter', true, 15],
  ['Chicken 65', 'Crispy South Indian fried chicken tossed with curry leaves and chilli', 320, 'starter', false, 18],
  ['Veg Seekh Kebab', 'Spiced vegetable and lentil kebabs grilled on skewers', 260, 'starter', true, 15],
  ['Amritsari Fish Fry', 'Gram-flour battered fish with ajwain and tangy spices', 380, 'starter', false, 20],
  ['Butter Chicken', 'Tandoori chicken in a rich tomato-butter gravy', 420, 'main', false, 25],
  ['Paneer Butter Masala', 'Cottage cheese cubes in a creamy tomato gravy', 360, 'main', true, 20],
  ['Dal Makhani', 'Slow-cooked black lentils finished with cream and butter', 300, 'main', true, 25],
  ['Hyderabadi Chicken Biryani', 'Dum-cooked basmati rice layered with marinated chicken', 400, 'main', false, 30],
  ['Veg Biryani', 'Fragrant basmati rice with seasonal vegetables and saffron', 320, 'main', true, 28],
  ['Garlic Naan', 'Tandoor-baked flatbread brushed with garlic butter', 70, 'main', true, 10],
  ['Gulab Jamun', 'Warm milk dumplings soaked in cardamom syrup (2 pcs)', 120, 'dessert', true, 8],
  ['Rasmalai', 'Soft paneer discs in saffron-pistachio milk (2 pcs)', 150, 'dessert', true, 8],
  ['Masala Chai', 'Ginger-cardamom tea brewed with milk', 60, 'drink', true, 5],
  ['Sweet Lassi', 'Thick chilled yoghurt drink with a hint of rose', 110, 'drink', true, 5],
  ['Fresh Lime Soda', 'Sweet, salted or mixed', 90, 'drink', true, 4],
].map(([name, description, price, category, isVeg, preparationTime]) => ({
  name, description, price, category, isVeg, preparationTime, isAvailable: true, image: img(name),
}));

const tables = [
  { tableNumber: 1, capacity: 2 },
  { tableNumber: 2, capacity: 2 },
  { tableNumber: 3, capacity: 4 },
  { tableNumber: 4, capacity: 4 },
  { tableNumber: 5, capacity: 6 },
  { tableNumber: 6, capacity: 8 },
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    await Promise.all([MenuItem.deleteMany({}), Table.deleteMany({}), Admin.deleteMany({})]);
    await MenuItem.insertMany(menu);
    await Table.insertMany(tables);

    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@restaurant.com').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
    await Admin.create({ email, passwordHash: await bcrypt.hash(password, 12) });

    // Make sure indexes (incl. the booking double-booking guard) exist
    await mongoose.model('TableBooking').init();

    console.log(`Seeded ${menu.length} menu items, ${tables.length} tables.`);
    console.log(`Admin login: ${email} / ${password}  (change this before going live!)`);
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exit(1);
  }
})();
