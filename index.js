require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// --- Database Connection ---
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to the database:', err.stack);
    return;
  }
  console.log('Successfully connected to the Railway MySQL database!');
});

app.get('/', (req, res) => {
  res.send('Node.js Backend is running perfectly!');
});

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Missing required fields" });

  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length > 0) return res.status(400).json({ success: false, message: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    db.query("INSERT INTO users (username, email, password, is_verified) VALUES (?, ?, ?, 0)", [name, email, hashedPassword], (err, result) => {
      if (err) return res.status(500).json({ success: false, message: "Registration failed" });
      res.json({ success: true, message: "User registered successfully", user: { id: result.insertId, fullName: name, email: email, verified: false } });
    });
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body; 
  if (!email || !password) return res.status(400).json({ success: false, message: "Missing credentials" });

  db.query("SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1", [email, email], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length === 0) return res.status(400).json({ success: false, message: "No user found with that email or name" });

    const user = results[0];
    
    // FIX: Fallback for old plain-text passwords
    let isMatch = false;
    if (user.password && user.password.startsWith('$2')) {
        isMatch = await bcrypt.compare(password, user.password); // New secure passwords
    } else {
        isMatch = (password === user.password); // Old plain text passwords
    }

    if (isMatch) {
      res.json({ success: true, message: "Login successful", user: { id: user.id, fullName: user.username, email: user.email, verified: Boolean(user.is_verified) } });
    } else {
      res.status(400).json({ success: false, message: "Invalid password" });
    }
  });
});

app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Missing fields" });

  db.query("SELECT * FROM admins WHERE username = ?", [username], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length === 0) return res.status(400).json({ success: false, message: "Admin not found" });

    const admin = results[0];
    if (password === admin.password) {
      res.json({ success: true, message: "Login successful", admin: { id: admin.id, username: admin.username, role: 'admin' } });
    } else {
      res.status(400).json({ success: false, message: "Invalid password" });
    }
  });
});

// ==========================================
// 2. CLIENT BOOKING ROUTES
// ==========================================

app.get('/fetch_booked_dates', (req, res) => {
  db.query("SELECT preferred_date FROM appointments WHERE status != 'Cancelled'", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, bookedDates: results.map(row => row.preferred_date) });
  });
});

app.get('/fetch_user_appointments', (req, res) => {
  const userId = req.query.user_id; 
  if (!userId) return res.status(400).json({ success: false, message: "User ID is required." });
  db.query("SELECT id, event_type, package_type, preferred_date, guest_count, status, total_cost FROM appointments WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Error fetching appointments" });
    res.json({ success: true, appointments: results });
  });
});

app.post('/book_event', (req, res) => {
  const { userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes } = req.body;
  if (!userId || !eventType || !packageType || !preferredDate || !guestCount || !selectedDishes) return res.status(400).json({ success: false, message: "All fields are required." });

  const sql = `INSERT INTO appointments (user_id, event_type, package_type, preferred_date, guest_count, selected_dishes, required_inventory, notes, status) VALUES (?, ?, ?, ?, ?, ?, '', ?, 'Pending')`;
  db.query(sql, [userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes || ''], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Event booking successful!", booking_id: result.insertId });
  });
});

// ==========================================
// 3. ADMIN ROUTES
// ==========================================

app.get('/admin_fetch_dashboard_stats', async (req, res) => {
  try {
    const promiseDb = db.promise();
    const [[bookingsRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM appointments");
    const [[revenueRow]] = await promiseDb.query("SELECT SUM(amount_paid) as total FROM payments");
    const [[menuRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM menu_items");
    const [[userRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM users WHERE is_verified = 1");
    const [events] = await promiseDb.query("SELECT id, event_type, preferred_date, status FROM appointments WHERE preferred_date >= CURDATE() ORDER BY preferred_date ASC LIMIT 5");

    res.json({
      success: true,
      stats: { bookings: bookingsRow?.count || 0, revenue: revenueRow?.total || 0, menuItems: menuRow?.count || 0, customers: userRow?.count || 0 },
      upcomingEvents: events
    });
  } catch (err) { res.status(500).json({ success: false, message: "Database error" }); }
});

app.get('/admin_fetch_bookings', (req, res) => {
  db.query("SELECT a.*, u.username as customer_name, u.email as customer_email FROM appointments a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, bookings: results });
  });
});

app.post('/admin_update_booking_status', (req, res) => {
  const { bookingId, status } = req.body;
  db.query("UPDATE appointments SET status = ? WHERE id = ?", [status, bookingId], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: "Error updating status" });
    res.json({ success: true, message: "Status updated" });
  });
});

// ==========================================
// 4. INVENTORY ROUTES
// ==========================================

app.get('/admin_fetch_inventory', (req, res) => {
  db.query("SELECT * FROM inventory", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, inventory: results });
  });
});

app.post('/admin_add_inventory', (req, res) => {
  const { name, quantity, unit } = req.body;
  db.query("INSERT INTO inventory (name, quantity, unit) VALUES (?, ?, ?)", [name, quantity, unit], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Item added" });
  });
});

app.post('/admin_update_inventory', (req, res) => {
  const { id, name, quantity, unit } = req.body;
  db.query("UPDATE inventory SET name=?, quantity=?, unit=? WHERE id=?", [name, quantity, unit, id], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Item updated" });
  });
});

app.post('/admin_delete_inventory', (req, res) => {
  const { id } = req.body;
  db.query("DELETE FROM inventory WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Inventory deleted" });
  });
});

// ==========================================
// 5. MENU ROUTES
// ==========================================

app.get('/admin_fetch_menu', (req, res) => {
  db.query("SELECT * FROM menu_items", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, menu: results });
  });
});

app.post('/admin_add_menu', (req, res) => {
  const { name, category, price, description } = req.body;
  db.query("INSERT INTO menu_items (name, category, price, description) VALUES (?, ?, ?, ?)", [name, category, price, description], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Menu item added" });
  });
});

app.post('/admin_update_menu', (req, res) => {
  const { id, name, category, price, description } = req.body;
  db.query("UPDATE menu_items SET name=?, category=?, price=?, description=? WHERE id=?", [name, category, price, description, id], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Menu item updated" });
  });
});

app.post('/admin_delete_menu', (req, res) => {
  const { id } = req.body;
  db.query("DELETE FROM menu_items WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, message: "Menu item deleted" });
  });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
