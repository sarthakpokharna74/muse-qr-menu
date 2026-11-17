// Muse Bread & Brew · High-Performance Customer Mobile Ordering App
(function() {
  'use strict';

  // State
  const state = {
    token: extractToken(),
    table: null,
    cafe: null,
    categories: [],
    items: [],
    offers: [],
    vouchers: [],
    rewards: [],
    loyalty: null,
    cart: {}, // { [itemId]: { item, qty, note } }
    appliedVoucher: null,
    appliedReward: null,
    customer: loadSavedCustomer(),
    activeCategory: 'all',
    searchQuery: '',
    currentOrder: null,
    noteEditingItemId: null
  };

  function extractToken() {
    let t = window.location.pathname.split('/t/')[1];
    if (t) return t.replace(/\/$/, '');
    const params = new URLSearchParams(window.location.search);
    return params.get('t') || '';
  }

  function loadSavedCustomer() {
    try {
      const data = localStorage.getItem('muse_customer');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  function saveCustomer(cust) {
    state.customer = cust;
    try {
      if (cust) localStorage.setItem('muse_customer', JSON.stringify(cust));
      else localStorage.removeItem('muse_customer');
    } catch {}
    updateCustomerUI();
  }

  // Customer Audio Chime Synthesizer
  let custAudioCtx = null;
  function playCustomerChime(type = 'bell') {
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;
      if (!custAudioCtx) custAudioCtx = new AudioCtxClass();
      if (custAudioCtx.state === 'suspended') custAudioCtx.resume();

      const now = custAudioCtx.currentTime;
      let tones = [
        { freq: 880.0, time: 0, gain: 0.35, decay: 0.4 },
        { freq: 1318.5, time: 0.12, gain: 0.35, decay: 0.6 }
      ];

      if (type === 'bill') {
        tones = [
          { freq: 1046.5, time: 0, gain: 0.35, decay: 0.35 },
          { freq: 783.99, time: 0.14, gain: 0.35, decay: 0.5 }
        ];
      } else if (type === 'order') {
        tones = [
          { freq: 659.25, time: 0, gain: 0.4, decay: 0.3 },
          { freq: 880.00, time: 0.14, gain: 0.4, decay: 0.6 }
        ];
      }

      tones.forEach(t => {
        const osc = custAudioCtx.createOscillator();
        const gain = custAudioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(t.freq, now + t.time);
        gain.gain.setValueAtTime(0.0001, now + t.time);
        gain.gain.linearRampToValueAtTime(t.gain, now + t.time + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t.time + t.decay);
        osc.connect(gain);
        gain.connect(custAudioCtx.destination);
        osc.start(now + t.time);
        osc.stop(now + t.time + t.decay + 0.05);
      });
    } catch {}
  }

  // Toast Notification
  let toastTimer = null;
  function showToast(text, icon = '☕') {
    const el = document.getElementById('toast');
    const txt = document.getElementById('toastText');
    const icn = document.getElementById('toastIcon');
    if (!el) return;

    if (txt) txt.textContent = text;
    if (icn) icn.textContent = icon;
    el.classList.add('show');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 2600);
  }

  // API Fetch
  async function init() {
    try {
      if (!state.token) {
        const resTables = await fetch('/api/admin/tables').then(r => r.json()).catch(() => ({}));
        if (resTables.tables && resTables.tables.length > 0) {
          state.token = resTables.tables[0].qr_token;
        } else {
          state.token = 'tbl-1-demo';
        }
      }

      const res = await fetch(`/api/customer/table/${state.token}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Could not load table menu.' }));
        renderError(err.error || 'Table not found.');
        return;
      }

      const data = await res.json();
      state.table = data.table;
      state.cafe = data.cafe;
      state.categories = data.categories || [];
      state.items = data.items || [];
      state.offers = data.offers || [];
      state.vouchers = data.vouchers || [];
      state.rewards = data.rewards || [];
      state.loyalty = data.loyalty;

      setupPage();

      // Sync latest loyalty points from server if customer is logged in
      if (state.customer && state.customer.phone) {
        syncCustomerPoints(state.customer.phone);
      }

      // Check if there was an active order placed for this table
      const savedOrderId = sessionStorage.getItem(`muse_order_${state.table.id}`);
      if (savedOrderId) {
        startPollingOrder(savedOrderId, false);
      } else {
        // Also check if table has active running orders on server
        fetch(`/api/customer/table/${state.token}/active-orders`)
          .then(r => r.json())
          .then(d => {
            const orders = d.orders || [];
            const running = orders.find(o => o.status === 'open' || o.status === 'received' || o.status === 'served');
            if (running) {
              state.currentOrder = running;
              sessionStorage.setItem(`muse_order_${state.table.id}`, running.id);
              updateOrderTrackingUI(running);
              updateActiveOrderTrackerPill();
              startPollingOrder(running.id, false);
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      renderError(e.message || 'Network connection failed.');
    }
  }

  function renderError(msg) {
    const container = document.getElementById('menuItemsContainer');
    if (container) {
      container.innerHTML = `
        <div style="padding: 50px 20px; text-align: center;">
          <div style="font-size: 2.8rem; margin-bottom: 12px;">☕</div>
          <h2 style="font-family: var(--display); font-size: 1.5rem; margin-bottom: 8px;">Welcome!</h2>
          <p class="muted" style="margin-bottom: 20px;">${msg}</p>
          <button type="button" class="btn" onclick="location.reload()">Reload Menu</button>
        </div>
      `;
    }
  }

  // Setup DOM elements once
  function setupPage() {
    // 1. Header Info
    const tableHeaderPill = document.getElementById('tableHeaderPill');
    if (tableHeaderPill && state.table) {
      tableHeaderPill.textContent = `Table ${state.table.number}`;
    }

    const cafeNameHero = document.getElementById('cafeNameHero');
    if (cafeNameHero && state.cafe) {
      cafeNameHero.innerHTML = `${state.cafe.name}`;
      if (state.table) {
        document.title = `${state.cafe.name} · Table ${state.table.number}`;
      }
    }

    const cafeHeroLogo = document.getElementById('cafeHeroLogo');
    if (cafeHeroLogo && state.cafe && state.cafe.logo_url) {
      cafeHeroLogo.src = state.cafe.logo_url + '?t=' + Date.now();
    }

    const cartDrawerTitle = document.getElementById('cartDrawerTitle');
    if (cartDrawerTitle && state.table) {
      cartDrawerTitle.textContent = `Table ${state.table.number} Order`;
    }

    // 2. Ordering Paused Notice
    const pausedBanner = document.getElementById('orderingPausedBanner');
    if (pausedBanner && state.cafe && !state.cafe.ordering_open) {
      pausedBanner.style.display = 'block';
    }

    // 3. Offers Carousel
    const offersSection = document.getElementById('offersSection');
    const offersContainer = document.getElementById('offersScrollContainer');
    if (offersSection && offersContainer && state.offers.length > 0) {
      const activeOffers = state.offers.filter(isOfferActiveNow);
      if (activeOffers.length > 0) {
        offersSection.style.display = 'block';
        offersContainer.innerHTML = activeOffers.map((off, idx) => `
          <article class="offer-card tone-${idx % 3}">
            <div>
              <div class="offer-big">
                ${off.discount_type === 'percent' ? `${off.discount_value}% OFF` : (off.discount_type === 'free_item' ? 'FREE ITEM' : `₹${off.discount_value} OFF`)}
              </div>
              <div class="offer-title">${escapeHtml(off.title)}</div>
              <div class="offer-desc">${escapeHtml(off.description || '')}</div>
            </div>
            <div class="offer-when">
              ${off.min_bill ? `Min bill ₹${off.min_bill} · ` : ''}Auto-applied in cart
            </div>
          </article>
        `).join('');
      } else {
        offersSection.style.display = 'none';
      }
    }

    // 4. Available Vouchers in Cart
    renderAvailableVouchers();

    // 5. Category Chips
    const chipsContainer = document.getElementById('categoryChipsContainer');
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="chip on" data-cat="all">All</button>
        ${state.categories.map(c => `
          <button type="button" class="chip" data-cat="${c.id}">${escapeHtml(c.name)}</button>
        `).join('')}
      `;
    }

    // 6. Build Menu Items List
    renderMenuItems();

    // 7. Update Customer Profile State
    updateCustomerUI();

    // 8. Bind All Static Listeners
    attachStaticEvents();
  }

  function renderAvailableVouchers() {
    const list = document.getElementById('availableVouchersList');
    if (!list) return;

    if (!state.vouchers.length) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = state.vouchers.map(v => `
      <button type="button" class="voucher-chip-btn" data-vcode="${v.code}">
        <span>🏷️</span>
        <span><strong>${v.code}</strong> (${v.discount_type === 'percent' ? `${v.discount_value}% off` : `₹${v.discount_value} off`}${v.min_bill ? `, min ₹${v.min_bill}` : ''})</span>
      </button>
    `).join('');

    list.querySelectorAll('[data-vcode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-vcode');
        applyVoucherCode(code);
      });
    });
  }

  function renderMenuItems() {
    const container = document.getElementById('menuItemsContainer');
    if (!container) return;

    let html = '';
    state.categories.forEach(cat => {
      const catItems = state.items.filter(it => it.category_id === cat.id);
      if (!catItems.length) return;

      html += `
        <section class="menu-cat-section" data-cat-id="${cat.id}" style="margin-bottom: 24px;">
          <h3 class="section-title" style="font-size: 1.15rem; border-bottom: 1.5px solid var(--line); padding-bottom: 6px; margin-bottom: 10px;">
            ${escapeHtml(cat.name)}
          </h3>
          <ul class="items">
            ${catItems.map(it => `
              <li class="item ${!it.available ? 'sold' : ''}" data-item-id="${it.id}">
                <div class="item-text">
                  <div class="item-name">
                    ${escapeHtml(it.name)}
                    ${!it.available ? `<span class="badge" style="background:#eed4cc; color:var(--danger); margin-left:6px; font-size:0.75rem;">Sold out</span>` : ''}
                  </div>
                  ${it.description ? `<p class="item-desc">${escapeHtml(it.description)}</p>` : ''}
                  <div class="item-price">₹${it.price}</div>
                  <div class="item-note-row" id="itemNoteRow_${it.id}" style="display: none; font-size: 0.76rem; color: var(--terracotta-ink); margin-top: 3px;">
                    Instruction: <span class="note-text"></span>
                  </div>
                  <button type="button" class="order-item-note-btn" id="itemNoteBtn_${it.id}" data-action="edit-note" data-id="${it.id}" style="display: none; background: none; border: none; font-size: 0.78rem; font-weight: 600; color: var(--terracotta-ink); cursor: pointer; padding: 2px 0 0;">
                    ✏️ Add instruction
                  </button>
                </div>

                <div class="item-act" id="actContainer_${it.id}">
                  ${!it.available ? '' : `
                    <button type="button" class="btn add-btn" data-action="add" data-id="${it.id}" style="min-height: 38px; padding: 0 16px; font-size: 0.85rem;" ${state.cafe && !state.cafe.ordering_open ? 'disabled' : ''}>
                      ADD +
                    </button>
                    <div class="stepper" id="stepper_${it.id}" style="display: none;">
                      <button type="button" data-action="dec" data-id="${it.id}">−</button>
                      <span class="qty" id="qty_${it.id}">1</span>
                      <button type="button" data-action="inc" data-id="${it.id}">+</button>
                    </div>
                  `}
                </div>
              </li>
            `).join('')}
          </ul>
        </section>
      `;
    });

    container.innerHTML = html;
  }

  // Fast Category & Search Filtering (Zero-Lag DOM Toggling)
  function applyFilters() {
    const q = state.searchQuery.toLowerCase().trim();
    const activeCat = state.activeCategory;

    document.querySelectorAll('.menu-cat-section').forEach(sec => {
      const catId = sec.getAttribute('data-cat-id');
      const catMatch = activeCat === 'all' || activeCat === catId;

      let visibleCount = 0;
      sec.querySelectorAll('.item').forEach(itemEl => {
        const itemId = Number(itemEl.getAttribute('data-item-id'));
        const it = state.items.find(i => i.id === itemId);
        if (!it) return;

        const nameMatch = it.name.toLowerCase().includes(q) || (it.description && it.description.toLowerCase().includes(q));
        const show = catMatch && (!q || nameMatch);

        itemEl.style.display = show ? 'flex' : 'none';
        if (show) visibleCount++;
      });

      sec.style.display = visibleCount > 0 ? 'block' : 'none';
    });
  }

  // Cart Management
  function addToCart(itemId) {
    const it = state.items.find(i => i.id === itemId);
    if (!it || !it.available) return;

    if (!state.cart[itemId]) {
      state.cart[itemId] = { item: it, qty: 1, note: '' };
    } else {
      state.cart[itemId].qty++;
    }

    updateItemDOM(itemId);
    updateCartBar();
    updateCartDrawer();
  }

  function decreaseCart(itemId) {
    if (!state.cart[itemId]) return;
    if (state.cart[itemId].qty > 1) {
      state.cart[itemId].qty--;
    } else {
      delete state.cart[itemId];
    }

    updateItemDOM(itemId);
    updateCartBar();
    updateCartDrawer();
  }

  function updateItemDOM(itemId) {
    const cartEntry = state.cart[itemId];
    const addBtn = document.querySelector(`.add-btn[data-id="${itemId}"]`);
    const stepper = document.getElementById(`stepper_${itemId}`);
    const qtySpan = document.getElementById(`qty_${itemId}`);
    const noteBtn = document.getElementById(`itemNoteBtn_${itemId}`);
    const noteRow = document.getElementById(`itemNoteRow_${itemId}`);

    if (cartEntry) {
      if (addBtn) addBtn.style.display = 'none';
      if (stepper) stepper.style.display = 'inline-flex';
      if (qtySpan) qtySpan.textContent = cartEntry.qty;
      if (noteBtn) {
        noteBtn.style.display = 'block';
        noteBtn.textContent = cartEntry.note ? '✏️ Edit instruction' : '✏️ Add instruction';
      }
      if (noteRow) {
        if (cartEntry.note) {
          noteRow.style.display = 'block';
          noteRow.querySelector('.note-text').textContent = cartEntry.note;
        } else {
          noteRow.style.display = 'none';
        }
      }
    } else {
      if (addBtn) addBtn.style.display = 'inline-flex';
      if (stepper) stepper.style.display = 'none';
      if (noteBtn) noteBtn.style.display = 'none';
      if (noteRow) noteRow.style.display = 'none';
    }
  }

  function getCartItemCount() {
    return Object.values(state.cart).reduce((sum, line) => sum + line.qty, 0);
  }

  function getCartSubtotal() {
    return Object.values(state.cart).reduce((sum, line) => sum + (line.item.price * line.qty), 0);
  }

  function isOfferActiveNow(off) {
    if (!off || off.active === false) return false;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Date validity
    if (off.start_date && todayStr < off.start_date) return false;
    if (off.end_date && todayStr > off.end_date) return false;

    // Day of week
    if (off.days && off.days !== 'Every day') {
      const daysArr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const currentDay = daysArr[now.getDay()];
      const activeDays = off.days.split(',').map(s => s.trim());
      if (!activeDays.includes(currentDay)) return false;
    }

    // Time of day (Happy Hours)
    if (off.start_time || off.end_time) {
      const curTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (off.start_time && curTime < off.start_time) return false;
      if (off.end_time && curTime > off.end_time) return false;
    }

    return true;
  }

  function getBestOffer(subtotal) {
    if (!state.offers.length || subtotal <= 0) return null;

    let bestOffer = null;
    let bestDiscount = 0;

    for (const off of state.offers) {
      if (!isOfferActiveNow(off)) continue;
      if (off.min_bill && subtotal < Number(off.min_bill)) continue;

      // Category-specific vs whole order
      let applicableSubtotal = subtotal;
      if (off.applies_to && off.applies_to !== 'Whole order' && off.categories && off.categories.length > 0) {
        const catIds = off.categories.map(Number);
        applicableSubtotal = Object.values(state.cart)
          .filter(c => catIds.includes(Number(c.item.category_id)))
          .reduce((sum, c) => sum + (c.item.price * c.qty), 0);
        if (applicableSubtotal <= 0) continue;
      }

      let d = 0;
      if (off.discount_type === 'percent') {
        d = Math.round((applicableSubtotal * Number(off.discount_value)) / 100);
        if (off.max_item_price && d > Number(off.max_item_price)) {
          d = Number(off.max_item_price);
        }
      } else if (off.discount_type === 'flat' || off.discount_type === 'amount') {
        d = Math.min(applicableSubtotal, Number(off.discount_value));
      } else if (off.discount_type === 'free_item') {
        const catIds = off.categories ? off.categories.map(Number) : [];
        const eligibleItems = Object.values(state.cart)
          .filter(c => !catIds.length || catIds.includes(Number(c.item.category_id)))
          .map(c => c.item);
        if (eligibleItems.length > 0) {
          const maxPrice = off.max_item_price ? Number(off.max_item_price) : Infinity;
          const candidates = eligibleItems.filter(it => it.price <= maxPrice);
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.price - a.price);
            d = candidates[0].price;
          }
        }
      }

      if (d > bestDiscount) {
        bestDiscount = d;
        bestOffer = { ...off, computedDiscount: d };
      }
    }
    return bestOffer;
  }

  // Live Customer Points Synchronizer
  async function syncCustomerPoints(phone) {
    if (!phone) return;
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10) return;

    try {
      const res = await fetch('/api/customer/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.exists) {
          state.customer = {
            name: data.name,
            phone: cleanPhone,
            points: Number(data.points || 0)
          };
          saveCustomer(state.customer);
          updateCustomerUI();
        }
      }
    } catch {}
  }

  function calculateBill() {
    const subtotal = getCartSubtotal();
    const bestOffer = getBestOffer(subtotal);

    let voucherDiscount = 0;
    if (state.appliedVoucher) {
      const v = state.appliedVoucher;
      if (v.min_bill && subtotal < Number(v.min_bill)) {
        state.appliedVoucher = null;
        showToast(`Coupon ${v.code} removed: min order ₹${v.min_bill} required`, '⚠️');
      } else {
        if (v.discount_type === 'percent') {
          voucherDiscount = Math.round((subtotal * Number(v.discount_value)) / 100);
          if (v.max_discount && voucherDiscount > Number(v.max_discount)) {
            voucherDiscount = Number(v.max_discount);
          }
        } else {
          voucherDiscount = Math.min(subtotal, Number(v.discount_value || v.discount || 0));
        }
        state.appliedVoucher.discount = voucherDiscount;
      }
    }

    let discount = 0;
    let savingsReason = '';

    if (state.appliedVoucher && voucherDiscount > 0) {
      discount = Math.min(subtotal, voucherDiscount);
      savingsReason = `Saved ₹${discount} with ${state.appliedVoucher.code}`;

      // If store auto-offer gives even more, give customer the higher savings!
      if (bestOffer && bestOffer.computedDiscount > voucherDiscount) {
        discount = Math.min(subtotal, bestOffer.computedDiscount);
        savingsReason = `Saved ₹${discount} with ${bestOffer.title} (better than ${state.appliedVoucher.code})`;
      }
    } else if (bestOffer && bestOffer.computedDiscount > 0) {
      discount = Math.min(subtotal, bestOffer.computedDiscount);
      savingsReason = `Saved ₹${discount} with ${bestOffer.title}`;
    }

    // Loyalty Reward discount
    let rewardDiscount = 0;
    let rewardReason = '';
    if (state.appliedReward) {
      const r = state.appliedReward;
      if (r.min_bill && subtotal < r.min_bill) {
        state.appliedReward = null;
        showToast(`Reward removed: minimum bill ₹${r.min_bill} required`, '⚠️');
      } else {
        rewardDiscount = Math.min(subtotal - discount, Number(r.value || 0));
        rewardReason = `🎁 ${r.name} (−${r.points} pts)`;
      }
    }

    const discountedTotal = Math.max(0, subtotal - discount - rewardDiscount);
    const gst = Math.round(discountedTotal * 0.05); // 5% GST
    const grandTotal = discountedTotal + gst;

    // Calculate points that will be earned on this order
    const earnPoints = state.loyalty?.earn_points || 1;
    const earnPer = state.loyalty?.earn_per || 100;
    const pointsEarned = (state.loyalty?.enabled && earnPer) ? Math.floor(grandTotal / earnPer) * earnPoints : 0;

    return {
      subtotal,
      discount,
      savingsReason,
      rewardDiscount,
      rewardReason,
      gst,
      grandTotal,
      pointsEarned
    };
  }

  function updateCartBar() {
    const bar = document.getElementById('floatingCartBar');
    const qtySpan = document.getElementById('cartBarQty');
    const totalSpan = document.getElementById('cartBarTotal');
    if (!bar) return;

    const count = getCartItemCount();
    const bill = calculateBill();

    if (count > 0 && state.cafe && state.cafe.ordering_open) {
      bar.classList.add('visible');
      if (qtySpan) qtySpan.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
      if (totalSpan) totalSpan.textContent = `₹${bill.grandTotal}`;
    } else {
      bar.classList.remove('visible');
    }
    updateActiveOrderTrackerPill();
  }

  // Floating Active Order Tracker Pill Manager
  function updateActiveOrderTrackerPill() {
    const pill = document.getElementById('floatingActiveOrderPill');
    const titleEl = document.getElementById('activeTrackerPillTitle');
    const statusEl = document.getElementById('activeTrackerPillStatus');
    if (!pill) return;

    const o = state.currentOrder;
    if (!o || o.status === 'done' || o.status === 'cancelled') {
      pill.classList.remove('visible');
      return;
    }

    if (titleEl) titleEl.textContent = `Order #${o.number}`;
    if (statusEl) {
      if (o.status === 'open') statusEl.textContent = 'Order Placed 🔔';
      else if (o.status === 'accepted') statusEl.textContent = 'Order Accepted ✅';
      else if (o.status === 'cooking' || o.status === 'preparing' || o.status === 'received') statusEl.textContent = 'Cooking in Kitchen 🔥';
      else if (o.status === 'ready') statusEl.textContent = 'Food Cooked / Ready! 🛎️';
      else if (o.status === 'served') statusEl.textContent = 'Served to Table 🍽️';
      else statusEl.textContent = o.status;
    }

    const count = getCartItemCount();
    if (count > 0 && state.cafe && state.cafe.ordering_open) {
      pill.classList.add('with-cart');
    } else {
      pill.classList.remove('with-cart');
    }

    pill.classList.add('visible');
  }

  function updateCartDrawer() {
    const list = document.getElementById('cartDrawerItemsList');
    if (!list) return;

    const entries = Object.values(state.cart);
    if (!entries.length) {
      list.innerHTML = `<li style="padding: 30px 0; text-align: center; color: var(--muted); list-style: none;">Your cart is empty. Add some delicious treats!</li>`;
    } else {
      list.innerHTML = entries.map(c => `
        <li class="item" style="padding: 10px 0; border-bottom: 1px dashed var(--line);">
          <div class="item-text">
            <div class="item-name">${escapeHtml(c.item.name)}</div>
            <div class="item-price">₹${c.item.price * c.qty}</div>
            ${c.note ? `<p style="font-size: 0.78rem; color: var(--terracotta-ink); margin-top: 2px;">Note: ${escapeHtml(c.note)}</p>` : ''}
            <button type="button" data-action="edit-note" data-id="${c.item.id}" style="background: none; border: none; font-size: 0.75rem; color: var(--terracotta-ink); cursor: pointer; padding: 2px 0 0;">
              ${c.note ? '✏️ Edit instruction' : '+ Add instruction'}
            </button>
          </div>
          <div class="stepper">
            <button type="button" data-action="dec" data-id="${c.item.id}">−</button>
            <span class="qty">${c.qty}</span>
            <button type="button" data-action="inc" data-id="${c.item.id}">+</button>
          </div>
        </li>
      `).join('');
    }

    // Update Bill Summary
    const bill = calculateBill();
    const subtotalEl = document.getElementById('billSubtotal');
    const discountRow = document.getElementById('billDiscountRow');
    const discountLabel = document.getElementById('billDiscountLabel');
    const discountVal = document.getElementById('billDiscountVal');
    const rewardRow = document.getElementById('billRewardRow');
    const rewardLabel = document.getElementById('billRewardLabel');
    const rewardVal = document.getElementById('billRewardVal');
    const pointsEarnedText = document.getElementById('billPointsEarnedText');
    const gstEl = document.getElementById('billGst');
    const grandTotalEl = document.getElementById('billGrandTotal');
    const sendBtn = document.getElementById('sendOrderToKitchenBtn');

    if (subtotalEl) subtotalEl.textContent = `₹${bill.subtotal}`;
    if (gstEl) gstEl.textContent = `₹${bill.gst}`;
    if (grandTotalEl) grandTotalEl.textContent = `₹${bill.grandTotal}`;
    if (sendBtn) {
      sendBtn.textContent = `Send Order to Kitchen · ₹${bill.grandTotal}`;
      sendBtn.disabled = entries.length === 0;
    }

    if (discountRow) {
      if (bill.discount > 0) {
        discountRow.style.display = 'flex';
        if (discountLabel) discountLabel.textContent = bill.savingsReason;
        if (discountVal) discountVal.textContent = `−₹${bill.discount}`;
      } else {
        discountRow.style.display = 'none';
      }
    }

    if (rewardRow) {
      if (bill.rewardDiscount > 0) {
        rewardRow.style.display = 'flex';
        if (rewardLabel) rewardLabel.textContent = bill.rewardReason;
        if (rewardVal) rewardVal.textContent = `−₹${bill.rewardDiscount}`;
      } else {
        rewardRow.style.display = 'none';
      }
    }

    if (pointsEarnedText) {
      pointsEarnedText.textContent = `+${bill.pointsEarned} pts on payment`;
    }

    // Voucher Banner
    const appliedBanner = document.getElementById('appliedVoucherBanner');
    const inputRow = document.getElementById('voucherInputRow');
    const vCodeText = document.getElementById('appliedVoucherCode');
    const vDiscText = document.getElementById('appliedVoucherDiscount');

    if (state.appliedVoucher) {
      if (appliedBanner) appliedBanner.style.display = 'flex';
      if (inputRow) inputRow.style.display = 'none';
      if (vCodeText) vCodeText.textContent = `Coupon ${state.appliedVoucher.code} applied!`;
      if (vDiscText) vDiscText.textContent = `Saved ₹${state.appliedVoucher.discount}`;
    } else {
      if (appliedBanner) appliedBanner.style.display = 'none';
      if (inputRow) inputRow.style.display = 'flex';
    }

    // Loyalty Rewards in Cart Section
    renderCartLoyaltySection();
  }

  // Render Loyalty Rewards in Cart
  function renderCartLoyaltySection() {
    const sec = document.getElementById('cartLoyaltySection');
    if (!sec) return;

    const c = state.customer;
    const cartPinRow = document.getElementById('cartPinRow');

    if (c) {
      const pts = Number(c.points || 0);
      const subtotal = getCartSubtotal();
      const allRewards = state.rewards || [];
      const claimableRewards = allRewards.filter(r => (r.active !== false && r.active !== 0) && pts >= Number(r.points || 0));

      if (state.appliedReward) {
        sec.style.display = 'block';
        sec.style.background = '#ecfdf5';
        sec.style.border = '1.5px solid #10b981';
        sec.style.borderRadius = '14px';
        sec.style.padding = '12px 14px';
        sec.style.boxShadow = '0 2px 6px rgba(16,185,129,0.12)';
        sec.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="color: #065f46; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
                <span>🎁</span> ${escapeHtml(state.appliedReward.name)} applied
              </strong>
              <small style="display: block; color: #047857; font-size: 0.82rem; margin-top: 2px;">
                Using <strong>${state.appliedReward.points} loyalty pts</strong> · Saved <strong>₹${state.appliedReward.value}</strong>
              </small>
            </div>
            <button type="button" id="removeRewardBtn" class="close-icon-btn" style="width: 32px; height: 32px; font-size: 0.9rem; cursor: pointer;" title="Remove reward">✕</button>
          </div>
        `;
        document.getElementById('removeRewardBtn')?.addEventListener('click', removeReward);

        // Show PIN authorization row if customer has PIN
        if (cartPinRow && c.has_pin) {
          cartPinRow.style.display = 'block';
          const cartPinLabel = document.getElementById('cartPinLabel');
          const cartPinHint = document.getElementById('cartPinHint');
          if (cartPinLabel) cartPinLabel.textContent = '🔒 Enter 4-Digit Security PIN';
          if (cartPinHint) cartPinHint.textContent = `Enter PIN for ${escapeHtml(c.name)} to authorize ${state.appliedReward.points} pts deduction`;
          const pinIn = document.getElementById('custPinInput');
          const savedPin = sessionStorage.getItem('muse_cust_pin');
          if (savedPin && pinIn && !pinIn.value) {
            pinIn.value = savedPin;
          }
        }
      } else if (claimableRewards.length > 0) {
        sec.style.display = 'block';
        sec.style.background = '#fffbeb';
        sec.style.border = '1.5px solid #d97706';
        sec.style.borderRadius = '14px';
        sec.style.padding = '12px 14px';
        sec.style.boxShadow = '0 2px 8px rgba(217,119,6,0.1)';
        sec.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div>
              <strong style="font-size: 0.92rem; color: #92400e; display: flex; align-items: center; gap: 6px;">
                <span>⭐</span> Redeem Loyalty Points
              </strong>
              <small style="color: #b45309; font-size: 0.78rem;">You have ${pts} pts available to use right now!</small>
            </div>
            <span class="loyalty-balance-badge" style="background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; font-weight: 700;">⭐ ${pts} pts</span>
          </div>
          <div style="display: grid; gap: 8px; margin-top: 10px;">
            ${claimableRewards.map(r => {
              const meets = !r.min_bill || subtotal >= r.min_bill;
              if (meets) {
                return `
                  <button type="button" class="btn small" data-reward-id="${r.id}" style="width: 100%; min-height: 42px; background: linear-gradient(135deg, #b45309, #d97706); color: #fff; font-weight: 700; font-size: 0.88rem; border-radius: 10px; border: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; box-shadow: 0 2px 5px rgba(180,83,9,0.25);">
                    <span>🎁 Use ${r.points} pts for ${escapeHtml(r.name)}</span>
                    <span style="background: rgba(255,255,255,0.28); padding: 3px 10px; border-radius: 6px; font-size: 0.82rem; font-weight: 800;">Apply</span>
                  </button>
                `;
              } else {
                return `
                  <button type="button" class="btn small" disabled style="width: 100%; min-height: 38px; background: #f3f4f6; color: #9ca3af; font-size: 0.82rem; border-radius: 10px; border: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; cursor: not-allowed;">
                    <span>🎁 ${escapeHtml(r.name)} (${r.points} pts)</span>
                    <span style="font-size: 0.75rem;">Min order ₹${r.min_bill} (add ₹${r.min_bill - subtotal})</span>
                  </button>
                `;
              }
            }).join('')}
          </div>
        `;
        sec.querySelectorAll('[data-reward-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            const rid = Number(btn.getAttribute('data-reward-id'));
            applyReward(rid);
          });
        });

        if (cartPinRow && state.customer) {
          cartPinRow.style.display = 'none';
        }
      } else if (pts >= 10 && subtotal >= 10) {
        const usablePts = Math.min(pts, Math.floor(subtotal));
        sec.style.display = 'block';
        sec.style.background = '#fffbeb';
        sec.style.border = '1.5px solid #d97706';
        sec.style.borderRadius = '14px';
        sec.style.padding = '12px 14px';
        sec.style.boxShadow = '0 2px 8px rgba(217,119,6,0.1)';
        sec.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div>
              <strong style="font-size: 0.92rem; color: #92400e; display: flex; align-items: center; gap: 6px;">
                <span>⭐</span> Use Loyalty Points
              </strong>
              <small style="color: #b45309; font-size: 0.78rem;">Balance: ${pts} pts · 1 pt = ₹1 off</small>
            </div>
            <span class="loyalty-balance-badge" style="background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; font-weight: 700;">⭐ ${pts} pts</span>
          </div>
          <button type="button" class="btn small" id="directPointsBtn" style="width: 100%; min-height: 42px; margin-top: 8px; background: linear-gradient(135deg, #b45309, #d97706); color: #fff; font-weight: 700; font-size: 0.88rem; border-radius: 10px; border: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; box-shadow: 0 2px 5px rgba(180,83,9,0.25);">
            <span>✨ Redeem ${usablePts} pts for ₹${usablePts} Off</span>
            <span style="background: rgba(255,255,255,0.28); padding: 3px 10px; border-radius: 6px; font-size: 0.82rem; font-weight: 800;">Apply</span>
          </button>
        `;
        document.getElementById('directPointsBtn')?.addEventListener('click', () => {
          state.appliedReward = {
            id: 0,
            name: `₹${usablePts} Points Discount`,
            points: usablePts,
            value: usablePts,
            type: 'amount',
            min_bill: 0
          };
          playCustomerChime('order');
          showToast(`✨ Redeemed ${usablePts} points for ₹${usablePts} off!`, '🎉');
          updateCartDrawer();
          updateCartBar();
        });

        if (cartPinRow && state.customer) {
          cartPinRow.style.display = 'none';
        }
      } else {
        sec.style.display = 'block';
        sec.style.background = '#fdfaf5';
        sec.style.border = '1.5px dashed var(--gold)';
        sec.style.borderRadius = '12px';
        sec.style.padding = '12px 14px';
        sec.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 0.85rem;">
              <strong>⭐ Loyalty Balance: ${pts} pts</strong>
              <small class="muted" style="display: block;">Earn 1 pt per ₹100 spent to unlock rewards!</small>
            </div>
            <span class="loyalty-balance-badge">⭐ ${pts} pts</span>
          </div>
        `;
        if (cartPinRow && state.customer) {
          cartPinRow.style.display = 'none';
        }
      }
    } else {
      sec.style.display = 'block';
      sec.style.background = '#fdfaf5';
      sec.style.border = '1.5px dashed var(--gold)';
      sec.style.borderRadius = '12px';
      sec.style.padding = '12px 14px';
      sec.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <div>
            <strong style="font-size: 0.88rem; color: var(--espresso);">⭐ ${state.cafe ? state.cafe.name : 'VIP'} Loyalty Club</strong>
            <small class="muted" style="display: block;">Sign in to redeem points & earn rewards!</small>
          </div>
          <button type="button" class="btn small" id="cartSignInPromptBtn" style="padding: 6px 14px; font-size: 0.82rem; white-space: nowrap;">Sign In</button>
        </div>
      `;
      document.getElementById('cartSignInPromptBtn')?.addEventListener('click', () => {
        closeAllDrawers();
        renderProfileModal();
        document.getElementById('profileDrawer')?.classList.add('active');
      });
    }
  }

  function applyReward(rewardId) {
    const r = (state.rewards || []).find(x => x.id === rewardId);
    if (!r) return;

    if (!state.customer || (state.customer.points || 0) < r.points) {
      showToast(`You need ${r.points} points for this reward`, '⚠️');
      return;
    }

    const subtotal = getCartSubtotal();
    if (r.min_bill && subtotal < r.min_bill) {
      showToast(`This reward requires a minimum order of ₹${r.min_bill}`, '⚠️');
      return;
    }

    state.appliedReward = r;
    playCustomerChime('order');
    showToast(`🎁 Reward applied: ${r.name}!`, '🎉');
    updateCartDrawer();
    updateCartBar();
  }

  function removeReward() {
    state.appliedReward = null;
    showToast('Reward removed');
    const cartPinRow = document.getElementById('cartPinRow');
    if (cartPinRow && state.customer) {
      cartPinRow.style.display = 'none';
    }
    updateCartDrawer();
    updateCartBar();
  }

  // Voucher Application (Direct listener, 100% reliable)
  async function applyVoucherCode(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) {
      showToast('Please type a coupon code', '⚠️');
      return;
    }

    const subtotal = getCartSubtotal();
    if (subtotal <= 0) {
      showToast('Add items to cart before applying coupon', '🛒');
      return;
    }

    const phone = state.customer?.phone || document.getElementById('custPhoneInput')?.value || '';

    try {
      const res = await fetch('/api/customer/voucher/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, phone, subtotal })
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Coupon cannot be applied', '⚠️');
        return;
      }

      state.appliedVoucher = data;
      showToast(`Coupon ${data.code} applied! Saved ₹${data.discount}`, '🎉');
      updateCartDrawer();
      updateCartBar();
    } catch {
      showToast('Network error verifying coupon', '❌');
    }
  }

  function removeVoucher() {
    state.appliedVoucher = null;
    showToast('Coupon removed');
    updateCartDrawer();
    updateCartBar();
  }

  // Customer Management UI
  function updateCustomerUI() {
    const c = state.customer;
    const avatarIcon = document.getElementById('profileAvatarIcon');
    const userCard = document.getElementById('loggedInUserCard');
    const inputsBox = document.getElementById('guestInputsBox');
    const userNameEl = document.getElementById('loggedInUserName');
    const userPhoneEl = document.getElementById('loggedInUserPhone');
    const nameIn = document.getElementById('custNameInput');
    const phoneIn = document.getElementById('custPhoneInput');

    if (avatarIcon) avatarIcon.textContent = c ? '⭐' : '👤';

    if (c) {
      if (userCard) userCard.style.display = 'flex';
      if (inputsBox) inputsBox.style.display = 'none';
      if (userNameEl) userNameEl.textContent = c.name;
      if (userPhoneEl) userPhoneEl.textContent = `${c.phone} · ${c.points || 0} loyalty points`;
    } else {
      if (userCard) userCard.style.display = 'none';
      if (inputsBox) inputsBox.style.display = 'grid';
      if (nameIn && !nameIn.value) nameIn.value = '';
      if (phoneIn && !phoneIn.value) phoneIn.value = '';
    }

    renderProfileModal();
  }

  function renderProfileModal() {
    const box = document.getElementById('profileDetailsBox');
    if (!box) return;

    const c = state.customer;
    if (c) {
      box.innerHTML = `
        <div class="points-card">
          <div class="pc-top">
            <img src="/custom-logo.png" onerror="this.src='/logo-96.webp'" width="44" height="44" style="border-radius:12px; object-fit:contain; background:#fff; padding:2px; border: 1.5px solid var(--gold);" alt="" />
            <div>
              <strong class="pc-name" style="font-size: 1.1rem;">${escapeHtml(c.name)}</strong>
              <span class="pc-sub">${escapeHtml(c.phone)} · Member</span>
            </div>
          </div>
          <div class="pc-points" style="margin: 16px 0 6px;">
            <span style="font-size: 2.5rem; font-family: var(--display); font-weight: 700;">${c.points || 0}</span>
            <small style="opacity: 0.85; margin-left: 6px; font-size: 0.95rem;">Loyalty Points</small>
          </div>
          <div class="pc-foot" style="font-size: 0.8rem; opacity: 0.9;">
            Earn 1 pt per ₹100 spent · Redeem on any visit!
          </div>
        </div>

        <h3 style="font-size: 1.05rem; margin: 18px 0 10px; font-weight: 700;">Available Rewards</h3>
        <ul class="items" style="list-style: none;">
          ${(state.rewards || []).map(r => {
            const unlocked = (c.points || 0) >= r.points;
            return `
              <li class="item" style="padding: 10px 0; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--line);">
                <div>
                  <strong>${escapeHtml(r.name)}</strong>
                  <span class="muted small" style="display: block;">${r.points} points ${r.min_bill ? `· min order ₹${r.min_bill}` : ''}</span>
                </div>
                ${unlocked ? `
                  <button type="button" class="btn small" data-apply-profile-reward="${r.id}" style="padding: 6px 14px; font-size: 0.82rem; font-weight: 700; background: var(--espresso); color: var(--cream);">
                    Apply ➔
                  </button>
                ` : `
                  <span class="badge" style="font-size: 0.75rem;">
                    ${r.points - (c.points || 0)} pts away
                  </span>
                `}
              </li>
            `;
          }).join('')}
        </ul>

        <!-- Points Activity Log -->
        <div style="margin-top: 20px;">
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px;">Recent Points Activity</h4>
          <div id="profilePointsHistoryContainer">
            <p class="muted small" style="text-align: center; padding: 10px 0;">Loading activity…</p>
          </div>
        </div>

        <div style="margin-top: 24px; display: flex; justify-content: center; gap: 16px; align-items: center;">
          <button type="button" class="text-link small" id="profileChangePinBtn" style="color: var(--terracotta-ink); font-weight: 600;">
            ${c.has_pin ? '🔒 Change PIN' : '🔒 Set 4-Digit PIN'}
          </button>
          <span style="color: var(--line);">·</span>
          <button type="button" class="text-link small" id="profileSignOutBtn" style="color: var(--muted);">Sign Out</button>
        </div>

        <!-- Inline PIN Change / Set Box -->
        <div id="profileChangePinBox" style="display: none; margin-top: 14px; background: var(--paper); border: 1.5px solid var(--line); border-radius: 12px; padding: 14px;">
          <h5 style="margin-bottom: 8px; font-size: 0.9rem; font-weight: 700;">
            ${c.has_pin ? 'Change 4-Digit PIN' : 'Set 4-Digit PIN'}
          </h5>
          <form id="profileChangePinForm" style="display: grid; gap: 8px;">
            <div id="changeCurPinRow" style="${c.has_pin ? 'display: block;' : 'display: none;'}">
              <label class="small muted" style="font-size: 0.75rem; display: block; margin-bottom: 2px;">Current PIN</label>
              <input type="password" id="changeCurPin" maxlength="4" placeholder="••••" style="width: 100%; height: 40px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; font-size: 1.1rem; text-align: center; letter-spacing: 0.25em;" />
            </div>
            <div>
              <label class="small muted" style="font-size: 0.75rem; display: block; margin-bottom: 2px;">${c.has_pin ? 'New 4-Digit PIN' : 'Choose 4-Digit PIN'}</label>
              <input type="password" id="changeNewPin" maxlength="4" placeholder="••••" required style="width: 100%; height: 40px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; font-size: 1.1rem; text-align: center; letter-spacing: 0.25em;" />
            </div>
            <div style="display: flex; gap: 8px; margin-top: 4px;">
              <button type="submit" class="btn small" style="flex: 1;">Save PIN</button>
              <button type="button" class="btn small" id="cancelChangePinBtn" style="background: none; border: 1px solid var(--line); color: var(--espresso);">Cancel</button>
            </div>
          </form>
        </div>
      `;

      // Change PIN Toggle & Submit
      const changePinBtn = document.getElementById('profileChangePinBtn');
      const changePinBox = document.getElementById('profileChangePinBox');
      const cancelChangePinBtn = document.getElementById('cancelChangePinBtn');
      const changePinForm = document.getElementById('profileChangePinForm');

      if (changePinBtn && changePinBox) {
        changePinBtn.addEventListener('click', () => {
          changePinBox.style.display = changePinBox.style.display === 'none' ? 'block' : 'none';
        });
      }
      if (cancelChangePinBtn && changePinBox) {
        cancelChangePinBtn.addEventListener('click', () => {
          changePinBox.style.display = 'none';
        });
      }
      if (changePinForm) {
        changePinForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const current_pin = document.getElementById('changeCurPin')?.value.trim();
          const new_pin = document.getElementById('changeNewPin')?.value.trim();

          if (c.has_pin && (!current_pin || current_pin.length !== 4)) {
            showToast('Enter your current 4-digit PIN', '⚠️');
            return;
          }

          if (!new_pin || new_pin.length !== 4) {
            showToast('New PIN must be exactly 4 digits', '⚠️');
            return;
          }

          try {
            const res = await fetch('/api/customer/change-pin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone: c.phone, current_pin: c.has_pin ? current_pin : undefined, new_pin })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update PIN');

            c.has_pin = true;
            saveCustomer(c);
            showToast(data.message || 'PIN updated successfully!', '🔒');
            renderProfileModal();
          } catch (err) {
            showToast(err.message, '⚠️');
          }
        });
      }

      // Apply reward click from profile
      box.querySelectorAll('[data-apply-profile-reward]').forEach(btn => {
        btn.addEventListener('click', () => {
          const rid = Number(btn.getAttribute('data-apply-profile-reward'));
          applyReward(rid);
          closeAllDrawers();
          const cartDrawer = document.getElementById('cartDrawer');
          if (cartDrawer) cartDrawer.classList.add('active');
        });
      });

      // Sign out click
      const signOutBtn = document.getElementById('profileSignOutBtn');
      if (signOutBtn) {
        signOutBtn.addEventListener('click', () => {
          saveCustomer(null);
          showToast('Signed out of loyalty account');
          renderProfileModal();
        });
      }

      // Fetch live points history
      fetch(`/api/customer/loyalty-profile?phone=${c.phone}`)
        .then(r => r.json())
        .then(data => {
          const histContainer = document.getElementById('profilePointsHistoryContainer');
          if (!histContainer) return;

          // Also update customer points if newer
          if (data.customer && data.customer.points !== c.points) {
            state.customer.points = data.customer.points;
            saveCustomer(state.customer);
            const ptSpan = box.querySelector('.pc-points span');
            if (ptSpan) ptSpan.textContent = data.customer.points;
          }

          const logs = data.history || [];
          if (!logs.length) {
            histContainer.innerHTML = `<p class="muted small" style="text-align:center; padding: 8px 0;">No points transactions yet.</p>`;
            return;
          }

          histContainer.innerHTML = logs.map(l => {
            const isAdd = l.mode === 'add';
            const dateStr = l.created_at ? new Date(l.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
            return `
              <div class="points-history-item">
                <div>
                  <span style="font-weight: 600;">${escapeHtml(l.reason || (isAdd ? 'Points added' : 'Points redeemed'))}</span>
                  <small class="muted" style="display: block; font-size: 0.72rem;">${dateStr}</small>
                </div>
                <span class="${isAdd ? 'points-plus' : 'points-minus'}">
                  ${isAdd ? '+' : '−'}${l.amount} pts
                </span>
              </div>
            `;
          }).join('');
        })
        .catch(() => {
          const histContainer = document.getElementById('profilePointsHistoryContainer');
          if (histContainer) histContainer.innerHTML = `<p class="muted small">Could not load history.</p>`;
        });

    } else {
      // Not Signed In UI with Instant Phone Lookup
      box.innerHTML = `
        <div style="text-align: center; padding: 10px 0;">
          <div style="font-size: 2.4rem; margin-bottom: 6px;">⭐</div>
          <h3 style="font-family: var(--display); font-size: 1.3rem;">${state.cafe ? state.cafe.name : 'VIP'} Loyalty Club</h3>
          <p class="muted small" style="margin: 4px 0 16px;">
            Earn 1 point per ₹100 spent, unlock free coffees & croissants, and get 50 bonus points on joining!
          </p>

          <form id="profileSignInForm" style="display: grid; gap: 10px; text-align: left;">
            <div>
              <label class="small" style="font-weight: 600;">Mobile Number</label>
              <input type="tel" id="profPhoneInput" maxlength="10" placeholder="10-digit mobile number" required style="width: 100%; height: 44px; border: 1.5px solid var(--line); border-radius: 12px; padding: 0 12px; background: var(--paper); font-size: 0.95rem;" />
            </div>

            <!-- Dynamic Customer Info Area -->
            <div id="profDynamicFields" style="display: grid; gap: 10px;">
              <div id="profNameRow">
                <label class="small" style="font-weight: 600;">Your Name</label>
                <input type="text" id="profNameInput" placeholder="Enter your name" style="width: 100%; height: 44px; border: 1.5px solid var(--line); border-radius: 12px; padding: 0 12px; background: var(--paper); font-size: 0.95rem;" />
              </div>

              <div id="profPinRow" style="display: none;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label class="small" style="font-weight: 600;">4-Digit PIN</label>
                  <button type="button" id="profForgotPinBtn" class="text-link small" style="font-size: 0.78rem;">Forgot PIN?</button>
                </div>
                <input type="password" id="profPinInput" maxlength="4" placeholder="••••" style="width: 100%; height: 44px; border: 1.5px solid var(--line); border-radius: 12px; padding: 0 12px; background: var(--paper); font-size: 1.1rem; letter-spacing: 0.2em; text-align: center;" />
              </div>
            </div>

            <button type="submit" class="btn" id="profSubmitBtn" style="margin-top: 6px; min-height: 46px;">
              Continue
            </button>
          </form>
        </div>
      `;

      const phoneIn = document.getElementById('profPhoneInput');
      const nameRow = document.getElementById('profNameRow');
      const nameIn = document.getElementById('profNameInput');
      const pinRow = document.getElementById('profPinRow');
      const pinIn = document.getElementById('profPinInput');
      const submitBtn = document.getElementById('profSubmitBtn');
      const forgotBtn = document.getElementById('profForgotPinBtn');
      let knownCustomer = null;

      if (phoneIn) {
        phoneIn.addEventListener('input', async (e) => {
          const val = e.target.value.replace(/\D/g, '');
          const pinLabel = pinRow ? pinRow.querySelector('label') : null;
          if (val.length === 10) {
            submitBtn.textContent = 'Checking…';
            try {
              const res = await fetch('/api/customer/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: val })
              });
              const data = await res.json();
              if (data.exists) {
                knownCustomer = data;
                if (nameRow) nameRow.style.display = 'none';
                if (pinRow) {
                  pinRow.style.display = 'block';
                  if (data.has_pin) {
                    if (pinIn) pinIn.placeholder = '••••';
                    if (forgotBtn) forgotBtn.style.display = 'inline-block';
                    if (pinLabel) pinLabel.textContent = '4-Digit PIN';
                    submitBtn.textContent = `Sign In as ${data.name}`;
                  } else {
                    if (pinIn) pinIn.placeholder = 'Choose 4-digit PIN';
                    if (forgotBtn) forgotBtn.style.display = 'none';
                    if (pinLabel) pinLabel.textContent = 'Set your 4-Digit PIN';
                    submitBtn.textContent = `Set PIN & Sign In as ${data.name}`;
                  }
                }
              } else {
                knownCustomer = null;
                if (nameRow) nameRow.style.display = 'block';
                if (pinRow) {
                  pinRow.style.display = 'block';
                  if (pinIn) pinIn.placeholder = 'Choose 4-digit PIN';
                  if (forgotBtn) forgotBtn.style.display = 'none';
                  if (pinLabel) pinLabel.textContent = 'Choose 4-Digit PIN';
                }
                submitBtn.textContent = 'Join Club (+50 Points Bonus!)';
              }
            } catch {
              submitBtn.textContent = 'Continue';
            }
          } else {
            knownCustomer = null;
            if (nameRow) nameRow.style.display = 'block';
            if (pinRow) pinRow.style.display = 'none';
            if (pinLabel) pinLabel.textContent = '4-Digit PIN';
            submitBtn.textContent = 'Continue';
          }
        });
      }

      if (forgotBtn) {
        forgotBtn.addEventListener('click', async () => {
          const phone = phoneIn?.value.replace(/\D/g, '');
          if (!phone || phone.length < 10) {
            showToast('Enter your 10-digit phone first', '⚠️');
            return;
          }
          try {
            const res = await fetch('/api/customer/forgot-pin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const d = await res.json();
            showToast(d.message || 'Reset code sent to counter team!', '🔔');
            renderResetPinForm(phone);
          } catch {
            showToast('Could not request reset', '⚠️');
          }
        });
      }

      const form = document.getElementById('profileSignInForm');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const phone = phoneIn?.value.replace(/\D/g, '');
          const name = nameIn?.value.trim() || knownCustomer?.name;
          const pin = pinIn?.value.trim();

          if (!phone || phone.length < 10) {
            showToast('Please provide a 10-digit mobile number', '📱');
            return;
          }

          if (knownCustomer && knownCustomer.has_pin && (!pin || pin.length !== 4)) {
            showToast('Please enter your 4-digit PIN', '🔒');
            if (pinIn) pinIn.focus();
            return;
          }

          if (knownCustomer && !knownCustomer.has_pin && (!pin || pin.length !== 4)) {
            showToast('Please set a 4-digit PIN for your account', '🔒');
            if (pinIn) pinIn.focus();
            return;
          }

          if (!knownCustomer && (!name || !name.trim())) {
            showToast('Please enter your name', '👤');
            if (nameIn) nameIn.focus();
            return;
          }

          if (!knownCustomer && (!pin || pin.length !== 4)) {
            showToast('Please choose a 4-digit security PIN', '🔒');
            if (pinIn) pinIn.focus();
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = 'Signing in…';

          try {
            const res = await fetch('/api/customer/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: name || 'Guest', phone, pin })
            });
            const data = await res.json();
            if (!res.ok) {
              if (data.requires_pin && pinRow) {
                pinRow.style.display = 'block';
                if (pinIn) pinIn.focus();
              }
              throw new Error(data.error || 'Authentication failed');
            }

            saveCustomer(data);
            showToast(`Welcome ${data.name}! ${data.welcome_bonus ? `+${data.welcome_bonus} pts bonus!` : ''}`, '🎉');
            renderProfileModal();
            updateCartDrawer();
          } catch (err) {
            showToast(err.message, '⚠️');
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = knownCustomer ? (knownCustomer.has_pin ? `Sign In as ${knownCustomer.name}` : `Set PIN & Sign In as ${knownCustomer.name}`) : 'Continue';
          }
        });
      }
    }
  }

  function renderResetPinForm(phone) {
    const box = document.getElementById('profileDetailsBox');
    if (!box) return;

    box.innerHTML = `
      <div style="text-align: center; padding: 10px 0;">
        <div style="font-size: 2.2rem; margin-bottom: 6px;">🔐</div>
        <h3 style="font-family: var(--display); font-size: 1.25rem;">Reset Your 4-Digit PIN</h3>
        <p class="muted small" style="margin: 4px 0 16px;">
          Ask the counter team for your 4-digit code (or check WhatsApp). Enter the code and set your new PIN below.
        </p>

        <form id="profileResetPinForm" style="display: grid; gap: 12px; text-align: left;">
          <div>
            <label class="small" style="font-weight: 600;">Mobile Number</label>
            <input type="tel" id="resetPhoneInput" value="${escapeHtml(phone)}" readonly style="width: 100%; height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; background: #f5efe6; font-size: 0.95rem; color: var(--espresso);" />
          </div>

          <div>
            <label class="small" style="font-weight: 600;">4-Digit Reset Code (from Staff/WhatsApp)</label>
            <input type="text" id="resetCodeInput" maxlength="4" placeholder="e.g. 1234" required style="width: 100%; height: 44px; border: 1.5px solid var(--gold); border-radius: 12px; padding: 0 12px; background: var(--paper); font-size: 1.2rem; letter-spacing: 0.25em; text-align: center;" />
          </div>

          <div>
            <label class="small" style="font-weight: 600;">Choose New 4-Digit PIN</label>
            <input type="password" id="resetNewPinInput" maxlength="4" placeholder="••••" required style="width: 100%; height: 44px; border: 1.5px solid var(--line); border-radius: 12px; padding: 0 12px; background: var(--paper); font-size: 1.2rem; letter-spacing: 0.25em; text-align: center;" />
          </div>

          <button type="submit" class="btn" id="resetSubmitBtn" style="margin-top: 6px; min-height: 46px;">
            Save New PIN & Sign In
          </button>

          <div style="text-align: center; margin-top: 8px;">
            <button type="button" class="text-link small" id="backToSignInBtn">← Back to Sign In</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById('backToSignInBtn')?.addEventListener('click', () => {
      renderProfileModal();
    });

    const resetForm = document.getElementById('profileResetPinForm');
    if (resetForm) {
      resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = document.getElementById('resetCodeInput')?.value.trim();
        const new_pin = document.getElementById('resetNewPinInput')?.value.trim();
        const btn = document.getElementById('resetSubmitBtn');

        if (!code || code.length !== 4) {
          showToast('Please enter the 4-digit code', '⚠️');
          return;
        }
        if (!new_pin || new_pin.length !== 4) {
          showToast('New PIN must be 4 digits', '⚠️');
          return;
        }

        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Verifying…';
        }

        try {
          const res = await fetch('/api/customer/reset-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, code, new_pin })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not reset PIN');

          saveCustomer(data.customer);
          playCustomerChime('order');
          showToast('PIN successfully reset! Welcome back!', '🎉');
          renderProfileModal();
          updateCartDrawer();
        } catch (err) {
          showToast(err.message, '⚠️');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save New PIN & Sign In';
          }
        }
      });
    }
  }

  // Order Placement
  async function placeOrder() {
    const entries = Object.values(state.cart);
    if (!entries.length) {
      showToast('Your cart is empty', '🛒');
      return;
    }

    let customerName = state.customer?.name;
    let customerPhone = state.customer?.phone;
    let guestPin = document.getElementById('custPinInput')?.value.trim() || sessionStorage.getItem('muse_cust_pin') || null;
    const cartPinRow = document.getElementById('cartPinRow');

    // If loyalty points are being redeemed and customer has a PIN, verify PIN is entered
    if (state.appliedReward && state.appliedReward.points > 0 && state.customer?.has_pin) {
      if (!guestPin || guestPin.length !== 4) {
        if (cartPinRow) cartPinRow.style.display = 'block';
        showToast('Please enter your 4-digit PIN to authorize loyalty points', '🔒');
        document.getElementById('custPinInput')?.focus();
        return;
      }
    }

    if (!customerPhone) {
      const nameIn = document.getElementById('custNameInput');
      const phoneIn = document.getElementById('custPhoneInput');
      customerName = nameIn?.value.trim() || 'Guest';
      customerPhone = phoneIn?.value.replace(/\D/g, '') || '';

      if (customerPhone.length < 10) {
        showToast('Please enter your 10-digit mobile number', '📱');
        if (phoneIn) phoneIn.focus();
        return;
      }

      // If cart PIN row is visible and user typed a phone number
      if (cartPinRow && cartPinRow.style.display !== 'none') {
        if (!guestPin || guestPin.length !== 4) {
          showToast('Please enter your 4-digit PIN to continue', '🔒');
          document.getElementById('custPinInput')?.focus();
          return;
        }

        // Authenticate and sign in the customer
        try {
          const authRes = await fetch('/api/customer/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: customerName, phone: customerPhone, pin: guestPin })
          });
          const authData = await authRes.json();
          if (!authRes.ok) {
            throw new Error(authData.error || 'PIN authentication failed');
          }
          saveCustomer(authData);
          if (guestPin) sessionStorage.setItem('muse_cust_pin', guestPin);
          customerName = authData.name;
          customerPhone = authData.phone;
          updateCustomerUI();
        } catch (authErr) {
          showToast(authErr.message, '⚠️');
          document.getElementById('custPinInput')?.focus();
          return;
        }
      }
    }

    const sendBtn = document.getElementById('sendOrderToKitchenBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending to Kitchen…';
    }

    const bill = calculateBill();
    const itemsPayload = entries.map(c => ({
      item_id: c.item.id,
      name: c.item.name,
      qty: c.qty,
      price: c.item.price,
      note: c.note || null,
      free: false
    }));

    const kitchenNote = document.getElementById('orderKitchenNoteInput')?.value.trim() || null;

    try {
      const res = await fetch('/api/customer/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: state.table.id,
          table_number: state.table.number,
          customer_phone: customerPhone,
          customer_name: customerName,
          pin: guestPin || null,
          items: itemsPayload,
          subtotal: bill.subtotal,
          discount: bill.discount + (bill.rewardDiscount || 0),
          savings: [bill.savingsReason, bill.rewardReason].filter(Boolean).join(' | ') || null,
          voucher_code: state.appliedVoucher?.code || null,
          reward_id: state.appliedReward?.id || null,
          points_used: state.appliedReward?.points || 0,
          total: bill.grandTotal,
          note: kitchenNote
        })
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.requires_pin && cartPinRow) {
          cartPinRow.style.display = 'block';
          document.getElementById('custPinInput')?.focus();
        }
        throw new Error(data.error || 'Failed to place order.');
      }

      // Update customer with real live points from server
      if (guestPin && guestPin.length === 4) {
        sessionStorage.setItem('muse_cust_pin', guestPin);
      }
      if (data.customer) {
        saveCustomer(data.customer);
      } else if (customerPhone) {
        syncCustomerPoints(customerPhone);
      }

      // Clear cart
      state.cart = {};
      state.appliedVoucher = null;
      state.appliedReward = null;
      document.querySelectorAll('.stepper').forEach(s => s.style.display = 'none');
      document.querySelectorAll('.add-btn').forEach(b => b.style.display = 'inline-flex');
      document.querySelectorAll('.item-note-row').forEach(r => r.style.display = 'none');
      document.querySelectorAll('.order-item-note-btn').forEach(b => b.style.display = 'none');

      updateCartBar();
      updateCartDrawer();

      // Open live tracking
      state.currentOrder = data.order;
      sessionStorage.setItem(`muse_order_${state.table.id}`, data.order.id);
      playCustomerChime('order');
      showOrderTrackingDrawer(data.order);
      updateActiveOrderTrackerPill();
      startPollingOrder(data.order.id, true);
      showToast(`Order #${data.order.number} sent to kitchen!`, '🍳');
    } catch (e) {
      showToast(e.message || 'Error placing order', '❌');
    } finally {
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = `Send Order to Kitchen`;
      }
    }
  }

  // Live Order Status Tracking
  let orderPollTimer = null;
  function startPollingOrder(orderId, openDrawer = false) {
    if (orderPollTimer) clearInterval(orderPollTimer);

    const check = async () => {
      try {
        const res = await fetch(`/api/customer/orders/${orderId}`);
        if (!res.ok) return;
        const o = await res.json();
        const prevStatus = state.currentOrder ? state.currentOrder.status : null;
        state.currentOrder = o;
        updateOrderTrackingUI(o);
        updateActiveOrderTrackerPill();

        if (prevStatus && prevStatus !== o.status) {
          playCustomerChime('order');
          if (o.status === 'received') showToast(`Order #${o.number} is cooking in kitchen! 🔥`, '🍳');
          else if (o.status === 'served') showToast(`Order #${o.number} served to table! 🍽️`, '✨');
          else if (o.status === 'done') {
            showToast(`Order #${o.number} settled. Thank you! ☕`, '💳');
            if (state.customer?.phone) syncCustomerPoints(state.customer.phone);
          }
        }

        if (openDrawer) {
          showOrderTrackingDrawer(o);
          openDrawer = false;
        }
        if (o.status === 'done' || o.status === 'cancelled') {
          clearInterval(orderPollTimer);
          if (o.status === 'done' && state.customer?.phone) {
            syncCustomerPoints(state.customer.phone);
          }
          setTimeout(updateActiveOrderTrackerPill, 4000);
        }
      } catch {}
    };

    check();
    orderPollTimer = setInterval(check, 3000);
  }

  function showOrderTrackingDrawer(o) {
    closeAllDrawers();
    updateOrderTrackingUI(o);
    const drawer = document.getElementById('orderStatusDrawer');
    if (drawer) drawer.classList.add('active');
  }

  function updateOrderTrackingUI(o) {
    if (!o) return;

    const titleEl = document.getElementById('orderStatusTitle');
    const descEl = document.getElementById('orderStatusDesc');
    const ticketNo = document.getElementById('orderTicketNumber');
    const tableBadge = document.getElementById('orderTableBadge');
    const totalEl = document.getElementById('orderTicketTotal');
    const ptsBox = document.getElementById('pointsEarnedBox');
    const ptsTxt = document.getElementById('pointsEarnedText');

    if (ticketNo) ticketNo.textContent = `Order #${o.number}`;
    if (tableBadge) tableBadge.textContent = `Table ${o.table_number}`;
    if (totalEl) totalEl.textContent = `₹${o.total}`;

    if (o.points_earned && ptsBox && ptsTxt) {
      ptsBox.style.display = 'block';
      ptsTxt.textContent = `+${o.points_earned} Points`;
    }

    const s1 = document.getElementById('pStep1');
    const s2 = document.getElementById('pStep2');
    const s3 = document.getElementById('pStep3');
    const s4 = document.getElementById('pStep4');

    [s1, s2, s3, s4].forEach(el => {
      if (el) el.className = 'p-step';
    });

    if (o.status === 'open') {
      if (titleEl) titleEl.textContent = 'Order Placed';
      if (descEl) descEl.textContent = 'Your order has been sent to the kitchen and owner.';
      if (s1) s1.className = 'p-step active';
    } else if (o.status === 'accepted') {
      if (titleEl) titleEl.textContent = 'Order Accepted ✅';
      if (descEl) descEl.textContent = 'Your order is accepted and queued in the kitchen!';
      if (s1) s1.className = 'p-step active';
    } else if (o.status === 'cooking' || o.status === 'preparing' || o.status === 'received') {
      if (titleEl) titleEl.textContent = 'Cooking in Kitchen 🔥';
      if (descEl) descEl.textContent = 'Our chefs are currently preparing your fresh food & drinks.';
      if (s1) s1.className = 'p-step done';
      if (s2) s2.className = 'p-step active';
    } else if (o.status === 'ready') {
      if (titleEl) titleEl.textContent = 'Food Cooked / Ready! 🛎️';
      if (descEl) descEl.textContent = 'Your food is cooked and ready! The waiter is on the way to serve your table.';
      if (s1) s1.className = 'p-step done';
      if (s2) s2.className = 'p-step done';
      if (s3) s3.className = 'p-step active';
    } else if (o.status === 'served') {
      if (titleEl) titleEl.textContent = 'Served to Table 🍽️';
      if (descEl) descEl.textContent = 'Food & drinks have arrived. Enjoy your meal!';
      if (s1) s1.className = 'p-step done';
      if (s2) s2.className = 'p-step done';
      if (s3) s3.className = 'p-step active';
    } else if (o.status === 'done') {
      if (titleEl) titleEl.textContent = 'Bill Paid';
      if (descEl) descEl.textContent = 'Thank you for visiting ' + (state.cafe ? state.cafe.name : 'us') + '! Points have been credited.';
      if (s1) s1.className = 'p-step done';
      if (s2) s2.className = 'p-step done';
      if (s3) s3.className = 'p-step done';
      if (s4) s4.className = 'p-step done';
    } else if (o.status === 'cancelled') {
      if (titleEl) titleEl.textContent = 'Order Cancelled';
      if (descEl) descEl.textContent = o.cancel_reason || 'Order was cancelled.';
    }
  }

  // Active Orders (Running Table Bill)
  async function openTableBill() {
    closeAllDrawers();
    const drawer = document.getElementById('tableOrdersDrawer');
    const container = document.getElementById('tableOrdersListContainer');
    if (!drawer || !container) return;

    drawer.classList.add('active');
    container.innerHTML = `<p class="muted center-text" style="padding: 20px;">Fetching table orders…</p>`;

    try {
      const res = await fetch(`/api/customer/table/${state.token}/active-orders`);
      const data = await res.json();
      const orders = data.orders || [];

      if (!orders.length) {
        container.innerHTML = `
          <div style="padding: 30px 10px; text-align: center; color: var(--muted);">
            <div style="font-size: 2.2rem; margin-bottom: 6px;">📋</div>
            <p>No active orders yet at Table ${state.table.number}.</p>
          </div>
        `;
        return;
      }

      const tableTotal = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);

      container.innerHTML = `
        ${orders.map(o => `
          <div style="background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <strong>Order #${o.number}</strong>
              <span class="badge" style="background: #eef4ea; color: var(--ok); text-transform: uppercase; font-size: 0.72rem;">${o.status}</span>
            </div>
            <ul style="list-style: none; font-size: 0.85rem; color: var(--muted); margin-bottom: 8px;">
              ${o.items.map(it => `<li>${it.qty}× ${escapeHtml(it.name)} — ₹${it.line_total}</li>`).join('')}
            </ul>
            <div style="text-align: right; font-weight: 700; color: var(--espresso);">Subtotal: ₹${o.total}</div>
          </div>
        `).join('')}

        <div class="card bill-card" style="padding: 12px; border-radius: 14px; margin-top: 6px;">
          <div class="bill">
            <span>Table Total Unpaid</span>
            <strong>₹${tableTotal}</strong>
          </div>
        </div>
      `;
    } catch {
      container.innerHTML = `<p class="muted center-text">Could not load table bill.</p>`;
    }
  }

  // Waiter & Bill Alerts with Instant Visual & Audio Feedback + Cooldown
  let waiterCooldownTimer = null;
  let waiterSecondsLeft = 0;

  async function callWaiter() {
    if (waiterSecondsLeft > 0) {
      showToast(`Waiter already alerted. Please wait ${waiterSecondsLeft}s.`, '⏳');
      return;
    }

    playCustomerChime('bell');

    const waiterBtns = [
      document.getElementById('statusCallWaiterBtn'),
      document.getElementById('quickCallWaiterBtn'),
      document.getElementById('ordersCallWaiterBtn')
    ].filter(Boolean);

    waiterBtns.forEach(b => {
      b.disabled = true;
      b.dataset.prevHtml = b.innerHTML;
      b.innerHTML = '⏳ Alerting staff…';
    });

    try {
      showToast('Alerting floor team…', '🔔');
      const res = await fetch(`/api/customer/table/${state.token}/call-waiter`, { method: 'POST' });
      const data = await res.json();

      // Show in-drawer banner
      const notice = document.getElementById('serviceActionNotice');
      if (notice) {
        notice.style.display = 'block';
        notice.style.background = '#eef8f1';
        notice.style.border = '1.5px solid #2b7a4b';
        notice.style.color = '#174b2c';
        notice.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:1.6rem;">🔔</span>
            <div>
              <strong style="display:block; font-size:0.95rem;">Staff Alerted for Table ${state.table.number}!</strong>
              <span style="font-size:0.82rem; color:#2b7a4b;">Our team at the counter has been notified. A server is coming to your table!</span>
            </div>
          </div>
        `;
      }

      // Start 60-second cooldown
      waiterSecondsLeft = 60;
      waiterBtns.forEach(b => {
        b.style.borderColor = '#2b7a4b';
        b.style.color = '#2b7a4b';
        b.innerHTML = `✓ Waiter Alerted (${waiterSecondsLeft}s)`;
      });

      if (waiterCooldownTimer) clearInterval(waiterCooldownTimer);
      waiterCooldownTimer = setInterval(() => {
        waiterSecondsLeft--;
        if (waiterSecondsLeft <= 0) {
          clearInterval(waiterCooldownTimer);
          waiterBtns.forEach(b => {
            b.disabled = false;
            b.style.borderColor = '';
            b.style.color = '';
            b.innerHTML = b.id === 'quickCallWaiterBtn' ? '<span>🔔</span> Call Waiter' : '🔔 Call Waiter';
          });
        } else {
          waiterBtns.forEach(b => {
            b.innerHTML = `✓ Waiter Alerted (${waiterSecondsLeft}s)`;
          });
        }
      }, 1000);

      showToast(data.message || `Staff notified for Table ${state.table.number}!`, '🔔');
    } catch {
      waiterBtns.forEach(b => {
        b.disabled = false;
        b.innerHTML = b.dataset.prevHtml || '🔔 Call Waiter';
      });
      showToast('Could not reach staff. Please call counter.', '⚠️');
    }
  }

  let billCooldownTimer = null;
  let billSecondsLeft = 0;

  async function requestBill() {
    if (billSecondsLeft > 0) {
      showToast(`Bill already requested. Please wait ${billSecondsLeft}s.`, '⏳');
      return;
    }

    playCustomerChime('bill');

    const billBtns = [
      document.getElementById('statusRequestBillBtn'),
      document.getElementById('ordersRequestBillBtn')
    ].filter(Boolean);

    billBtns.forEach(b => {
      b.disabled = true;
      b.dataset.prevHtml = b.innerHTML;
      b.innerHTML = '⏳ Requesting bill…';
    });

    try {
      showToast('Requesting bill at counter…', '💳');
      const res = await fetch(`/api/customer/table/${state.token}/request-bill`, { method: 'POST' });
      const data = await res.json();

      // Show in-drawer banner
      const notice = document.getElementById('serviceActionNotice');
      if (notice) {
        notice.style.display = 'block';
        notice.style.background = '#eff6ff';
        notice.style.border = '1.5px solid #2563eb';
        notice.style.color = '#1e40af';
        notice.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:1.6rem;">💳</span>
            <div>
              <strong style="display:block; font-size:0.95rem;">Bill Requested for Table ${state.table.number}!</strong>
              <span style="font-size:0.82rem; color:#2563eb;">The counter team is printing your bill and bringing it to Table ${state.table.number}.</span>
            </div>
          </div>
        `;
      }

      billSecondsLeft = 60;
      billBtns.forEach(b => {
        b.style.borderColor = '#2563eb';
        b.style.color = '#2563eb';
        b.innerHTML = `✓ Bill Requested (${billSecondsLeft}s)`;
      });

      if (billCooldownTimer) clearInterval(billCooldownTimer);
      billCooldownTimer = setInterval(() => {
        billSecondsLeft--;
        if (billSecondsLeft <= 0) {
          clearInterval(billCooldownTimer);
          billBtns.forEach(b => {
            b.disabled = false;
            b.style.borderColor = '';
            b.style.color = '';
            b.innerHTML = '💳 Request Bill';
          });
        } else {
          billBtns.forEach(b => {
            b.innerHTML = `✓ Bill Requested (${billSecondsLeft}s)`;
          });
        }
      }, 1000);

      showToast(data.message || `Bill requested for Table ${state.table.number}!`, '💳');
    } catch {
      billBtns.forEach(b => {
        b.disabled = false;
        b.innerHTML = b.dataset.prevHtml || '💳 Request Bill';
      });
      showToast('Could not request bill. Please visit counter.', '⚠️');
    }
  }

  // Drawer Helpers
  function closeAllDrawers() {
    document.querySelectorAll('.drawer-overlay').forEach(d => d.classList.remove('active'));
  }

  // Event Listeners (Bound once, never re-bound)
  function attachStaticEvents() {
    // 1. Search Box with Fast Input (Zero Lag)
    const searchInput = document.getElementById('menuSearchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        state.searchQuery = e.target.value;
        if (clearBtn) clearBtn.style.display = state.searchQuery ? 'block' : 'none';
        applyFilters();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        state.searchQuery = '';
        clearBtn.style.display = 'none';
        applyFilters();
      });
    }

    // 2. Category Chips
    const chipsContainer = document.getElementById('categoryChipsContainer');
    if (chipsContainer) {
      chipsContainer.addEventListener('click', e => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        chipsContainer.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
        btn.classList.add('on');
        state.activeCategory = btn.getAttribute('data-cat');
        applyFilters();
      });
    }

    // 3. Menu Item Delegated Clicks (Add, Inc, Dec, Note)
    const menuContainer = document.getElementById('menuItemsContainer');
    if (menuContainer) {
      menuContainer.addEventListener('click', e => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.getAttribute('data-action');
        const id = Number(target.getAttribute('data-id'));

        if (action === 'add' || action === 'inc') {
          addToCart(id);
        } else if (action === 'dec') {
          decreaseCart(id);
        } else if (action === 'edit-note') {
          openItemNoteModal(id);
        }
      });
    }

    // 4. Cart Drawer Items Delegated Clicks
    const cartItemsList = document.getElementById('cartDrawerItemsList');
    if (cartItemsList) {
      cartItemsList.addEventListener('click', e => {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const action = target.getAttribute('data-action');
        const id = Number(target.getAttribute('data-id'));

        if (action === 'inc') addToCart(id);
        else if (action === 'dec') decreaseCart(id);
        else if (action === 'edit-note') openItemNoteModal(id);
      });
    }

    // 5. Open / Close Cart Drawer
    const cartBar = document.getElementById('cartBarClickable');
    const cartDrawer = document.getElementById('cartDrawer');
    const closeCartBtn = document.getElementById('closeCartDrawerBtn');

    if (cartBar && cartDrawer) {
      cartBar.addEventListener('click', () => {
        closeAllDrawers();
        updateCartDrawer();
        cartDrawer.classList.add('active');
      });
    }
    if (closeCartBtn) {
      closeCartBtn.addEventListener('click', closeAllDrawers);
    }

    // 6. Voucher Apply Button & Input
    const applyVoucherBtn = document.getElementById('applyVoucherBtn');
    const voucherInput = document.getElementById('voucherCodeInput');
    const removeVoucherBtn = document.getElementById('removeVoucherBtn');

    if (applyVoucherBtn && voucherInput) {
      applyVoucherBtn.addEventListener('click', () => {
        applyVoucherCode(voucherInput.value);
      });
      voucherInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyVoucherCode(voucherInput.value);
        }
      });
    }
    if (removeVoucherBtn) {
      removeVoucherBtn.addEventListener('click', removeVoucher);
    }

    // 7. Place Order Button
    const sendOrderBtn = document.getElementById('sendOrderToKitchenBtn');
    if (sendOrderBtn) {
      sendOrderBtn.addEventListener('click', placeOrder);
    }

    // Guest phone input live lookup & cart PIN handling
    const guestPhoneInput = document.getElementById('custPhoneInput');
    const guestNameInput = document.getElementById('custNameInput');
    const cartPinRow = document.getElementById('cartPinRow');
    const cartPinLabel = document.getElementById('cartPinLabel');
    const custPinInput = document.getElementById('custPinInput');
    const cartPinHint = document.getElementById('cartPinHint');
    const cartForgotPinBtn = document.getElementById('cartForgotPinBtn');

    if (guestPhoneInput) {
      guestPhoneInput.addEventListener('input', async (e) => {
        const val = e.target.value.replace(/\D/g, '');
        if (val.length === 10) {
          try {
            const res = await fetch('/api/customer/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone: val })
            });
            const data = await res.json();
            if (data.exists) {
              if (guestNameInput && (!guestNameInput.value || guestNameInput.value === 'Guest')) {
                guestNameInput.value = data.name;
              }
              if (cartPinRow) {
                cartPinRow.style.display = 'block';
                if (data.has_pin) {
                  if (cartPinLabel) cartPinLabel.textContent = '4-Digit PIN';
                  if (custPinInput) custPinInput.placeholder = '••••';
                  if (cartForgotPinBtn) cartForgotPinBtn.style.display = 'inline-block';
                  if (cartPinHint) cartPinHint.textContent = `Welcome back, ${data.name}! Enter 4-digit PIN to order & use ${data.points || 0} pts`;
                } else {
                  if (cartPinLabel) cartPinLabel.textContent = 'Set your 4-Digit PIN';
                  if (custPinInput) custPinInput.placeholder = 'Choose 4-digit PIN';
                  if (cartForgotPinBtn) cartForgotPinBtn.style.display = 'none';
                  if (cartPinHint) cartPinHint.textContent = `Welcome back, ${data.name}! Choose a 4-digit PIN to secure your points`;
                }
              }
            } else {
              if (cartPinRow) {
                cartPinRow.style.display = 'block';
                if (cartPinLabel) cartPinLabel.textContent = 'Choose 4-Digit PIN';
                if (custPinInput) custPinInput.placeholder = 'Choose 4-digit PIN';
                if (cartForgotPinBtn) cartForgotPinBtn.style.display = 'none';
                if (cartPinHint) cartPinHint.textContent = 'Choose a 4-digit PIN to get +50 bonus points on your order!';
              }
            }
          } catch {}
        } else {
          if (cartPinRow) cartPinRow.style.display = 'none';
        }
      });
    }

    if (cartForgotPinBtn) {
      cartForgotPinBtn.addEventListener('click', async () => {
        const phone = guestPhoneInput?.value.replace(/\D/g, '') || state.customer?.phone;
        if (!phone || phone.length < 10) {
          showToast('Enter your 10-digit mobile number first', '📱');
          return;
        }
        try {
          const res = await fetch('/api/customer/forgot-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
          });
          const d = await res.json();
          showToast(d.message || 'Reset code sent to counter team!', '🔔');
          closeAllDrawers();
          renderResetPinForm(phone);
          document.getElementById('profileDrawer')?.classList.add('active');
        } catch {
          showToast('Could not request reset', '⚠️');
        }
      });
    }

    if (custPinInput) {
      custPinInput.addEventListener('input', async (e) => {
        const pinVal = e.target.value.replace(/\D/g, '');
        if (pinVal.length === 4) {
          sessionStorage.setItem('muse_cust_pin', pinVal);
        }
        const phone = guestPhoneInput?.value.replace(/\D/g, '') || state.customer?.phone;
        const name = guestNameInput?.value.trim() || state.customer?.name || 'Guest';

        if (pinVal.length === 4 && phone && phone.length === 10 && !state.customer) {
          try {
            const res = await fetch('/api/customer/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone, name, pin: pinVal })
            });
            const data = await res.json();
            if (res.ok) {
              saveCustomer(data);
              sessionStorage.setItem('muse_cust_pin', pinVal);
              showToast(`Welcome ${data.name}! ${data.points || 0} loyalty points unlocked!`, '🎉');
              updateCustomerUI();
              updateCartDrawer();
            }
          } catch {}
        }
      });
    }

    // 8. Customer Profile Open / Close
    const openProfBtn = document.getElementById('openProfileBtn');
    const profDrawer = document.getElementById('profileDrawer');
    const closeProfBtn = document.getElementById('closeProfileDrawerBtn');
    const switchUserBtn = document.getElementById('switchUserBtn');

    if (openProfBtn && profDrawer) {
      openProfBtn.addEventListener('click', () => {
        closeAllDrawers();
        renderProfileModal();
        profDrawer.classList.add('active');
      });
    }
    if (closeProfBtn) closeProfBtn.addEventListener('click', closeAllDrawers);
    if (switchUserBtn) {
      switchUserBtn.addEventListener('click', () => {
        sessionStorage.removeItem('muse_cust_pin');
        state.appliedReward = null;
        saveCustomer(null);
        showToast('Signed out of guest account');
        updateCartDrawer();
        updateCartBar();
      });
    }

    // 9. Quick Actions (Call Waiter / Table Orders)
    const quickCall = document.getElementById('quickCallWaiterBtn');
    const quickBill = document.getElementById('quickTableBillBtn');
    if (quickCall) quickCall.addEventListener('click', callWaiter);
    if (quickBill) quickBill.addEventListener('click', openTableBill);

    // 10. Table Orders Drawer
    const closeTableOrdersBtn = document.getElementById('closeTableOrdersBtn');
    const ordersCallWaiterBtn = document.getElementById('ordersCallWaiterBtn');
    const ordersRequestBillBtn = document.getElementById('ordersRequestBillBtn');

    if (closeTableOrdersBtn) closeTableOrdersBtn.addEventListener('click', closeAllDrawers);
    if (ordersCallWaiterBtn) ordersCallWaiterBtn.addEventListener('click', callWaiter);
    if (ordersRequestBillBtn) ordersRequestBillBtn.addEventListener('click', requestBill);

    // 11. Order Status Drawer Actions
    const orderMoreBtn = document.getElementById('orderMoreItemsBtn');
    const closeStatusBtn = document.getElementById('closeStatusDrawerBtn');
    const statusCallWaiterBtn = document.getElementById('statusCallWaiterBtn');
    const statusRequestBillBtn = document.getElementById('statusRequestBillBtn');

    if (orderMoreBtn) {
      orderMoreBtn.addEventListener('click', () => {
        closeAllDrawers();
        updateActiveOrderTrackerPill();
        const target = document.getElementById('categoryChipsContainer') || document.getElementById('menuItemsContainer');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        showToast(`Browse menu to add more items to Table ${state.table?.number || ''}! 🍽️`, '✨');
      });
    }

    if (closeStatusBtn) {
      closeStatusBtn.addEventListener('click', () => {
        closeAllDrawers();
        updateActiveOrderTrackerPill();
      });
    }

    if (statusCallWaiterBtn) statusCallWaiterBtn.addEventListener('click', callWaiter);
    if (statusRequestBillBtn) statusRequestBillBtn.addEventListener('click', requestBill);

    // Active Order Floating Tracker Pill Click
    const trackerPill = document.getElementById('activeOrderPillClickable');
    if (trackerPill) {
      trackerPill.addEventListener('click', () => {
        if (state.currentOrder) {
          showOrderTrackingDrawer(state.currentOrder);
        }
      });
    }

    // 12. Item Note Modal
    const saveNoteBtn = document.getElementById('saveItemNoteBtn');
    const closeNoteBtn = document.getElementById('closeNoteDrawerBtn');
    if (closeNoteBtn) closeNoteBtn.addEventListener('click', closeAllDrawers);

    if (saveNoteBtn) {
      saveNoteBtn.addEventListener('click', () => {
        const id = state.noteEditingItemId;
        const txt = document.getElementById('itemNoteInput')?.value.trim() || '';
        if (id && state.cart[id]) {
          state.cart[id].note = txt;
          updateItemDOM(id);
          updateCartDrawer();
          showToast(txt ? 'Instruction saved!' : 'Instruction removed');
        }
        closeAllDrawers();
      });
    }

    // 13. Close on backdrop click
    document.querySelectorAll('.drawer-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) closeAllDrawers();
      });
    });
  }

  function openItemNoteModal(itemId) {
    state.noteEditingItemId = itemId;
    const it = state.items.find(i => i.id === itemId);
    const cartEntry = state.cart[itemId];
    const drawer = document.getElementById('itemNoteDrawer');
    const title = document.getElementById('noteItemNameTitle');
    const textarea = document.getElementById('itemNoteInput');

    if (!drawer) return;
    if (title) title.textContent = it ? it.name : 'Item';
    if (textarea) textarea.value = cartEntry?.note || '';

    closeAllDrawers();
    drawer.classList.add('active');
    setTimeout(() => { if (textarea) textarea.focus(); }, 150);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Start app immediately
  init();
})();
