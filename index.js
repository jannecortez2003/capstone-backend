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

// --- Test Route ---
app.get('/', (req, res) => {
  res.send('Node.js Backend is running perfectly!');
});

// ==========================================
// 1. AUTHENTICATION ROUTES (Login & Register)
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
      res.json({
        success: true,
        message: "User registered successfully",
        user: { id: result.insertId, fullName: name, email: email, verified: false }
      });
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
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      res.json({
        success: true,
        message: "Login successful",
        user: { id: user.id, fullName: user.username, email: user.email, verified: Boolean(user.is_verified) }
      });
    } else {
      res.status(400).json({ success: false, message: "Invalid password" });
    }
  });
});

// --- ADMIN LOGIN ROUTE ---
app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  db.query("SELECT * FROM admins WHERE username = ?", [username], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length === 0) return res.status(400).json({ success: false, message: "Admin not found" });

    const admin = results[0];

    if (password === admin.password) {
      res.json({
        success: true,
        message: "Login successful",
        admin: {
          id: admin.id,
          username: admin.username,
          role: 'admin'
        }
      });
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
    const bookedDates = results.map(row => row.preferred_date);
    res.json({ success: true, bookedDates });
  });
});

app.get('/fetch_user_appointments', (req, res) => {
  const userId = req.query.user_id; 
  if (!userId) return res.status(400).json({ success: false, message: "User ID is required." });

  const sql = "SELECT id, event_type, package_type, preferred_date, guest_count, status, total_cost FROM appointments WHERE user_id = ? ORDER BY created_at DESC";
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Error fetching appointments" });
    res.json({ success: true, appointments: results });
  });
});

app.post('/book_event', (req, res) => {
  const { userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes } = req.body;
  if (!userId || !eventType || !packageType || !preferredDate || !guestCount || !selectedDishes) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  const inventoryNeedsPerGuest = { 'Chairs': 1, 'Plate': 1, 'Utensils - Spoon': 1, 'Utensils - Fork': 1 };
  const inventoryNeedsRatio = { 'Table (10 seater)': 10 };
  let requiredInventory = [];

  for (const [item, itemsPerGuest] of Object.entries(inventoryNeedsPerGuest)) {
    const quantity = itemsPerGuest * guestCount;
    if (quantity > 0) requiredInventory.push(`${item}: ${quantity}`);
  }
  for (const [item, ratio] of Object.entries(inventoryNeedsRatio)) {
    const quantity = Math.ceil(guestCount / ratio);
    if (quantity > 0) requiredInventory.push(`${item}: ${quantity}`);
  }
  requiredInventory.push('Lights (assorted): 1');
  const requiredInventoryStr = requiredInventory.join('; ');

  const sql = `INSERT INTO appointments (user_id, event_type, package_type, preferred_date, guest_count, selected_dishes, required_inventory, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`;
  db.query(sql, [userId, eventType, packageType, preferredDate, guestCount, selectedDishes, requiredInventoryStr, notes || ''], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: "Database error: " + err.message });
    res.json({ success: true, message: "Event booking successful. We will contact you shortly!", booking_id: result.insertId });
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
      stats: {
        bookings: bookingsRow?.count || 0,
        revenue: revenueRow?.total || 0,
        menuItems: menuRow?.count || 0,
        customers: userRow?.count || 0
      },
      upcomingEvents: events
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Database error fetching stats" });
  }
});

app.get('/admin_fetch_bookings', (req, res) => {
  const sql = `
    SELECT a.*, u.username as customer_name, u.email as customer_email,
    COALESCE(SUM(p.amount_paid), 0) as amount_paid,
    (a.total_cost - COALESCE(SUM(p.amount_paid), 0)) as balance
    FROM appointments a
    LEFT JOIN users u ON a.user_id = u.id 
    LEFT JOIN payments p ON a.id = p.appointment_id
    GROUP BY a.id ORDER BY a.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    
    const formattedBookings = results.map(row => ({
      ...row,
      customer_name: row.customer_name || `Unknown User`,
      customer_email: row.customer_email || "N/A",
      total_cost: parseFloat(row.total_cost) || 0,
      amount_paid: parseFloat(row.amount_paid) || 0,
      balance: parseFloat(row.balance) || 0
    }));
    res.json({ success: true, bookings: formattedBookings });
  });
});

app.post('/admin_update_booking_status', (req, res) => {
  const { bookingId, status } = req.body;
  if (!bookingId || !status) return res.status(400).json({ success: false, message: "Missing data" });

  let sql = "UPDATE appointments SET status = ? WHERE id = ?";
  if (status === 'Confirmed') {
    sql = "UPDATE appointments SET status = ?, total_cost = COALESCE(total_cost, 30000.00) WHERE id = ?";
  }

  db.query("ALTER TABLE appointments MODIFY COLUMN status ENUM('Pending', 'Confirmed', 'Cancelled', 'Completed') NOT NULL DEFAULT 'Pending'", (err) => {
    db.query(sql, [status, bookingId], (err, result) => {
      if (err) return res.status(500).json({ success: false, message: "Error updating status" });
      res.json({ success: true, message: `Booking #${bookingId} status successfully updated to ${status}.` });
    });
  });
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
