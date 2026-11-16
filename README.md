# ☕ Muse Bread & Brew · QR Code Menu & Table Ordering System

A full-stack, production-grade QR code restaurant & cafe ordering system. Featuring an artisanal, mobile-first guest menu experience paired with a real-time manager & kitchen dashboard.

---

## 🚀 Quick Start

Run the server with Node.js (Zero external npm packages required! Uses Node 26's built-in `node:sqlite`, `node:http`, and `node:crypto`):

```bash
node server.js
```

Or:

```bash
npm start
```

Open in your browser:
- **System Control Hub & Table Selector**: [http://localhost:3000](http://localhost:3000)
- **Manager & Kitchen Dashboard**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Table QR Menu (Customer Experience)**: [http://localhost:3000/t/:token](http://localhost:3000) (Click any table from the hub)

---

## 🔐 Admin Credentials

- **Username**: `admin`
- **Password**: `muse123`
- **Setup / Reset Code**: `MUSE2026`

*(You can customize the cafe name, change the password, or set screen lock duration in Admin Settings).*

---

## 🌟 Key Features

### 📱 1. Customer QR Code Ordering (`/t/:token`)
- **Direct Table Identification**: Each table has a unique cryptographic QR code token. Scanning automatically binds orders and bill requests to that exact table.
- **Aesthetic Artisanal UI**: Styled with Fraunces serif and Outfit sans typography, rich warm espresso & terracotta palettes.
- **Running Promotions & Offers**: Live carousel highlighting active discounts (e.g., 15% Weekday specials, ₹100 flat discounts) automatically applied at checkout.
- **Dynamic Category & Dish Filtering**: Fast live search across coffees, sourdough breads, breakfast skillets, mains, and desserts.
- **Custom Cooking Instructions**: Add item-specific notes (e.g. *"Oat milk"*, *"Extra hot"*, *"No garlic"*).
- **Voucher System**: Type promotional voucher codes (e.g. `MUSE50`) with instant validation against minimum bill rules.
- **Customer Loyalty & 4-Digit PIN**:
  - Seamless mobile number sign-in.
  - Secure 4-digit PIN to protect points and redeem rewards.
  - Welcome bonus on registration (+50 points).
  - Earn 1 point per ₹100 spent.
  - Redeem points for discounts or free artisan bakery items.
- **Live Order Tracking**:
  - Live progress stepper: `Order Received` ➔ `Cooking in Kitchen` ➔ `Served to Table` ➔ `Bill Paid`.
  - Auto-refreshes every 3 seconds.
- **Quick Guest Actions**:
  - **"Order More Items"**: Seamlessly append more food and drinks to the running table order.
  - **"Call Waiter"**: One-tap alert that rings the admin dashboard.
  - **"Request Bill"**: Notifies the counter to print and bring the bill.

---

### 👑 2. Manager & Kitchen Dashboard (`/admin`)
- **Live Order Queue**:
  - Status columns: **New** (with alert chime) ➔ **Preparing** ➔ **Served (Bill Due)** ➔ **Paid**.
  - One-click workflow: `Order received` ➔ `Served` ➔ `Bill paid`.
  - Flags for free items, vouchers, and kitchen notes.
  - Real-time sound notification & title badge update on new incoming orders.
- **Interactive Tables Overview**:
  - Live table status cards: *Ready*, *New order*, *Preparing*, *Bill due*.
  - Displays total unpaid bill per table and elapsed seating time.
  - Add tables, generate new QR tokens, and one-click "Print all QR codes" sheet.
- **Menu Management**:
  - Category manager (add, reorder, pause/unpause).
  - Item editor (name, section, description, price, in-stock / out-of-stock toggle).
  - Excel Import & Export: Bulk update entire menus using Excel `.xlsx` spreadsheets directly.
- **Marketing & Offers**:
  - Automated cart offers (% off, flat ₹ off, free item).
  - Day-of-week and time-of-day scheduling (e.g. Mon–Fri 8 AM – 6 PM).
  - Single-use and customer-restricted promo vouchers.
- **Loyalty Program Engine**:
  - Points earning rules (earn $X$ points per ₹$Y$ spent).
  - Welcome bonus points.
  - Birthday treat rules (% or flat discount for customer birthdays).
  - Redeemable rewards catalog.
- **Customer CRM**:
  - Customer directory with visit history, total points, age, and rating.
  - Manual points adjustment with reason logging.
  - Customer PIN reset handler with instant WhatsApp link generation (`https://wa.me/91...`).
- **Reports & Analytics**:
  - Daily, weekly, and monthly sales performance.
  - Hourly order distribution chart.
  - Top-selling dishes breakdown.
  - Downloadable Excel financial reports.
- **Settings & Security**:
  - Toggle online ordering on/off (counter-only mode).
  - Toggle customer PIN requirement.
  - Auto-lock screen timeout with password unlock.
  - Full system data backup & test data clearing.

---

## 🛠️ Architecture

```
D:\menu system\
├── server.js                          # Standalone HTTP server & router
├── db.js                              # SQLite database schema, migrations & seed data
├── muse.db                            # SQLite database file (auto-generated)
├── package.json                       # Project configuration
├── routes/
│   ├── auth.js                        # Admin authentication & session management
│   ├── admin.js                       # Admin CRUD, live queue, dashboard & analytics
│   └── customer.js                    # Customer QR table menu, cart, checkout & orders
├── public/
│   ├── index.html                     # Control center / Table switcher hub
│   ├── admin.html                     # Admin SPA mounting shell
│   ├── customer.html                  # Mobile-first customer ordering page
│   ├── customer.js                    # Reactive customer ordering application
│   ├── logo-256.webp                  # Muse branding logo (high res)
│   ├── logo-96.webp                   # Muse branding icon
│   ├── hero.webp                      # Cafe ambience backdrop
│   └── assets/
│       ├── index-DEbz15yT.js          # Admin React SPA bundle
│       └── index-ChRsq97C.css         # Complete Cafe design system & styles
```

