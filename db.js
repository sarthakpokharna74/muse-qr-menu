const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'muse.db');
const db = new DatabaseSync(DB_PATH);

// Helper for hashing passwords/pins
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret).trim()).digest('hex');
}

function initDb() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER UNIQUE,
      qr_token TEXT UNIQUE,
      active INTEGER DEFAULT 1,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      section TEXT,
      description TEXT,
      price REAL NOT NULL,
      available INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      pin_hash TEXT,
      points INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 5,
      note TEXT,
      dob TEXT,
      birthday TEXT,
      age INTEGER,
      since TEXT,
      last_visit TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_points_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      mode TEXT,
      amount INTEGER,
      reason TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER UNIQUE NOT NULL,
      table_id INTEGER REFERENCES tables(id),
      table_number INTEGER NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      customer_name TEXT,
      customer_phone TEXT,
      status TEXT NOT NULL, -- 'open', 'received', 'served', 'done', 'cancelled'
      subtotal REAL NOT NULL,
      discount REAL DEFAULT 0,
      savings TEXT,
      total REAL NOT NULL,
      points_earned INTEGER DEFAULT 0,
      points_used INTEGER DEFAULT 0,
      note TEXT,
      flags TEXT,
      cancel_reason TEXT,
      seen INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      item_id INTEGER,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price REAL NOT NULL,
      free INTEGER DEFAULT 0,
      note TEXT,
      line_total REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      discount_type TEXT NOT NULL, -- 'percent', 'flat', 'free_item', 'none'
      discount_value REAL DEFAULT 0,
      max_item_price REAL,
      min_bill REAL DEFAULT 0,
      limit_rule TEXT DEFAULT 'none',
      days TEXT DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
      start_time TEXT,
      end_time TEXT,
      start_date TEXT,
      end_date TEXT,
      categories TEXT,
      applies_to TEXT DEFAULT 'Whole order',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT,
      description TEXT,
      discount_type TEXT NOT NULL, -- 'percent', 'flat'
      discount_value REAL NOT NULL,
      min_bill REAL DEFAULT 0,
      customer_phone TEXT,
      expiry_date TEXT,
      active INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      max_discount REAL,
      start_date TEXT,
      end_date TEXT,
      per_customer INTEGER DEFAULT 1,
      total_limit INTEGER
    );

    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
      customer_phone TEXT,
      order_id INTEGER,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS loyalty_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      earn_points INTEGER DEFAULT 1,
      earn_per INTEGER DEFAULT 100,
      expiry_months INTEGER DEFAULT 12,
      welcome_points INTEGER DEFAULT 50,
      birthday_enabled INTEGER DEFAULT 1,
      birthday_type TEXT DEFAULT 'percent',
      birthday_value REAL DEFAULT 15,
      birthday_min_bill REAL DEFAULT 200,
      birthday_days_before INTEGER DEFAULT 3,
      birthday_days_after INTEGER DEFAULT 3
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      points INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'amount', 'item', 'percent'
      value REAL NOT NULL,
      min_bill REAL DEFAULT 0,
      category_id INTEGER,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pin_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      customer_name TEXT,
      created_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending' -- 'pending', 'sent', 'dismissed', 'used'
    );

    CREATE TABLE IF NOT EXISTS waiter_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'waiter', 'bill'
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
  `);

  // Migrate any missing columns on vouchers
  try {
    const vCols = db.prepare('PRAGMA table_info(vouchers)').all().map(c => c.name);
    const toAdd = [
      { name: 'max_discount', def: 'REAL DEFAULT NULL' },
      { name: 'start_date', def: 'TEXT DEFAULT NULL' },
      { name: 'end_date', def: 'TEXT DEFAULT NULL' },
      { name: 'per_customer', def: 'INTEGER DEFAULT 1' },
      { name: 'total_limit', def: 'INTEGER DEFAULT NULL' }
    ];
    for (const col of toAdd) {
      if (!vCols.includes(col.name)) {
        db.exec(`ALTER TABLE vouchers ADD COLUMN ${col.name} ${col.def}`);
      }
    }
  } catch {}

  // Seed default settings if empty
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  if (!getSetting.get('cafe_name')) {
    setSetting.run('cafe_name', 'Muse Bread & Brew');
    setSetting.run('customer_url', 'http://localhost:3000');
    setSetting.run('ordering_open', 'true');
    setSetting.run('customer_pin', 'true');
    setSetting.run('lock_minutes', '15');
    setSetting.run('admin_username', 'admin');
    setSetting.run('admin_password_hash', hashSecret('muse123'));
    setSetting.run('setup_code', 'MUSE2026');
    setSetting.run('pulse_rev', '1');
  }

  // Seed loyalty settings
  const loyalty = db.prepare('SELECT * FROM loyalty_settings WHERE id = 1').get();
  if (!loyalty) {
    db.prepare(`
      INSERT INTO loyalty_settings (id, enabled, earn_points, earn_per, expiry_months, welcome_points, birthday_enabled, birthday_type, birthday_value, birthday_min_bill, birthday_days_before, birthday_days_after)
      VALUES (1, 1, 1, 100, 12, 50, 1, 'percent', 15, 200, 3, 3)
    `).run();
  }

  // Seed tables
  const tableCount = db.prepare('SELECT COUNT(*) as count FROM tables').get();
  if (tableCount.count === 0) {
    const insertTable = db.prepare('INSERT INTO tables (number, qr_token, active, created_at) VALUES (?, ?, 1, ?)');
    const now = new Date().toISOString();
    for (let i = 1; i <= 8; i++) {
      const token = `tbl-${i}-${crypto.randomBytes(4).toString('hex')}`;
      insertTable.run(i, token, now);
    }
  }

  // Seed categories and items
  const catCount = db.prepare('SELECT COUNT(*) as count FROM categories').get();
  if (catCount.count === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, 1)');
    const insertItem = db.prepare('INSERT INTO items (category_id, name, section, description, price, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)');

    const c1 = Number(insertCat.run('Coffee & Brews', 1).lastInsertRowid);
    insertItem.run(c1, 'Muse Signature Cappuccino', 'Hot Coffee', 'Double espresso, velvety steamed milk, dusted with organic cocoa', 180, 1);
    insertItem.run(c1, 'Flat White', 'Hot Coffee', 'Rich ristretto shots paired with silky microfoam', 190, 2);
    insertItem.run(c1, 'Iced Spanish Latte', 'Cold Coffee', 'Espresso over sweetened condensed milk, chilled over ice with cinnamon', 220, 3);
    insertItem.run(c1, 'Cold Brew Reserve', 'Cold Coffee', 'Steeped for 18 hours, smooth with chocolate and berry notes', 210, 4);
    insertItem.run(c1, 'Espresso Tonic', 'Cold Coffee', 'Double shot over elderflower tonic with fresh rosemary and orange peel', 200, 5);

    const c2 = Number(insertCat.run('Artisan Breads & Pastries', 2).lastInsertRowid);
    insertItem.run(c2, 'Almond Croissant', 'Bakery', 'Flaky butter croissant twice-baked with rich almond frangipane & toasted flakes', 195, 1);
    insertItem.run(c2, 'Pain au Chocolat', 'Bakery', 'Classic French laminated pastry rolled with two batons of Belgian dark chocolate', 175, 2);
    insertItem.run(c2, 'Country Sourdough Toast & Butter', 'Breads', 'Two thick toasted sourdough slices with French cultured butter and house jam', 160, 3);
    insertItem.run(c2, 'Cinnamon Swirl Brioche', 'Bakery', 'Warm buttery brioche infused with Ceylon cinnamon and vanilla glaze', 165, 4);

    const c3 = Number(insertCat.run('Breakfast & Brunch', 3).lastInsertRowid);
    insertItem.run(c3, 'Avocado Sourdough Toast', 'Toast', 'Hass avocado smash, cherry tomatoes, feta crumble, microgreens, and seeds', 280, 1);
    insertItem.run(c3, 'Truffled Scrambled Eggs', 'Eggs', 'Slow-cooked creamy eggs, truffle oil, sautéed wild mushrooms on brioche', 310, 2);
    insertItem.run(c3, 'Shakshuka with Warm Focaccia', 'Skillets', 'Poached eggs in spiced tomato-bell pepper ragu with feta and fresh cilantro', 295, 3);
    insertItem.run(c3, 'Classic French Toast', 'Sweet', 'Brioche soaked in vanilla custard, served with maple syrup & mascarpone', 260, 4);

    const c4 = Number(insertCat.run('Sandwiches & Mains', 4).lastInsertRowid);
    insertItem.run(c4, 'Pesto Chicken & Bocconcini Panini', 'Paninis', 'Grilled chicken, fresh basil pesto, bocconcini mozzarella, sun-dried tomatoes', 340, 1);
    insertItem.run(c4, 'Roasted Veggie & Burrata Sandwich', 'Artisan', 'Zucchini, bell peppers, balsamic glaze, and creamy burrata on rosemary focaccia', 320, 2);
    insertItem.run(c4, 'Muse Club Sourdough Sandwich', 'Club', 'Smoked chicken, crispy turkey bacon, boiled egg, lettuce, garlic aioli', 360, 3);

    const c5 = Number(insertCat.run('Beverages & Refreshers', 5).lastInsertRowid);
    insertItem.run(c5, 'Matcha Green Tea Latte', 'Teas', 'Uji ceremonial matcha whisked with steamed oat milk and mild honey', 230, 1);
    insertItem.run(c5, 'Hibiscus Berry Iced Tea', 'Iced Tea', 'Brewed wild hibiscus petals, mixed berries, mint, and crushed ice', 180, 2);
    insertItem.run(c5, 'Fresh Valencia Orange Juice', 'Cold Pressed', 'Cold-pressed 100% natural Valencia oranges with no added sugar', 190, 3);

    const c6 = Number(insertCat.run('Desserts', 6).lastInsertRowid);
    insertItem.run(c6, 'Burnt Basque Cheesecake', 'Cakes', 'Caramelized crust with ultra-creamy, molten vanilla core', 240, 1);
    insertItem.run(c6, 'Tiramisu Tradizionale', 'Dessert', 'Savoiardi ladyfingers in espresso, layered with mascarpone cream & cocoa', 250, 2);
  }

  // Seed offers
  const offerCount = db.prepare('SELECT COUNT(*) as count FROM offers').get();
  if (offerCount.count === 0) {
    db.prepare(`
      INSERT INTO offers (title, description, discount_type, discount_value, min_bill, days, applies_to, active)
      VALUES 
      ('15% Off Weekdays', 'Get 15% off all items Monday through Friday', 'percent', 15, 250, 'Mon,Tue,Wed,Thu,Fri', 'Whole order', 1),
      ('₹100 Off Grand Feast', 'Enjoy ₹100 flat discount on orders above ₹600', 'flat', 100, 600, 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', 'Whole order', 1)
    `).run();
  }

  // Seed vouchers
  const voucherCount = db.prepare('SELECT COUNT(*) as count FROM vouchers').get();
  if (voucherCount.count === 0) {
    db.prepare(`
      INSERT INTO vouchers (code, title, description, discount_type, discount_value, min_bill, active)
      VALUES 
      ('MUSE50', '₹50 Off Voucher', '₹50 off on orders above ₹200', 'flat', 50, 200, 1),
      ('TASTE10', '10% Welcome Discount', '10% off your entire order', 'percent', 10, 150, 1)
    `).run();
  }

  // Seed rewards
  const rewardCount = db.prepare('SELECT COUNT(*) as count FROM rewards').get();
  if (rewardCount.count === 0) {
    db.prepare(`
      INSERT INTO rewards (name, points, type, value, min_bill, active)
      VALUES 
      ('₹50 Off Bill', 50, 'amount', 50, 200, 1),
      ('Free Artisan Croissant', 100, 'item', 195, 0, 1),
      ('₹120 Off Bill', 120, 'amount', 120, 400, 1)
    `).run();
  }
}

module.exports = {
  db,
  initDb,
  hashSecret
};

