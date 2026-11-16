const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashSecret } = require('../db');
const { getLanIp } = require('../utils');

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function bumpRev(db) {
  const current = Number(getSetting(db, 'pulse_rev', '1'));
  const next = current + 1;
  setSetting(db, 'pulse_rev', next);
  return next;
}

function formatOrder(db, o) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id).map(it => ({
    id: it.id,
    name: it.name,
    qty: it.qty,
    price: it.price,
    free: Boolean(it.free),
    note: it.note || undefined,
    line_total: it.line_total
  }));

  return {
    id: o.id,
    number: o.number,
    table: o.table_number,
    table_id: o.table_id,
    customer_id: o.customer_id,
    customer_name: o.customer_name || 'Walk-in Guest',
    customer_phone: o.customer_phone || '',
    status: o.status,
    subtotal: o.subtotal,
    discount: o.discount,
    savings: o.savings || undefined,
    total: o.total,
    points_earned: o.points_earned,
    points_used: o.points_used,
    note: o.note || undefined,
    flags: o.flags || undefined,
    cancel_reason: o.cancel_reason || undefined,
    seen: Boolean(o.seen),
    created_at: o.created_at,
    updated_at: o.updated_at,
    items
  };
}

function handleAdmin(req, res, pathname, query, db) {
  // PULSE
  if (req.method === 'GET' && pathname === '/api/admin/pulse') {
    const rev = Number(getSetting(db, 'pulse_rev', '1'));
    return res.json({ rev });
  }

  // ALERTS
  if (req.method === 'GET' && pathname === '/api/admin/alerts') {
    const unseenOrders = db.prepare(`
      SELECT * FROM orders WHERE seen = 0 AND status != 'cancelled' ORDER BY id DESC
    `).all().map(o => formatOrder(db, o));

    // Include pending waiter calls and bill requests as high-priority alerts
    const pendingCalls = db.prepare(`
      SELECT * FROM waiter_calls WHERE status = 'pending' ORDER BY id DESC
    `).all();

    for (const c of pendingCalls) {
      unseenOrders.unshift({
        id: `call-${c.id}`,
        number: c.type === 'waiter' ? 'BELL' : 'BILL',
        table: c.table_number,
        customer_name: c.type === 'waiter' ? 'WAITER ASSISTANCE' : 'BILL REQUESTED',
        total: 0,
        status: 'open',
        items: [
          { name: c.type === 'waiter' ? 'Guest at table called for a waiter' : 'Guest requested table bill', qty: 1 }
        ],
        flags: c.type === 'waiter' ? '🔔 ATTEND TABLE NOW' : '💳 BRING BILL TO TABLE',
        created_at: c.created_at
      });
    }

    const pinResets = db.prepare(`
      SELECT * FROM pin_resets WHERE status = 'pending' ORDER BY id DESC
    `).all().map(p => ({
      id: p.id,
      phone: p.phone,
      code: p.code,
      name: p.customer_name || 'Customer',
      customer_name: p.customer_name || 'Customer',
      created_at: p.created_at
    }));

    return res.json({
      unseen: unseenOrders,
      pin_resets: pinResets
    });
  }

  // ORDER SEEN
  const seenMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/seen$/);
  if (req.method === 'POST' && seenMatch) {
    const rawId = seenMatch[1];
    if (rawId.startsWith('call-')) {
      const callId = Number(rawId.replace('call-', ''));
      db.prepare("UPDATE waiter_calls SET status = 'seen' WHERE id = ?").run(callId);
    } else {
      const orderId = Number(rawId);
      db.prepare('UPDATE orders SET seen = 1 WHERE id = ?').run(orderId);
    }
    bumpRev(db);
    return res.json({ ok: true });
  }

  // WAITER CALLS LIST & ACKNOWLEDGE
  if (req.method === 'GET' && pathname === '/api/admin/waiter-calls') {
    const calls = db.prepare(`
      SELECT * FROM waiter_calls WHERE status = 'pending' ORDER BY id DESC
    `).all();
    return res.json({ calls });
  }

  const waiterSeenMatch = pathname.match(/^\/api\/admin\/waiter-calls\/([^/]+)\/seen$/);
  if (req.method === 'POST' && waiterSeenMatch) {
    const callId = Number(waiterSeenMatch[1]);
    db.prepare("UPDATE waiter_calls SET status = 'seen' WHERE id = ?").run(callId);
    bumpRev(db);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/waiter-calls/clear-all') {
    db.prepare("UPDATE waiter_calls SET status = 'seen' WHERE status = 'pending'").run();
    bumpRev(db);
    return res.json({ ok: true });
  }

  // PIN RESET ACTIONS
  const pinSentMatch = pathname.match(/^\/api\/admin\/pin-resets\/(\d+)\/sent$/);
  if (req.method === 'POST' && pinSentMatch) {
    const resetId = Number(pinSentMatch[1]);
    db.prepare("UPDATE pin_resets SET status = 'sent' WHERE id = ?").run(resetId);
    bumpRev(db);
    return res.json({ ok: true });
  }

  const pinDismissMatch = pathname.match(/^\/api\/admin\/pin-resets\/(\d+)\/dismiss$/);
  if (req.method === 'POST' && pinDismissMatch) {
    const resetId = Number(pinDismissMatch[1]);
    db.prepare("UPDATE pin_resets SET status = 'dismissed' WHERE id = ?").run(resetId);
    bumpRev(db);
    return res.json({ ok: true });
  }

  // DASHBOARD
  if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
    const orderingOpen = getSetting(db, 'ordering_open', 'true') === 'true';
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Fetch today's orders
    const todayOrders = db.prepare(`
      SELECT * FROM orders WHERE created_at LIKE ?
    `).all(`${todayStr}%`);

    const activeToday = todayOrders.filter(o => o.status !== 'cancelled');
    const cancelledToday = todayOrders.filter(o => o.status === 'cancelled');
    const paidToday = todayOrders.filter(o => o.status === 'done');
    const toCollectToday = todayOrders.filter(o => ['open', 'received', 'served'].includes(o.status));

    const totalAmount = activeToday.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const paidAmount = paidToday.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const toCollectAmount = toCollectToday.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const discountsAmount = activeToday.reduce((sum, o) => sum + Number(o.discount || 0), 0);
    const pointsAmount = activeToday.reduce((sum, o) => sum + Number(o.points_earned || 0), 0);

    // Hourly orders array (24 hours)
    const hours = Array(24).fill(0);
    activeToday.forEach(o => {
      try {
        const h = new Date(o.created_at).getHours();
        if (h >= 0 && h < 24) hours[h]++;
      } catch {}
    });

    // Top items today
    const topItemRows = db.prepare(`
      SELECT oi.name, SUM(oi.qty) as qty 
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at LIKE ? AND o.status != 'cancelled'
      GROUP BY oi.name
      ORDER BY qty DESC
      LIMIT 8
    `).all(`${todayStr}%`);

    // New customers registered today
    const newCust = db.prepare('SELECT COUNT(*) as count FROM customers WHERE since = ?').get(todayStr);

    const todayMetrics = {
      amount: totalAmount,
      paid: paidAmount,
      to_collect: toCollectAmount,
      orders: activeToday.length,
      average: activeToday.length ? Math.round(totalAmount / activeToday.length) : 0,
      discounts: discountsAmount,
      points: pointsAmount,
      new_customers: newCust?.count || 0,
      cancelled: cancelledToday.length,
      hours,
      top_items: topItemRows.map(r => ({ name: r.name, qty: Number(r.qty) }))
    };

    // Table status cards
    const allTables = db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY number ASC').all();
    const openOrders = db.prepare(`
      SELECT * FROM orders WHERE status IN ('open', 'received', 'served') ORDER BY created_at ASC
    `).all();

    const tableCards = allTables.map(t => {
      const tblOrders = openOrders.filter(o => o.table_number === t.number);
      const hasNew = tblOrders.some(o => o.status === 'open');
      const hasReceived = tblOrders.some(o => o.status === 'received');
      const hasServed = tblOrders.some(o => o.status === 'served');
      const openTotal = tblOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
      const oldestSince = tblOrders.length ? tblOrders[0].created_at : null;

      return {
        table: t.number,
        open_orders: tblOrders.length,
        open_total: openTotal,
        new: hasNew,
        received: hasReceived && !hasNew,
        served: hasServed && !hasNew && !hasReceived,
        since: oldestSince
      };
    });

    // Live order queue
    const queue = openOrders.map(o => formatOrder(db, o));

    return res.json({
      ordering_open: orderingOpen,
      today: todayMetrics,
      tables: tableCards,
      queue
    });
  }

  // ORDERS
  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    const tableParam = query.get('table');
    const dateParam = query.get('date');
    const statusParam = query.get('status');

    let orders;
    if (tableParam) {
      const tblNum = Number(tableParam);
      orders = db.prepare(`
        SELECT * FROM orders 
        WHERE table_number = ? AND status IN ('open', 'received', 'served')
        ORDER BY id DESC
      `).all(tblNum);
    } else {
      let sql = 'SELECT * FROM orders WHERE 1=1';
      const params = [];
      if (dateParam) {
        sql += ' AND created_at LIKE ?';
        params.push(`${dateParam}%`);
      }
      if (statusParam) {
        sql += ' AND status = ?';
        params.push(statusParam);
      }
      sql += ' ORDER BY id DESC';
      orders = db.prepare(sql).all(...params);
    }

    return res.json({
      orders: orders.map(o => formatOrder(db, o))
    });
  }

  // ORDER STATUS UPDATE
  const statusMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    const orderId = Number(statusMatch[1]);
    const { status } = req.body || {};
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    let finalStatus = status;
    if (status === 'paid' || status === 'done') {
      finalStatus = 'done';
      // Award loyalty points to customer if customer linked and not already awarded
      if (order.customer_id && order.points_earned > 0) {
        const reasonStr = `Earned from Order #${order.number}`;
        const alreadyAwarded = db.prepare(`
          SELECT id FROM customer_points_log WHERE customer_id = ? AND reason = ?
        `).get(order.customer_id, reasonStr);

        if (!alreadyAwarded) {
          db.prepare(`
            UPDATE customers SET points = points + ?, last_visit = ? WHERE id = ?
          `).run(order.points_earned, new Date().toISOString().slice(0, 10), order.customer_id);

          db.prepare(`
            INSERT INTO customer_points_log (customer_id, mode, amount, reason, created_at)
            VALUES (?, 'add', ?, ?, ?)
          `).run(order.customer_id, order.points_earned, reasonStr, new Date().toISOString());
        }
      }
    }

    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
      .run(finalStatus, new Date().toISOString(), orderId);

    bumpRev(db);
    return res.json({ ok: true, status: finalStatus });
  }

  // ORDER CANCEL
  const cancelMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const orderId = Number(cancelMatch[1]);
    const { reason } = req.body || {};
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    db.prepare(`
      UPDATE orders SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?
    `).run(reason || 'Cancelled by staff', new Date().toISOString(), orderId);

    // If points were used, restore points
    if (order.customer_id && order.points_used > 0) {
      db.prepare('UPDATE customers SET points = points + ? WHERE id = ?')
        .run(order.points_used, order.customer_id);
    }

    bumpRev(db);
    return res.json({ ok: true });
  }

  // TABLES
  if (req.method === 'GET' && pathname === '/api/admin/tables') {
    const rawUrl = getSetting(db, 'customer_url', '');
    const lanIp = getLanIp();
    const reqHost = req.headers.host;
    let baseUrl = rawUrl;
    if (!baseUrl || baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
      if (reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1')) {
        baseUrl = `http://${reqHost}`;
      } else if (lanIp && lanIp !== '127.0.0.1') {
        baseUrl = `http://${lanIp}:3000`;
      } else {
        baseUrl = 'http://localhost:3000';
      }
    }
    const tables = db.prepare('SELECT * FROM tables ORDER BY number ASC').all().map(t => ({
      id: t.id,
      number: t.number,
      qr_token: t.qr_token,
      active: Boolean(t.active)
    }));
    return res.json({ base_url: baseUrl, tables });
  }

  if (req.method === 'POST' && pathname === '/api/admin/tables') {
    const { number } = req.body || {};
    const num = Number(number);
    if (!num) return res.status(400).json({ error: 'Valid table number is required.' });

    const existing = db.prepare('SELECT id FROM tables WHERE number = ?').get(num);
    if (existing) return res.status(400).json({ error: `Table ${num} already exists.` });

    const qrToken = `tbl-${num}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const resInsert = db.prepare('INSERT INTO tables (number, qr_token, active, created_at) VALUES (?, ?, 1, ?)').run(num, qrToken, now);

    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), number: num, qr_token: qrToken, active: true });
  }

  const newQrMatch = pathname.match(/^\/api\/admin\/tables\/(\d+)\/new-qr$/);
  if (req.method === 'POST' && newQrMatch) {
    const tableId = Number(newQrMatch[1]);
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    if (!table) return res.status(404).json({ error: 'Table not found.' });

    const newQr = `tbl-${table.number}-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare('UPDATE tables SET qr_token = ? WHERE id = ?').run(newQr, tableId);

    bumpRev(db);
    return res.json({ qr_token: newQr });
  }

  const deleteTableMatch = pathname.match(/^\/api\/admin\/tables\/(\d+)$/);
  if (req.method === 'DELETE' && deleteTableMatch) {
    const tableId = Number(deleteTableMatch[1]);
    db.prepare('DELETE FROM tables WHERE id = ?').run(tableId);
    bumpRev(db);
    return res.json({ ok: true });
  }

  // MENU
  if (req.method === 'GET' && pathname === '/api/admin/menu') {
    const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all().map(c => ({
      id: c.id,
      name: c.name,
      sort_order: c.sort_order,
      active: Boolean(c.active)
    }));

    const items = db.prepare('SELECT * FROM items ORDER BY sort_order ASC, id ASC').all().map(i => ({
      id: i.id,
      category_id: i.category_id,
      name: i.name,
      section: i.section || '',
      description: i.description || '',
      price: i.price,
      available: Boolean(i.available),
      sort_order: i.sort_order
    }));

    return res.json({ categories, items });
  }

  // CATEGORIES CRUD
  if (req.method === 'POST' && pathname === '/api/admin/categories') {
    const { name, active, sort_order } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Category name is required.' });

    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM categories').get();
    const sort = sort_order ?? ((maxSort?.m || 0) + 1);
    const resInsert = db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, ?)')
      .run(name.trim(), sort, active !== false ? 1 : 0);

    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), name: name.trim(), sort_order: sort, active: active !== false });
  }

  const catIdMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (catIdMatch) {
    const catId = Number(catIdMatch[1]);
    if (req.method === 'PUT') {
      const { name, active, sort_order } = req.body || {};
      if (name) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), catId);
      if (active !== undefined) db.prepare('UPDATE categories SET active = ? WHERE id = ?').run(active ? 1 : 0, catId);
      if (sort_order !== undefined) db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').run(Number(sort_order), catId);
      bumpRev(db);
      return res.json({ ok: true, id: catId });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM items WHERE category_id = ?').run(catId);
      db.prepare('DELETE FROM categories WHERE id = ?').run(catId);
      bumpRev(db);
      return res.json({ ok: true });
    }
  }

  // ITEMS CRUD
  if (req.method === 'POST' && pathname === '/api/admin/items') {
    const { name, category_id, section, description, price, available } = req.body || {};
    if (!name?.trim() || !category_id || price === undefined) {
      return res.status(400).json({ error: 'Name, category, and price are required.' });
    }

    const resInsert = db.prepare(`
      INSERT INTO items (category_id, name, section, description, price, available, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(Number(category_id), name.trim(), section?.trim() || '', description?.trim() || '', Number(price), available !== false ? 1 : 0);

    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), name: name.trim(), price: Number(price) });
  }

  const itemIdMatch = pathname.match(/^\/api\/admin\/items\/(\d+)$/);
  if (itemIdMatch) {
    const itemId = Number(itemIdMatch[1]);
    if (req.method === 'PUT') {
      const { name, category_id, section, description, price, available, sort_order } = req.body || {};
      if (name !== undefined) db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name.trim(), itemId);
      if (category_id !== undefined) db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(Number(category_id), itemId);
      if (section !== undefined) db.prepare('UPDATE items SET section = ? WHERE id = ?').run(section.trim(), itemId);
      if (description !== undefined) db.prepare('UPDATE items SET description = ? WHERE id = ?').run(description.trim(), itemId);
      if (price !== undefined) db.prepare('UPDATE items SET price = ? WHERE id = ?').run(Number(price), itemId);
      if (available !== undefined) db.prepare('UPDATE items SET available = ? WHERE id = ?').run(available ? 1 : 0, itemId);
      if (sort_order !== undefined) db.prepare('UPDATE items SET sort_order = ? WHERE id = ?').run(Number(sort_order), itemId);

      bumpRev(db);
      return res.json({ ok: true, id: itemId });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
      bumpRev(db);
      return res.json({ ok: true });
    }
  }

  // MENU IMPORT
  if (req.method === 'POST' && pathname === '/api/admin/menu/import') {
    const { rows } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Invalid rows array.' });

    let added = 0;
    let updated = 0;
    const errors = [];

    for (const r of rows) {
      if (!r.item || !r.category) continue;
      try {
        // Find or create category
        let cat = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(r.category);
        if (!cat) {
          const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM categories').get()?.m || 0;
          const catRes = db.prepare('INSERT INTO categories (name, sort_order, active) VALUES (?, ?, 1)').run(r.category, maxSort + 1);
          cat = { id: Number(catRes.lastInsertRowid) };
        }

        // Find or create item
        let item = db.prepare('SELECT id FROM items WHERE LOWER(name) = LOWER(?)').get(r.item);
        const isAvailable = r.stock === undefined || String(r.stock).toLowerCase() === 'yes' || Boolean(r.stock) ? 1 : 0;
        if (item) {
          db.prepare(`
            UPDATE items SET category_id = ?, section = ?, description = ?, price = ?, available = ? WHERE id = ?
          `).run(cat.id, r.section || '', r.description || '', Number(r.price || 0), isAvailable, item.id);
          updated++;
        } else {
          db.prepare(`
            INSERT INTO items (category_id, name, section, description, price, available) VALUES (?, ?, ?, ?, ?, ?)
          `).run(cat.id, r.item, r.section || '', r.description || '', Number(r.price || 0), isAvailable);
          added++;
        }
      } catch (err) {
        errors.push(`Row ${r.row || ''}: ${r.item} - ${err.message}`);
      }
    }

    bumpRev(db);
    return res.json({ ok: true, count: rows.length, added, updated, errors });
  }

  // OFFERS CRUD
  if (req.method === 'GET' && pathname === '/api/admin/offers') {
    const offers = db.prepare('SELECT * FROM offers ORDER BY id DESC').all().map(o => ({
      id: o.id,
      title: o.title,
      description: o.description || '',
      discount_type: o.discount_type,
      discount_value: Number(o.discount_value || 0),
      max_item_price: o.max_item_price ? Number(o.max_item_price) : null,
      min_bill: Number(o.min_bill || 0),
      limit: o.limit_rule || 'none',
      days: o.days || 'Mon, Tue, Wed, Thu, Fri, Sat, Sun',
      start_time: o.start_time || '',
      end_time: o.end_time || '',
      start_date: o.start_date || '',
      end_date: o.end_date || '',
      categories: o.categories || '',
      applies_to: o.applies_to || 'Whole order',
      active: Boolean(o.active)
    }));
    return res.json({ offers });
  }

  if (req.method === 'POST' && pathname === '/api/admin/offers') {
    const b = req.body || {};
    const catStr = Array.isArray(b.categories) ? b.categories.join(',') : (b.categories || null);
    const daysStr = Array.isArray(b.days) ? b.days.join(', ') : (b.days || 'Mon, Tue, Wed, Thu, Fri, Sat, Sun');
    const resInsert = db.prepare(`
      INSERT INTO offers (title, description, discount_type, discount_value, max_item_price, min_bill, limit_rule, days, start_time, end_time, start_date, end_date, categories, applies_to, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.title, b.description || '', b.discount_type || 'percent', Number(b.discount_value || 0),
      b.max_item_price ? Number(b.max_item_price) : null, Number(b.min_bill || 0),
      b.limit || b.limit_rule || 'none', daysStr,
      b.start_time || null, b.end_time || null, b.start_date || null, b.end_date || null,
      catStr, b.applies_to || 'Whole order', b.active !== false ? 1 : 0
    );
    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), ok: true });
  }

  const offerIdMatch = pathname.match(/^\/api\/admin\/offers\/(\d+)$/);
  if (offerIdMatch) {
    const offerId = Number(offerIdMatch[1]);
    if (req.method === 'PUT') {
      const b = req.body || {};
      const fields = [];
      const params = [];

      if (b.title !== undefined) { fields.push('title = ?'); params.push(b.title); }
      if (b.description !== undefined) { fields.push('description = ?'); params.push(b.description); }
      if (b.discount_type !== undefined) { fields.push('discount_type = ?'); params.push(b.discount_type); }
      if (b.discount_value !== undefined) { fields.push('discount_value = ?'); params.push(Number(b.discount_value)); }
      if (b.max_item_price !== undefined) { fields.push('max_item_price = ?'); params.push(b.max_item_price ? Number(b.max_item_price) : null); }
      if (b.min_bill !== undefined) { fields.push('min_bill = ?'); params.push(Number(b.min_bill)); }
      if (b.limit !== undefined || b.limit_rule !== undefined) { fields.push('limit_rule = ?'); params.push(b.limit || b.limit_rule || 'none'); }
      if (b.days !== undefined) {
        const daysStr = Array.isArray(b.days) ? b.days.join(', ') : b.days;
        fields.push('days = ?');
        params.push(daysStr);
      }
      if (b.start_time !== undefined) { fields.push('start_time = ?'); params.push(b.start_time || null); }
      if (b.end_time !== undefined) { fields.push('end_time = ?'); params.push(b.end_time || null); }
      if (b.start_date !== undefined) { fields.push('start_date = ?'); params.push(b.start_date || null); }
      if (b.end_date !== undefined) { fields.push('end_date = ?'); params.push(b.end_date || null); }
      if (b.categories !== undefined) {
        const catStr = Array.isArray(b.categories) ? b.categories.join(',') : (b.categories || null);
        fields.push('categories = ?');
        params.push(catStr);
      }
      if (b.applies_to !== undefined) { fields.push('applies_to = ?'); params.push(b.applies_to); }
      if (b.active !== undefined) { fields.push('active = ?'); params.push(b.active ? 1 : 0); }

      if (fields.length > 0) {
        params.push(offerId);
        db.prepare(`UPDATE offers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        bumpRev(db);
      }
      return res.json({ ok: true, id: offerId });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM offers WHERE id = ?').run(offerId);
      bumpRev(db);
      return res.json({ ok: true });
    }
  }

  // VOUCHERS CRUD
  if (req.method === 'GET' && pathname === '/api/admin/vouchers') {
    const vouchers = db.prepare('SELECT * FROM vouchers ORDER BY id DESC').all().map(v => {
      let custName = null;
      if (v.customer_phone) {
        const c = db.prepare('SELECT name FROM customers WHERE phone = ?').get(v.customer_phone);
        if (c) custName = c.name;
      }
      const discType = v.discount_type || 'flat';
      const discVal = Number(v.discount_value || 0);
      return {
        id: v.id,
        code: v.code,
        title: v.title || '',
        description: v.description || v.title || '',
        type: discType,
        discount_type: discType,
        value: discVal,
        discount_value: discVal,
        max_discount: v.max_discount ? Number(v.max_discount) : null,
        min_bill: Number(v.min_bill || 0),
        start_date: v.start_date || null,
        end_date: v.end_date || v.expiry_date || null,
        expiry_date: v.expiry_date || v.end_date || null,
        per_customer: v.per_customer !== undefined && v.per_customer !== null ? Number(v.per_customer) : 1,
        total_limit: v.total_limit ? Number(v.total_limit) : null,
        phone: v.customer_phone || '',
        customer_phone: v.customer_phone || '',
        customer_name: custName,
        uses: Number(v.used_count || 0),
        used_count: Number(v.used_count || 0),
        active: Boolean(v.active)
      };
    });
    return res.json({ vouchers });
  }

  if (req.method === 'POST' && pathname === '/api/admin/vouchers') {
    const b = req.body || {};
    if (!b.code?.trim()) return res.status(400).json({ error: 'Voucher code is required.' });
    const code = b.code.trim().toUpperCase();

    const discType = b.type || b.discount_type || 'flat';
    const discVal = Number(b.value !== undefined ? b.value : (b.discount_value !== undefined ? b.discount_value : 0));
    const minBill = Number(b.min_bill || 0);
    const maxDisc = b.max_discount ? Number(b.max_discount) : null;
    const phone = b.phone?.trim() || b.customer_phone?.trim() || null;
    const startDate = b.start_date || null;
    const endDate = b.end_date || b.expiry_date || null;
    const perCust = b.per_customer !== undefined && b.per_customer !== null && b.per_customer !== '' ? Number(b.per_customer) : 1;
    const totalLimit = b.total_limit ? Number(b.total_limit) : null;
    const active = b.active !== false ? 1 : 0;

    const resInsert = db.prepare(`
      INSERT INTO vouchers (code, title, description, discount_type, discount_value, min_bill, customer_phone, expiry_date, active, max_discount, start_date, end_date, per_customer, total_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code, b.title || '', b.description || '', discType,
      discVal, minBill, phone, endDate, active,
      maxDisc, startDate, endDate, perCust, totalLimit
    );

    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), code });
  }

  const voucherIdMatch = pathname.match(/^\/api\/admin\/vouchers\/(\d+)$/);
  if (voucherIdMatch) {
    const voucherId = Number(voucherIdMatch[1]);
    if (req.method === 'PUT') {
      const b = req.body || {};
      const fields = [];
      const params = [];

      if (b.code !== undefined) { fields.push('code = ?'); params.push(b.code.toUpperCase().trim()); }
      if (b.description !== undefined) { fields.push('description = ?'); params.push(b.description.trim()); }
      if (b.title !== undefined) { fields.push('title = ?'); params.push(b.title.trim()); }
      const discType = b.type || b.discount_type;
      if (discType !== undefined) { fields.push('discount_type = ?'); params.push(discType); }
      const discVal = b.value !== undefined ? b.value : b.discount_value;
      if (discVal !== undefined) { fields.push('discount_value = ?'); params.push(Number(discVal)); }
      if (b.min_bill !== undefined) { fields.push('min_bill = ?'); params.push(Number(b.min_bill)); }
      if (b.max_discount !== undefined) { fields.push('max_discount = ?'); params.push(b.max_discount ? Number(b.max_discount) : null); }
      const phone = b.phone !== undefined ? b.phone : b.customer_phone;
      if (phone !== undefined) { fields.push('customer_phone = ?'); params.push(phone?.trim() || null); }
      if (b.start_date !== undefined) { fields.push('start_date = ?'); params.push(b.start_date || null); }
      const endDate = b.end_date !== undefined ? b.end_date : b.expiry_date;
      if (endDate !== undefined) {
        fields.push('end_date = ?', 'expiry_date = ?');
        params.push(endDate || null, endDate || null);
      }
      if (b.per_customer !== undefined) {
        fields.push('per_customer = ?');
        params.push(b.per_customer !== null && b.per_customer !== '' ? Number(b.per_customer) : 1);
      }
      if (b.total_limit !== undefined) {
        fields.push('total_limit = ?');
        params.push(b.total_limit ? Number(b.total_limit) : null);
      }
      if (b.active !== undefined) { fields.push('active = ?'); params.push(b.active ? 1 : 0); }

      if (fields.length > 0) {
        params.push(voucherId);
        db.prepare(`UPDATE vouchers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        bumpRev(db);
      }
      return res.json({ ok: true, id: voucherId });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM vouchers WHERE id = ?').run(voucherId);
      bumpRev(db);
      return res.json({ ok: true });
    }
  }

  // REWARDS CRUD
  if (req.method === 'GET' && pathname === '/api/admin/rewards') {
    const rewards = db.prepare('SELECT * FROM rewards ORDER BY points ASC').all().map(r => ({
      id: r.id,
      name: r.name,
      points: r.points,
      type: r.type,
      value: r.value,
      min_bill: r.min_bill,
      category_id: r.category_id || undefined,
      active: Boolean(r.active)
    }));
    return res.json({ rewards });
  }

  if (req.method === 'POST' && pathname === '/api/admin/rewards') {
    const b = req.body || {};
    const resInsert = db.prepare(`
      INSERT INTO rewards (name, points, type, value, min_bill, category_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(b.name, Number(b.points || 0), b.type || 'amount', Number(b.value || 0), Number(b.min_bill || 0), b.category_id || null, b.active !== false ? 1 : 0);

    bumpRev(db);
    return res.json({ id: Number(resInsert.lastInsertRowid), ok: true });
  }

  const rewardIdMatch = pathname.match(/^\/api\/admin\/rewards\/(\d+)$/);
  if (rewardIdMatch) {
    const rewardId = Number(rewardIdMatch[1]);
    if (req.method === 'PUT') {
      const b = req.body || {};
      if (b.active !== undefined) db.prepare('UPDATE rewards SET active = ? WHERE id = ?').run(b.active ? 1 : 0, rewardId);
      bumpRev(db);
      return res.json({ ok: true, id: rewardId });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM rewards WHERE id = ?').run(rewardId);
      bumpRev(db);
      return res.json({ ok: true });
    }
  }

  // LOYALTY SETTINGS
  if (req.method === 'GET' && pathname === '/api/admin/loyalty') {
    const row = db.prepare('SELECT * FROM loyalty_settings WHERE id = 1').get();
    return res.json({
      enabled: Boolean(row.enabled),
      earn_points: row.earn_points,
      earn_per: row.earn_per,
      expiry_months: row.expiry_months,
      welcome_points: row.welcome_points,
      birthday: {
        enabled: Boolean(row.birthday_enabled),
        type: row.birthday_type,
        value: row.birthday_value,
        min_bill: row.birthday_min_bill,
        days_before: row.birthday_days_before,
        days_after: row.birthday_days_after
      }
    });
  }

  if (req.method === 'PUT' && pathname === '/api/admin/loyalty') {
    const b = req.body || {};
    const bday = b.birthday || {};
    db.prepare(`
      UPDATE loyalty_settings SET
        enabled = ?, earn_points = ?, earn_per = ?, expiry_months = ?, welcome_points = ?,
        birthday_enabled = ?, birthday_type = ?, birthday_value = ?, birthday_min_bill = ?,
        birthday_days_before = ?, birthday_days_after = ?
      WHERE id = 1
    `).run(
      b.enabled ? 1 : 0, Number(b.earn_points || 1), Number(b.earn_per || 100),
      Number(b.expiry_months || 0), Number(b.welcome_points || 0),
      bday.enabled ? 1 : 0, bday.type || 'percent', Number(bday.value || 0),
      Number(bday.min_bill || 0), Number(bday.days_before || 3), Number(bday.days_after || 3)
    );

    bumpRev(db);
    return res.json({ ok: true });
  }

  // CUSTOMERS
  if (req.method === 'GET' && pathname === '/api/admin/customers') {
    const q = query.get('q')?.trim() || '';
    const all = query.get('all') === '1' || query.get('export') === '1';
    let customers;
    if (q) {
      customers = db.prepare(`
        SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY points DESC, id DESC ${all ? '' : 'LIMIT 50'}
      `).all(`%${q}%`, `%${q}%`);
    } else {
      customers = db.prepare(`SELECT * FROM customers ORDER BY points DESC, id DESC ${all ? '' : 'LIMIT 50'}`).all();
    }

    return res.json({
      customers: customers.map(c => {
        const stats = db.prepare(`
          SELECT COUNT(*) as visits, COALESCE(SUM(total), 0) as spent
          FROM orders WHERE customer_id = ? AND status != 'cancelled'
        `).get(c.id) || { visits: 0, spent: 0 };
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          points: c.points,
          has_pin: Boolean(c.pin_hash),
          rating: c.rating,
          visits: Number(stats.visits || 0),
          spent: Number(stats.spent || 0),
          note: c.note || undefined,
          dob: c.dob || undefined,
          birthday: c.birthday || undefined,
          age: c.age || undefined,
          since: c.since || undefined,
          created_at: c.since || new Date().toISOString(),
          last_visit: c.last_visit || undefined
        };
      })
    });
  }

  const custDetailsMatch = pathname.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (custDetailsMatch) {
    const custId = Number(custDetailsMatch[1]);
    if (req.method === 'GET') {
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
      if (!c) return res.status(404).json({ error: 'Customer not found.' });

      const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(custId)
        .map(o => formatOrder(db, o));

      const stats = db.prepare(`
        SELECT COUNT(*) as visits, COALESCE(SUM(total), 0) as spent
        FROM orders WHERE customer_id = ? AND status != 'cancelled'
      `).get(c.id) || { visits: 0, spent: 0 };

      return res.json({
        customer: {
          id: c.id,
          name: c.name,
          phone: c.phone,
          points: c.points,
          held: 0,
          has_pin: Boolean(c.pin_hash),
          pin_blocked: false,
          visits: Number(stats.visits || 0),
          spent: Number(stats.spent || 0),
          rating: c.rating,
          note: c.note || '',
          dob: c.dob || '',
          age: c.age || '',
          since: c.since || '',
          created_at: c.since || new Date().toISOString(),
          last_visit: c.last_visit || ''
        },
        orders
      });
    }

    if (req.method === 'PUT') {
      const { name, phone, note, rating } = req.body || {};
      if (name) db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name.trim(), custId);
      if (phone) db.prepare('UPDATE customers SET phone = ? WHERE id = ?').run(phone.trim(), custId);
      if (note !== undefined) db.prepare('UPDATE customers SET note = ? WHERE id = ?').run(note, custId);
      if (rating !== undefined) db.prepare('UPDATE customers SET rating = ? WHERE id = ?').run(Number(rating), custId);
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM customers WHERE id = ?').run(custId);
      return res.json({ ok: true });
    }
  }

  // ADD CUSTOMER
  if (req.method === 'POST' && pathname === '/api/admin/customers') {
    const { name, phone } = req.body || {};
    if (!name?.trim() || !phone?.trim()) return res.status(400).json({ error: 'Name and phone are required.' });

    const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone.trim());
    if (existing) return res.status(400).json({ error: 'Customer with this phone number already exists.' });

    const today = new Date().toISOString().slice(0, 10);
    const resInsert = db.prepare(`
      INSERT INTO customers (name, phone, points, rating, since, last_visit) VALUES (?, ?, 0, 5, ?, ?)
    `).run(name.trim(), phone.trim(), today, today);

    return res.json({ id: Number(resInsert.lastInsertRowid), ok: true });
  }

  // CUSTOMER POINTS
  const custPointsMatch = pathname.match(/^\/api\/admin\/customers\/(\d+)\/points$/);
  if (req.method === 'POST' && custPointsMatch) {
    const custId = Number(custPointsMatch[1]);
    const { mode, amount, reason } = req.body || {};
    const amt = Number(amount || 0);

    const c = db.prepare('SELECT points FROM customers WHERE id = ?').get(custId);
    if (!c) return res.status(404).json({ error: 'Customer not found.' });

    let newPoints = c.points;
    if (mode === 'add') newPoints += amt;
    else if (mode === 'subtract') newPoints = Math.max(0, newPoints - amt);
    else if (mode === 'set') newPoints = amt;

    db.prepare('UPDATE customers SET points = ? WHERE id = ?').run(newPoints, custId);
    db.prepare(`
      INSERT INTO customer_points_log (customer_id, mode, amount, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(custId, mode, amt, reason || 'Staff adjustment', new Date().toISOString());

    return res.json({ points: newPoints });
  }

  // CUSTOMER PIN CLEAR
  const pinClearMatch = pathname.match(/^\/api\/admin\/customers\/(\d+)\/pin\/clear$/);
  if (req.method === 'POST' && pinClearMatch) {
    const custId = Number(pinClearMatch[1]);
    db.prepare('UPDATE customers SET pin_hash = NULL WHERE id = ?').run(custId);
    bumpRev(db);
    return res.json({ ok: true });
  }

  // REPORTS
  if (req.method === 'GET' && pathname === '/api/admin/report-data') {
    const fromParam = query.get('from');
    const toParam = query.get('to');
    const cafeName = getSetting(db, 'cafe_name', 'Muse Bread & Brew');

    let orders;
    if (fromParam && toParam) {
      orders = db.prepare(`
        SELECT * FROM orders WHERE created_at >= ? AND created_at <= ? ORDER BY id ASC
      `).all(`${fromParam}T00:00:00.000Z`, `${toParam}T23:59:59.999Z`);
    } else {
      orders = db.prepare('SELECT * FROM orders ORDER BY id ASC').all();
    }

    return res.json({
      cafe: cafeName,
      orders: orders.map(o => formatOrder(db, o))
    });
  }

  // MANAGER SECURITY PIN VERIFICATION & CHANGE
  if (req.method === 'POST' && pathname === '/api/admin/verify-pin') {
    const { pin } = req.body || {};
    const storedPin = getSetting(db, 'manager_pin', '1234');
    if (!pin || String(pin).trim() !== String(storedPin).trim()) {
      return res.status(401).json({ error: 'Incorrect 4-digit PIN.' });
    }
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/admin/security-pin') {
    const { current_pin, new_pin } = req.body || {};
    const storedPin = getSetting(db, 'manager_pin', '1234');
    if (String(current_pin).trim() !== String(storedPin).trim()) {
      return res.status(400).json({ error: 'Current PIN is incorrect.' });
    }
    if (!new_pin || !/^\d{4}$/.test(String(new_pin).trim())) {
      return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
    }
    setSetting(db, 'manager_pin', String(new_pin).trim());
    bumpRev(db);
    return res.json({ ok: true, message: 'Manager PIN updated successfully.' });
  }

  // SETTINGS
  if (req.method === 'GET' && pathname === '/api/admin/settings') {
    const rawUrl = getSetting(db, 'customer_url', '');
    const lanIp = getLanIp();
    const reqHost = req.headers.host;
    let customerUrl = rawUrl;
    if (!customerUrl || customerUrl.includes('localhost') || customerUrl.includes('127.0.0.1')) {
      if (reqHost && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1')) {
        customerUrl = `http://${reqHost}`;
      } else if (lanIp && lanIp !== '127.0.0.1') {
        customerUrl = `http://${lanIp}:3000`;
      } else {
        customerUrl = 'http://localhost:3000';
      }
    }
    const customSoundFile = path.join(__dirname, '..', 'public', 'custom-sound.audio');
    const hasCustom = getSetting(db, 'sound_has_custom') === 'true' && fs.existsSync(customSoundFile);
    const customLogoFile = path.join(__dirname, '..', 'public', 'custom-logo.png');
    const hasCustomLogo = fs.existsSync(customLogoFile);
    return res.json({
      cafe_name: getSetting(db, 'cafe_name', 'Muse Bread & Brew'),
      customer_url: customerUrl,
      ordering_open: getSetting(db, 'ordering_open', 'true') === 'true',
      customer_pin: getSetting(db, 'customer_pin', 'true') === 'true',
      lock_minutes: Number(getSetting(db, 'lock_minutes', '15')),
      sound_type: getSetting(db, 'sound_type', 'bell'),
      sound_name: getSetting(db, 'sound_name', 'Kitchen Brass Bell (Default)'),
      sound_volume: Number(getSetting(db, 'sound_volume', '1.0')),
      sound_url: hasCustom ? '/custom-sound.audio' : null,
      has_custom_logo: hasCustomLogo,
      logo_url: hasCustomLogo ? '/custom-logo.png' : '/logo-256.webp'
    });
  }

  if (req.method === 'PUT' && pathname === '/api/admin/settings') {
    const b = req.body || {};
    if (b.cafe_name !== undefined) setSetting(db, 'cafe_name', b.cafe_name.trim());
    if (b.customer_url !== undefined) setSetting(db, 'customer_url', b.customer_url.trim());
    if (b.ordering_open !== undefined) setSetting(db, 'ordering_open', b.ordering_open ? 'true' : 'false');
    if (b.customer_pin !== undefined) setSetting(db, 'customer_pin', b.customer_pin ? 'true' : 'false');
    if (b.lock_minutes !== undefined) setSetting(db, 'lock_minutes', Number(b.lock_minutes));
    if (b.sound_type !== undefined) setSetting(db, 'sound_type', b.sound_type);
    if (b.sound_name !== undefined) setSetting(db, 'sound_name', b.sound_name);
    if (b.sound_volume !== undefined) setSetting(db, 'sound_volume', Number(b.sound_volume));

    bumpRev(db);
    return res.json({ ok: true });
  }

  // NOTIFICATION SOUND CONFIG & UPLOAD
  if (req.method === 'POST' && pathname === '/api/admin/sound') {
    const { sound_type, sound_name, sound_data, sound_volume } = req.body || {};
    if (sound_volume !== undefined) setSetting(db, 'sound_volume', Number(sound_volume));
    if (sound_type) setSetting(db, 'sound_type', sound_type);
    if (sound_name) setSetting(db, 'sound_name', sound_name);

    if (sound_data && typeof sound_data === 'string') {
      try {
        const matches = sound_data.match(/^data:([A-Za-z0-9\-+\/]+);base64,(.+)$/);
        const base64Str = matches ? matches[2] : sound_data;
        const buffer = Buffer.from(base64Str, 'base64');
        const customPath = path.join(__dirname, '..', 'public', 'custom-sound.audio');
        fs.writeFileSync(customPath, buffer);
        setSetting(db, 'sound_has_custom', 'true');
        setSetting(db, 'sound_type', 'custom');
      } catch (err) {
        console.error('Failed to save custom audio file:', err);
      }
    } else if (sound_type && sound_type !== 'custom') {
      setSetting(db, 'sound_has_custom', 'false');
    }

    bumpRev(db);
    const customSoundFile = path.join(__dirname, '..', 'public', 'custom-sound.audio');
    const hasCustom = getSetting(db, 'sound_has_custom') === 'true' && fs.existsSync(customSoundFile);
    return res.json({
      ok: true,
      sound_type: getSetting(db, 'sound_type', 'bell'),
      sound_name: getSetting(db, 'sound_name', 'Kitchen Brass Bell (Default)'),
      sound_volume: Number(getSetting(db, 'sound_volume', '1.0')),
      sound_url: hasCustom ? '/custom-sound.audio' : null
    });
  }

  // BUSINESS LOGO UPLOAD & RESET
  if (req.method === 'POST' && pathname === '/api/admin/logo') {
    const { logo_data } = req.body || {};
    if (!logo_data || typeof logo_data !== 'string') {
      return res.status(400).json({ error: 'Image data is required.' });
    }
    try {
      const matches = logo_data.match(/^data:([A-Za-z0-9\-+\/]+);base64,(.+)$/);
      const base64Str = matches ? matches[2] : logo_data;
      const buffer = Buffer.from(base64Str, 'base64');
      const customLogoPath = path.join(__dirname, '..', 'public', 'custom-logo.png');
      fs.writeFileSync(customLogoPath, buffer);
      setSetting(db, 'has_custom_logo', 'true');
      bumpRev(db);
      return res.json({ ok: true, logo_url: '/custom-logo.png?t=' + Date.now(), message: 'Logo uploaded successfully.' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save logo: ' + err.message });
    }
  }

  if ((req.method === 'POST' && pathname === '/api/admin/logo/reset') || (req.method === 'DELETE' && pathname === '/api/admin/logo')) {
    const customLogoPath = path.join(__dirname, '..', 'public', 'custom-logo.png');
    try {
      if (fs.existsSync(customLogoPath)) fs.unlinkSync(customLogoPath);
    } catch {}
    setSetting(db, 'has_custom_logo', 'false');
    bumpRev(db);
    return res.json({ ok: true, logo_url: '/logo-256.webp', message: 'Logo reset to default.' });
  }

  // PASSWORD UPDATE
  if (req.method === 'POST' && pathname === '/api/admin/password') {
    const { current, username, password } = req.body || {};
    const storedHash = getSetting(db, 'admin_password_hash');

    if (!current || hashSecret(current) !== storedHash) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    if (username?.trim()) {
      setSetting(db, 'admin_username', username.trim());
    }
    if (password?.trim()) {
      setSetting(db, 'admin_password_hash', hashSecret(password.trim()));
    }

    return res.json({ ok: true });
  }

  // BACKUP
  if (req.method === 'GET' && pathname === '/api/admin/backup') {
    const cafeName = getSetting(db, 'cafe_name', 'Muse Bread & Brew');
    const customers = db.prepare('SELECT * FROM customers').all();
    const orders = db.prepare('SELECT * FROM orders').all().map(o => {
      const items = db.prepare('SELECT name, qty FROM order_items WHERE order_id = ?').all(o.id);
      return {
        ...o,
        items_text: items.map(i => `${i.qty}x ${i.name}`).join(', ')
      };
    });
    const tables = db.prepare('SELECT * FROM tables').all();
    const settings = db.prepare('SELECT * FROM settings').all();

    return res.json({
      cafe: cafeName,
      customers,
      orders,
      tables,
      settings
    });
  }

  // CLEAR ORDERS & BILLS (Manual Fresh Start)
  if (req.method === 'POST' && (pathname === '/api/admin/clear-orders' || pathname === '/api/admin/clear-data')) {
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM waiter_calls').run();
    db.prepare('DELETE FROM pin_resets').run();
    try {
      db.prepare("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'orders'").run();
    } catch {}
    bumpRev(db);
    return res.json({ ok: true, message: 'All orders and bills cleared successfully. Customers and points remain safe.' });
  }

  return false; // Not handled
}

module.exports = {
  handleAdmin
};

