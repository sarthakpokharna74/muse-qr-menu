const { getLanIp } = require('../utils');

function bumpRev(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pulse_rev');
    const current = row ? Number(row.value) : 1;
    const next = current + 1;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('pulse_rev', String(next));
    return next;
  } catch {
    return 1;
  }
}

function handleKitchen(req, res, pathname, query, db) {
  // 1. GET /api/kitchen/pulse - lightweight poll check
  if (req.method === 'GET' && pathname === '/api/kitchen/pulse') {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pulse_rev');
    const rev = row ? Number(row.value) : 1;
    const activeCount = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status IN ('open', 'received', 'preparing', 'ready')
    `).get().count;
    return res.json({ rev, activeCount });
  }

  // 2. GET /api/kitchen/orders - list of all active orders for chef
  if (req.method === 'GET' && pathname === '/api/kitchen/orders') {
    const statusFilter = query.status; // optional: 'preparing', 'ready', 'received'
    let sql = `
      SELECT id, number, table_number, status, note, created_at, updated_at
      FROM orders
      WHERE status IN ('open', 'received', 'preparing', 'ready')
    `;
    const params = [];
    if (statusFilter) {
      if (statusFilter === 'active') {
        sql = `SELECT id, number, table_number, status, note, created_at, updated_at FROM orders WHERE status IN ('open', 'received', 'preparing')`;
      } else if (statusFilter === 'ready') {
        sql = `SELECT id, number, table_number, status, note, created_at, updated_at FROM orders WHERE status = 'ready'`;
      } else if (statusFilter === 'history') {
        sql = `SELECT id, number, table_number, status, note, created_at, updated_at FROM orders WHERE status IN ('served', 'done') ORDER BY id DESC LIMIT 20`;
      }
    } else {
      sql += ` ORDER BY created_at ASC`;
    }

    const orders = db.prepare(sql).all(...params);

    const now = Date.now();
    const result = orders.map(o => {
      const items = db.prepare(`
        SELECT id, name, qty, note
        FROM order_items
        WHERE order_id = ?
      `).all(o.id);

      const createdTime = new Date(o.created_at).getTime();
      const elapsedMin = Math.max(0, Math.floor((now - createdTime) / 60000));

      return {
        id: o.id,
        number: o.number,
        table_number: o.table_number,
        status: o.status === 'open' ? 'received' : o.status,
        note: o.note || '',
        items,
        created_at: o.created_at,
        updated_at: o.updated_at,
        elapsed_minutes: elapsedMin
      };
    });

    // Counts summary
    const counts = {
      received: result.filter(o => o.status === 'received').length,
      preparing: result.filter(o => o.status === 'preparing').length,
      ready: result.filter(o => o.status === 'ready').length,
      total: result.length
    };

    return res.json({ orders: result, counts });
  }

  // 3. POST /api/kitchen/orders/:id/status - Chef updates cooking status
  const statusMatch = pathname.match(/^\/api\/kitchen\/orders\/(\d+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    const orderId = Number(statusMatch[1]);
    const { status } = req.body || {};

    const validStatuses = ['received', 'preparing', 'ready', 'served'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso, orderId);

    // Bump pulse rev so owner dashboard immediately hears/sees food ready or preparing
    bumpRev(db);

    return res.json({
      ok: true,
      order_id: orderId,
      status,
      updated_at: nowIso,
      table_number: order.table_number,
      order_number: order.number
    });
  }

  return false;
}

module.exports = {
  handleKitchen
};
