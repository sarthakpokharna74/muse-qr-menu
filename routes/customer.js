const crypto = require('node:crypto');
const { hashSecret } = require('../db');

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function bumpRev(db) {
  const current = Number(getSetting(db, 'pulse_rev', '1'));
  const next = current + 1;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('pulse_rev', String(next));
  return next;
}

function handleCustomer(req, res, pathname, query, db) {
  // TABLE INFO & MENU
  const tableMatch = pathname.match(/^\/api\/customer\/table\/([^/]+)$/);
  if (req.method === 'GET' && tableMatch) {
    const token = tableMatch[1];
    const table = db.prepare('SELECT * FROM tables WHERE qr_token = ? AND active = 1').get(token);
    if (!table) {
      return res.status(404).json({ error: 'Table not found or QR code expired. Please ask the staff.' });
    }

    const cafeName = getSetting(db, 'cafe_name', 'Muse Bread & Brew');
    const orderingOpen = getSetting(db, 'ordering_open', 'true') === 'true';
    const customerPin = getSetting(db, 'customer_pin', 'true') === 'true';

    const categories = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
    const items = db.prepare('SELECT * FROM items ORDER BY sort_order ASC, id ASC').all().map(it => ({
      id: it.id,
      category_id: it.category_id,
      name: it.name,
      section: it.section || '',
      description: it.description || '',
      price: it.price,
      available: Boolean(it.available)
    }));

    const offers = db.prepare('SELECT * FROM offers WHERE active = 1 ORDER BY id DESC').all().map(o => ({
      id: o.id,
      title: o.title,
      description: o.description,
      discount_type: o.discount_type,
      discount_value: o.discount_value,
      max_item_price: o.max_item_price,
      min_bill: o.min_bill,
      limit: o.limit_rule || 'none',
      days: o.days,
      start_time: o.start_time,
      end_time: o.end_time,
      categories: o.categories ? o.categories.split(',').map(Number) : null,
      applies_to: o.applies_to || 'Whole order'
    }));

    const rewards = db.prepare('SELECT * FROM rewards WHERE active = 1 ORDER BY points ASC').all().map(r => ({
      id: r.id,
      name: r.name,
      points: r.points,
      type: r.type,
      value: r.value,
      min_bill: r.min_bill,
      category_id: r.category_id,
      active: 1
    }));

    const todayStr = new Date().toISOString().slice(0, 10);
    const vouchers = db.prepare(`
      SELECT id, code, title, description, discount_type, discount_value, min_bill, max_discount, start_date, end_date, expiry_date, per_customer, total_limit, used_count
      FROM vouchers 
      WHERE active = 1 AND (customer_phone IS NULL OR customer_phone = '')
      ORDER BY id ASC
    `).all()
      .filter(v => {
        const exp = v.end_date || v.expiry_date;
        if (exp && todayStr > exp) return false;
        if (v.start_date && todayStr < v.start_date) return false;
        if (v.total_limit && (v.used_count || 0) >= v.total_limit) return false;
        return true;
      })
      .map(v => ({
        id: v.id,
        code: v.code,
        title: v.title || v.code,
        description: v.description || '',
        discount_type: v.discount_type,
        discount_value: v.discount_value,
        min_bill: Number(v.min_bill || 0),
        max_discount: v.max_discount ? Number(v.max_discount) : null
      }));

    const loyaltyRow = db.prepare('SELECT * FROM loyalty_settings WHERE id = 1').get() || {};
    const loyalty = {
      enabled: Boolean(loyaltyRow.enabled),
      earn_points: loyaltyRow.earn_points || 1,
      earn_per: loyaltyRow.earn_per || 100,
      welcome_points: loyaltyRow.welcome_points || 0,
      birthday: {
        enabled: Boolean(loyaltyRow.birthday_enabled),
        type: loyaltyRow.birthday_type || 'percent',
        value: loyaltyRow.birthday_value || 15,
        min_bill: loyaltyRow.birthday_min_bill || 200,
        days_before: loyaltyRow.birthday_days_before || 3,
        days_after: loyaltyRow.birthday_days_after || 3
      }
    };

    return res.json({
      table: {
        id: table.id,
        number: table.number,
        qr_token: table.qr_token
      },
      cafe: {
        name: cafeName,
        ordering_open: orderingOpen,
        customer_pin: customerPin
      },
      categories,
      items,
      offers,
      vouchers,
      rewards,
      loyalty
    });
  }

  // LOYALTY PROFILE & HISTORY
  if (req.method === 'GET' && pathname === '/api/customer/loyalty-profile') {
    const cleanPhone = String(query.get('phone') || '').replace(/\D/g, '');
    if (!cleanPhone) return res.status(400).json({ error: 'Phone number required' });

    const c = db.prepare('SELECT id, name, phone, points, dob, birthday, pin_hash FROM customers WHERE phone = ?').get(cleanPhone);
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const history = db.prepare(`
      SELECT * FROM customer_points_log WHERE customer_id = ? ORDER BY id DESC LIMIT 20
    `).all(c.id);

    const rewards = db.prepare('SELECT * FROM rewards WHERE active = 1 ORDER BY points ASC').all();

    return res.json({
      customer: {
        id: c.id,
        name: c.name,
        phone: c.phone,
        points: c.points || 0,
        has_pin: Boolean(c.pin_hash),
        dob: c.dob || '',
        birthday: c.birthday || ''
      },
      history,
      rewards
    });
  }

  // CHECK PHONE
  if (req.method === 'POST' && pathname === '/api/customer/check') {
    const { phone } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }

    const c = db.prepare('SELECT id, name, phone, pin_hash, points FROM customers WHERE phone = ?').get(cleanPhone);
    if (!c) {
      return res.json({ exists: false, has_pin: false });
    }

    return res.json({
      exists: true,
      has_pin: Boolean(c.pin_hash),
      name: c.name,
      points: c.points || 0
    });
  }

  // AUTH / REGISTER / PIN VERIFY
  if (req.method === 'POST' && pathname === '/api/customer/auth') {
    const { phone, pin, name, dob } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }

    const pinStr = String(pin || '').trim();
    const customerPinRequired = getSetting(db, 'customer_pin', 'true') === 'true';

    let c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);

    if (c) {
      // Existing customer
      if (c.pin_hash) {
        if (!pinStr) {
          return res.status(400).json({ error: 'Please enter your 4-digit PIN.', requires_pin: true, has_pin: true, name: c.name });
        }
        if (hashSecret(pinStr) !== c.pin_hash) {
          return res.status(401).json({ error: 'Incorrect PIN. Try again or request a reset.', requires_pin: true, has_pin: true, name: c.name });
        }
      } else {
        // Customer didn't have PIN set yet, or PIN was cleared by admin
        if (customerPinRequired) {
          if (!pinStr || pinStr.length !== 4 || !/^\d{4}$/.test(pinStr)) {
            return res.status(400).json({ error: 'Please choose a 4-digit PIN for your account.', requires_pin: true, has_pin: false, name: c.name });
          }
          db.prepare('UPDATE customers SET pin_hash = ? WHERE id = ?').run(hashSecret(pinStr), c.id);
          c.pin_hash = hashSecret(pinStr);
        } else if (pinStr && pinStr.length === 4) {
          db.prepare('UPDATE customers SET pin_hash = ? WHERE id = ?').run(hashSecret(pinStr), c.id);
          c.pin_hash = hashSecret(pinStr);
        }
      }

      // If name provided and not set or changed
      if (name?.trim() && name.trim() !== c.name) {
        db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name.trim(), c.id);
        c.name = name.trim();
      }

      // If DOB provided
      if (dob && dob !== c.dob) {
        const bday = dob.slice(5, 10); // MM-DD
        const birthYear = Number(dob.slice(0, 4));
        const currentYear = new Date().getFullYear();
        const age = birthYear ? currentYear - birthYear : null;
        db.prepare('UPDATE customers SET dob = ?, birthday = ?, age = ? WHERE id = ?')
          .run(dob, bday, age, c.id);
      }

      return res.json({
        id: c.id,
        name: c.name,
        phone: c.phone,
        points: c.points || 0,
        has_pin: Boolean(c.pin_hash),
        dob: c.dob || '',
        birthday: c.birthday || ''
      });
    }

    // New customer registration
    if (!name?.trim()) {
      return res.status(400).json({ error: 'Please enter your name to register.' });
    }
    if (customerPinRequired && (!pinStr || pinStr.length !== 4 || !/^\d{4}$/.test(pinStr))) {
      return res.status(400).json({ error: 'Please choose a 4-digit PIN for your loyalty account.' });
    }

    const loyaltyRow = db.prepare('SELECT welcome_points FROM loyalty_settings WHERE id = 1').get() || {};
    const welcomePoints = loyaltyRow.welcome_points || 50;

    const today = new Date().toISOString().slice(0, 10);
    let bday = null;
    let age = null;
    if (dob) {
      bday = dob.slice(5, 10);
      const birthYear = Number(dob.slice(0, 4));
      const currentYear = new Date().getFullYear();
      age = birthYear ? currentYear - birthYear : null;
    }

    const pinHash = (pinStr && pinStr.length === 4) ? hashSecret(pinStr) : null;
    const resInsert = db.prepare(`
      INSERT INTO customers (name, phone, pin_hash, points, rating, dob, birthday, age, since, last_visit)
      VALUES (?, ?, ?, ?, 5, ?, ?, ?, ?, ?)
    `).run(name.trim(), cleanPhone, pinHash, welcomePoints, dob || null, bday, age, today, today);

    const newId = Number(resInsert.lastInsertRowid);

    if (welcomePoints > 0) {
      db.prepare(`
        INSERT INTO customer_points_log (customer_id, mode, amount, reason, created_at)
        VALUES (?, 'add', ?, 'Welcome bonus on sign up', ?)
      `).run(newId, welcomePoints, new Date().toISOString());
    }

    return res.json({
      id: newId,
      name: name.trim(),
      phone: cleanPhone,
      points: welcomePoints,
      has_pin: Boolean(pinHash),
      dob: dob || '',
      birthday: bday || '',
      welcome_bonus: welcomePoints
    });
  }

  // FORGOT PIN
  if (req.method === 'POST' && pathname === '/api/customer/forgot-pin') {
    const { phone } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);
    if (!c) {
      return res.status(404).json({ error: 'No account found with this phone number.' });
    }

    // Generate 4-digit reset code
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO pin_resets (customer_id, phone, code, customer_name, created_at, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(c.id, cleanPhone, code, c.name, now);

    bumpRev(db);

    return res.json({
      ok: true,
      code,
      message: 'PIN reset request sent to the cafe team. The team can assist you at the counter or send the code to your phone.'
    });
  }

  // RESET PIN (using 4-digit code from counter / WhatsApp)
  if (req.method === 'POST' && pathname === '/api/customer/reset-pin') {
    const { phone, code, new_pin } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const cleanCode = String(code || '').trim();
    const newPinStr = String(new_pin || '').trim();

    if (!cleanPhone || cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }
    if (!cleanCode || cleanCode.length !== 4) {
      return res.status(400).json({ error: 'Please enter the 4-digit reset code.' });
    }
    if (!newPinStr || newPinStr.length !== 4 || !/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
    }

    const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);
    if (!c) {
      return res.status(404).json({ error: 'No account found with this phone number.' });
    }

    const resetRow = db.prepare(`
      SELECT * FROM pin_resets 
      WHERE (phone = ? OR customer_id = ?) AND code = ? AND status IN ('pending', 'sent')
      ORDER BY id DESC LIMIT 1
    `).get(cleanPhone, c.id, cleanCode);

    if (!resetRow) {
      return res.status(400).json({ error: 'Invalid reset code. Please check the code or ask the counter team.' });
    }

    // Check expiry (valid for 30 minutes)
    const ageMs = Date.now() - new Date(resetRow.created_at).getTime();
    if (ageMs > 30 * 60 * 1000) {
      return res.status(400).json({ error: 'This reset code has expired. Please request a new one.' });
    }

    // Update PIN
    db.prepare('UPDATE customers SET pin_hash = ? WHERE id = ?').run(hashSecret(newPinStr), c.id);
    db.prepare("UPDATE pin_resets SET status = 'used' WHERE id = ?").run(resetRow.id);

    bumpRev(db);

    return res.json({
      ok: true,
      message: 'PIN successfully reset!',
      customer: {
        id: c.id,
        name: c.name,
        phone: c.phone,
        points: c.points || 0
      }
    });
  }

  // CHANGE PIN (for logged-in customer)
  if (req.method === 'POST' && pathname === '/api/customer/change-pin') {
    const { phone, current_pin, new_pin } = req.body || {};
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const curPinStr = String(current_pin || '').trim();
    const newPinStr = String(new_pin || '').trim();

    if (!cleanPhone || cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Invalid customer phone.' });
    }
    if (!newPinStr || newPinStr.length !== 4 || !/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
    }

    const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);
    if (!c) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    if (c.pin_hash) {
      if (!curPinStr) {
        return res.status(400).json({ error: 'Please enter your current PIN.' });
      }
      if (hashSecret(curPinStr) !== c.pin_hash) {
        return res.status(401).json({ error: 'Current PIN is incorrect.' });
      }
    }

    db.prepare('UPDATE customers SET pin_hash = ? WHERE id = ?').run(hashSecret(newPinStr), c.id);
    bumpRev(db);

    return res.json({
      ok: true,
      has_pin: true,
      message: c.pin_hash ? 'PIN updated successfully.' : '4-digit PIN set successfully!'
    });
  }

  // VALIDATE VOUCHER
  if (req.method === 'POST' && pathname === '/api/customer/voucher/validate') {
    const { code, phone, subtotal } = req.body || {};
    if (!code?.trim()) return res.status(400).json({ error: 'Enter voucher code.' });

    const cleanCode = code.trim().toUpperCase();
    const v = db.prepare('SELECT * FROM vouchers WHERE code = ? AND active = 1').get(cleanCode);
    if (!v) {
      return res.status(400).json({ error: `Voucher code "${cleanCode}" is invalid or inactive.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (v.start_date && today < v.start_date) {
      return res.status(400).json({ error: `Voucher "${cleanCode}" is not active yet (starts ${v.start_date}).` });
    }
    const expiry = v.end_date || v.expiry_date;
    if (expiry && today > expiry) {
      return res.status(400).json({ error: `Voucher "${cleanCode}" expired on ${expiry}.` });
    }

    if (v.total_limit && (v.used_count || 0) >= Number(v.total_limit)) {
      return res.status(400).json({ error: `Voucher "${cleanCode}" has reached its maximum redemptions limit.` });
    }

    const sub = Number(subtotal || 0);
    if (v.min_bill && sub < Number(v.min_bill)) {
      return res.status(400).json({ error: `This voucher requires a minimum order of ₹${v.min_bill}.` });
    }

    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (v.customer_phone && cleanPhone && v.customer_phone !== cleanPhone) {
      return res.status(400).json({ error: 'This voucher is restricted to a different phone number.' });
    }

    if (cleanPhone) {
      const perCustLimit = (v.per_customer === null || v.per_customer === undefined) ? 1 : Number(v.per_customer);
      if (perCustLimit > 0) {
        const usedCount = db.prepare('SELECT COUNT(*) as c FROM voucher_redemptions WHERE voucher_id = ? AND customer_phone = ?').get(v.id, cleanPhone)?.c || 0;
        if (usedCount >= perCustLimit) {
          return res.status(400).json({ error: `Voucher "${cleanCode}" has already been used ${usedCount} time${usedCount > 1 ? 's' : ''} on your account.` });
        }
      }
    }

    let discount = 0;
    if (v.discount_type === 'percent') {
      discount = Math.round((sub * Number(v.discount_value)) / 100);
      if (v.max_discount && discount > Number(v.max_discount)) {
        discount = Number(v.max_discount);
      }
    } else {
      discount = Math.min(sub, Number(v.discount_value));
    }

    return res.json({
      valid: true,
      code: v.code,
      title: v.title || v.code,
      description: v.description || '',
      discount_type: v.discount_type,
      discount_value: Number(v.discount_value),
      max_discount: v.max_discount ? Number(v.max_discount) : null,
      min_bill: Number(v.min_bill || 0),
      discount
    });
  }

  // PLACE ORDER
  if (req.method === 'POST' && pathname === '/api/customer/orders') {
    const b = req.body || {};
    const {
      table_id,
      table_number,
      customer_phone,
      customer_name,
      items,
      subtotal,
      discount,
      savings,
      voucher_code,
      reward_id,
      points_used,
      total,
      note
    } = b;

    const ptsUsed = Number(points_used || 0);

    const orderingOpen = getSetting(db, 'ordering_open', 'true') === 'true';
    if (!orderingOpen) {
      return res.status(400).json({ error: 'Online ordering is temporarily paused. Please place your order at the counter.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty. Please add items.' });
    }

    const cleanPhone = String(customer_phone || '').replace(/\D/g, '');
    let customer = cleanPhone ? db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone) : null;

    // PIN Verification & Registration
    const customerPinRequired = getSetting(db, 'customer_pin', 'true') === 'true';
    const pinStr = b.pin ? String(b.pin).trim() : null;

    if (customer && customer.pin_hash) {
      if (ptsUsed > 0) {
        if (!pinStr || hashSecret(pinStr) !== customer.pin_hash) {
          return res.status(401).json({
            error: 'Please enter your 4-digit PIN to redeem loyalty points.',
            requires_pin: true,
            has_pin: true
          });
        }
      } else if (pinStr && hashSecret(pinStr) !== customer.pin_hash) {
        return res.status(401).json({
          error: 'Incorrect 4-digit PIN for this phone number.',
          requires_pin: true,
          has_pin: true
        });
      }
    } else if (customer && !customer.pin_hash && pinStr && pinStr.length === 4 && /^\d{4}$/.test(pinStr)) {
      db.prepare('UPDATE customers SET pin_hash = ? WHERE id = ?').run(hashSecret(pinStr), customer.id);
      customer.pin_hash = hashSecret(pinStr);
    }

    // Calculate loyalty points earned
    const loyaltyRow = db.prepare('SELECT * FROM loyalty_settings WHERE id = 1').get() || {};
    const earnPoints = loyaltyRow.earn_points || 1;
    const earnPer = loyaltyRow.earn_per || 100;
    const welcomePoints = Number(loyaltyRow.welcome_points || 50);

    if (!customer && cleanPhone && cleanPhone.length === 10) {
      const today = new Date().toISOString().slice(0, 10);
      const pinHash = (pinStr && pinStr.length === 4 && /^\d{4}$/.test(pinStr)) ? hashSecret(pinStr) : null;
      const resCust = db.prepare(`
        INSERT INTO customers (name, phone, pin_hash, points, rating, since, last_visit)
        VALUES (?, ?, ?, ?, 5, ?, ?)
      `).run(customer_name?.trim() || 'Guest', cleanPhone, pinHash, welcomePoints, today, today);
      const newCustId = Number(resCust.lastInsertRowid);
      if (welcomePoints > 0) {
        db.prepare(`
          INSERT INTO customer_points_log (customer_id, mode, amount, reason, created_at)
          VALUES (?, 'add', ?, 'Welcome bonus on sign up', ?)
        `).run(newCustId, welcomePoints, new Date().toISOString());
      }
      customer = { id: newCustId, name: customer_name?.trim() || 'Guest', phone: cleanPhone, points: welcomePoints, pin_hash: pinHash };
    }

    // Calculate order number: MAX(number) + 1
    const maxNumRow = db.prepare('SELECT MAX(number) as m FROM orders').get();
    const orderNumber = (maxNumRow?.m ? Number(maxNumRow.m) : 100) + 1;

    const pointsEarned = loyaltyRow.enabled && earnPer ? Math.floor(Number(total || 0) / earnPer) * earnPoints : 0;

    // Check if points were redeemed
    if (customer && ptsUsed > 0) {
      if (customer.points < ptsUsed) {
        return res.status(400).json({ error: 'Not enough loyalty points.' });
      }
      db.prepare('UPDATE customers SET points = points - ? WHERE id = ?').run(ptsUsed, customer.id);
      db.prepare(`
        INSERT INTO customer_points_log (customer_id, mode, amount, reason, created_at)
        VALUES (?, 'subtract', ?, ?, ?)
      `).run(customer.id, ptsUsed, `Redeemed on Order #${orderNumber}`, new Date().toISOString());
    }

    const now = new Date().toISOString();

    // Prepare flags (e.g. Free item / Voucher applied / Points used)
    const flagsList = [];
    if (voucher_code) flagsList.push(`Voucher: ${voucher_code}`);
    if (ptsUsed > 0) flagsList.push(`Points used: ${ptsUsed}`);
    if (items.some(i => i.free)) flagsList.push('Free item redeemed');
    const flagsStr = flagsList.length ? flagsList.join(' | ') : null;

    const resOrder = db.prepare(`
      INSERT INTO orders (
        number, table_id, table_number, customer_id, customer_name, customer_phone,
        status, subtotal, discount, savings, total, points_earned, points_used,
        note, flags, seen, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      orderNumber,
      Number(table_id || 1),
      Number(table_number || 1),
      customer ? customer.id : null,
      customer_name?.trim() || (customer ? customer.name : 'Guest'),
      cleanPhone,
      Number(subtotal || 0),
      Number(discount || 0),
      savings || null,
      Number(total || 0),
      pointsEarned,
      ptsUsed,
      note?.trim() || null,
      flagsStr,
      now,
      now
    );

    const orderId = Number(resOrder.lastInsertRowid);

    // Insert order items
    const insertOrderItem = db.prepare(`
      INSERT INTO order_items (order_id, item_id, name, qty, price, free, note, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of items) {
      const lineTotal = it.free ? 0 : Number(it.price || 0) * Number(it.qty || 1);
      insertOrderItem.run(
        orderId,
        it.item_id ? Number(it.item_id) : null,
        it.name,
        Number(it.qty || 1),
        Number(it.price || 0),
        it.free ? 1 : 0,
        it.note?.trim() || null,
        lineTotal
      );
    }

    // Record voucher redemption
    if (voucher_code) {
      const v = db.prepare('SELECT id FROM vouchers WHERE code = ?').get(voucher_code.toUpperCase().trim());
      if (v) {
        db.prepare(`
          INSERT INTO voucher_redemptions (voucher_id, customer_phone, order_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(v.id, cleanPhone || null, orderId, now);
        db.prepare('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?').run(v.id);
      }
    }

    bumpRev(db);

    return res.json({
      ok: true,
      order: {
        id: orderId,
        number: orderNumber,
        status: 'open',
        table_number: Number(table_number || 1),
        total: Number(total || 0),
        created_at: now,
        points_earned: pointsEarned
      },
      customer: customer ? {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        points: Math.max(0, customer.points - ptsUsed)
      } : null
    });
  }

  // ORDER DETAILS
  const orderDetailsMatch = pathname.match(/^\/api\/customer\/orders\/(\d+)$/);
  if (req.method === 'GET' && orderDetailsMatch) {
    const orderId = Number(orderDetailsMatch[1]);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) return res.status(404).json({ error: 'Order not found.' });

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(it => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      price: it.price,
      free: Boolean(it.free),
      note: it.note,
      line_total: it.line_total
    }));

    return res.json({
      id: o.id,
      number: o.number,
      table_number: o.table_number,
      customer_name: o.customer_name,
      status: o.status,
      subtotal: o.subtotal,
      discount: o.discount,
      savings: o.savings,
      total: o.total,
      points_earned: o.points_earned,
      note: o.note,
      created_at: o.created_at,
      items
    });
  }

  // ACTIVE ORDERS FOR TABLE
  const activeOrdersMatch = pathname.match(/^\/api\/customer\/table\/([^/]+)\/active-orders$/);
  if (req.method === 'GET' && activeOrdersMatch) {
    const token = activeOrdersMatch[1];
    const table = db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(token);
    if (!table) return res.status(404).json({ error: 'Table not found.' });

    const orders = db.prepare(`
      SELECT * FROM orders 
      WHERE table_number = ? AND status IN ('open', 'received', 'served')
      ORDER BY id DESC
    `).all(table.number).map(o => {
      const items = db.prepare('SELECT name, qty, line_total FROM order_items WHERE order_id = ?').all(o.id);
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        total: o.total,
        created_at: o.created_at,
        items
      };
    });

    return res.json({ orders });
  }

  // CALL WAITER
  const waiterMatch = pathname.match(/^\/api\/customer\/table\/([^/]+)\/call-waiter$/);
  if (req.method === 'POST' && waiterMatch) {
    const token = waiterMatch[1];
    const table = db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(token);
    if (!table) return res.status(404).json({ error: 'Table not found.' });

    db.prepare(`
      INSERT INTO waiter_calls (table_number, type, status, created_at)
      VALUES (?, 'waiter', 'pending', ?)
    `).run(table.number, new Date().toISOString());

    bumpRev(db);
    return res.json({ ok: true, message: `Staff alerted for Table ${table.number}. Someone will be with you shortly!` });
  }

  // REQUEST BILL
  const billMatch = pathname.match(/^\/api\/customer\/table\/([^/]+)\/request-bill$/);
  if (req.method === 'POST' && billMatch) {
    const token = billMatch[1];
    const table = db.prepare('SELECT * FROM tables WHERE qr_token = ?').get(token);
    if (!table) return res.status(404).json({ error: 'Table not found.' });

    db.prepare(`
      INSERT INTO waiter_calls (table_number, type, status, created_at)
      VALUES (?, 'bill', 'pending', ?)
    `).run(table.number, new Date().toISOString());

    bumpRev(db);
    return res.json({ ok: true, message: `Bill request received for Table ${table.number}. The team is preparing your bill!` });
  }

  return false;
}

module.exports = {
  handleCustomer
};

