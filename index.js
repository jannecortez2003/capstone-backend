require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const multer = require('multer'); 
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Serve uploaded images publicly
app.use('/uploads', express.static('uploads'));

// Setup folder for ID uploads
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- Database Connection ---
// FIX: Using createPool instead of createConnection prevents idle timeouts!
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.get('/', (req, res) => res.send('Node.js Backend is running perfectly!'));

// ==========================================
// 1. AUTHENTICATION & USERS
// ==========================================
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length > 0) return res.status(400).json({ success: false, message: "Email already registered" });
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query("INSERT INTO users (username, email, password, is_verified) VALUES (?, ?, ?, 0)", [name, email, hashedPassword], (err, result) => {
          if (err) return res.status(500).json({ success: false, message: "Registration failed" });
          return res.json({ success: true, message: "User registered", user: { id: result.insertId, fullName: name, email, verified: false } });
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Encryption error" });
    }
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body; 
  db.query("SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1", [email, email], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length === 0) return res.status(400).json({ success: false, message: "No user found" });
    
    const user = results[0];
    try {
        let isMatch = (user.password && user.password.startsWith('$2')) ? await bcrypt.compare(password, user.password) : (password === user.password);
        if (isMatch) return res.json({ success: true, message: "Login successful", user: { id: user.id, fullName: user.username, email: user.email, verified: Boolean(user.is_verified) } });
        return res.status(400).json({ success: false, message: "Invalid password" });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Verification error" });
    }
  });
});

app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;
  db.query("SELECT * FROM admins WHERE username = ?", [username], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    if (results.length === 0) return res.status(400).json({ success: false, message: "Admin not found" });
    
    if (password === results[0].password) return res.json({ success: true, message: "Login successful", admin: { id: results[0].id, username: results[0].username, role: 'admin' } });
    return res.status(400).json({ success: false, message: "Invalid password" });
  });
});

// ==========================================
// 2. CLIENT BOOKING & VERIFICATION
// ==========================================
app.get('/fetch_booked_dates', (req, res) => {
  db.query("SELECT preferred_date FROM appointments WHERE status != 'Cancelled'", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, bookedDates: results.map(row => row.preferred_date) });
  });
});

app.get('/fetch_user_appointments', (req, res) => {
  db.query("SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC", [req.query.user_id], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, appointments: results });
  });
});

app.get('/fetch_user_transactions', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ success: false, message: "User ID required" });

  try {
    const promiseDb = db.promise();

    // 1. Fetch Payments (Linking payments to the user's appointments)
    const [transactions] = await promiseDb.query(`
      SELECT p.id, p.amount_paid, p.payment_date, p.payment_method, a.status, a.event_type, a.preferred_date 
      FROM payments p
      JOIN appointments a ON p.appointment_id = a.id
      WHERE a.user_id = ?
      ORDER BY p.payment_date DESC
    `, [userId]);

    let total_spent = 0;
    transactions.forEach(t => {
        total_spent += parseFloat(t.amount_paid || 0);
    });

    // 2. Fetch Booking Stats
    const [statsResult] = await promiseDb.query(`
      SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'Confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed
      FROM appointments WHERE user_id = ?
    `, [userId]);

    const stats = statsResult[0] || {};

    return res.json({
      success: true,
      transactions: transactions,
      stats: {
        total_bookings: stats.total_bookings || 0,
        pending: stats.pending || 0,
        confirmed: stats.confirmed || 0,
        completed: stats.completed || 0,
        total_spent: total_spent
      }
    });

  } catch (error) {
    console.error("Transaction Fetch Error:", error);
    return res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post('/book_event', (req, res) => {
  const { userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes } = req.body;
  db.query(`INSERT INTO appointments (user_id, event_type, package_type, preferred_date, guest_count, selected_dishes, required_inventory, notes, status) VALUES (?, ?, ?, ?, ?, ?, '', ?, 'Pending')`, 
  [userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes || ''], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, message: "Event booking successful!", booking_id: result.insertId });
  });
});

app.post('/verify', upload.single('idImage'), (req, res) => {
  const { userId, idType, idNumber, lastName, firstName, address } = req.body;
  const imagePath = req.file ? req.file.path : '';
  db.query("INSERT INTO user_verifications (user_id, id_type, id_number, first_name, last_name, address, id_image_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')", 
  [userId, idType, idNumber, firstName, lastName, address, imagePath], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, message: "Verification submitted. Please wait for admin approval." });
  });
});

// ==========================================
// 3. ADMIN DASHBOARD & BOOKINGS
// ==========================================
app.get('/admin_fetch_dashboard_stats', async (req, res) => {
  try {
    const pDb = db.promise();
    const [[b]] = await pDb.query("SELECT COUNT(*) as c FROM appointments");
    const [[r]] = await pDb.query("SELECT SUM(amount_paid) as t FROM payments");
    const [[m]] = await pDb.query("SELECT COUNT(*) as c FROM menu_items");
    const [[u]] = await pDb.query("SELECT COUNT(*) as c FROM users WHERE is_verified = 1");
    const [ev] = await pDb.query("SELECT * FROM appointments WHERE preferred_date >= CURDATE() ORDER BY preferred_date ASC LIMIT 5");
    return res.json({ success: true, stats: { bookings: b.c||0, revenue: r.t||0, menuItems: m.c||0, customers: u.c||0 }, upcomingEvents: ev });
  } catch (e) { 
    return res.status(500).json({ success: false, message: "Database error" }); 
  }
});

app.get('/admin_fetch_bookings', (req, res) => {
  db.query(`SELECT a.*, u.username as customer_name, u.email as customer_email, COALESCE(SUM(p.amount_paid), 0) as amount_paid, (COALESCE(a.total_cost, 0) - COALESCE(SUM(p.amount_paid), 0)) as balance FROM appointments a LEFT JOIN users u ON a.user_id = u.id LEFT JOIN payments p ON a.id = p.appointment_id GROUP BY a.id ORDER BY a.created_at DESC`, (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, bookings: results });
  });
});

app.post('/admin_update_booking_status', (req, res) => {
  const { bookingId, status } = req.body;
  const sql = status === 'Confirmed' ? "UPDATE appointments SET status = ?, total_cost = COALESCE(total_cost, 30000.00) WHERE id = ?" : "UPDATE appointments SET status = ? WHERE id = ?";
  db.query(sql, [status, bookingId], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, message: "Status updated" });
  });
});

// ==========================================
// 4. ADMIN - INVENTORY, MENU, STAFF
// ==========================================
app.get('/admin_fetch_inventory', (req, res) => {
    db.query("SELECT * FROM inventory", (err, r) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true, inventory: r });
    });
});
app.post('/admin_add_inventory', (req, res) => {
    db.query("INSERT INTO inventory (name, quantity, unit) VALUES (?, ?, ?)", [req.body.name, req.body.quantity, req.body.unit], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_update_inventory', (req, res) => {
    db.query("UPDATE inventory SET name=?, quantity=?, unit=? WHERE id=?", [req.body.name, req.body.quantity, req.body.unit, req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_delete_inventory', (req, res) => {
    db.query("DELETE FROM inventory WHERE id = ?", [req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});

app.get('/admin_fetch_menu', (req, res) => {
    db.query("SELECT * FROM menu_items", (err, r) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true, items: r });
    });
});
app.post('/admin_add_menu', (req, res) => {
    db.query("INSERT INTO menu_items (name, category, price, description) VALUES (?, ?, ?, ?)", [req.body.name, req.body.category, req.body.price, req.body.description], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_update_menu', (req, res) => {
    db.query("UPDATE menu_items SET name=?, category=?, price=?, description=? WHERE id=?", [req.body.name, req.body.category, req.body.price, req.body.description, req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_delete_menu', (req, res) => {
    db.query("DELETE FROM menu_items WHERE id = ?", [req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});

app.get('/admin_fetch_staff', (req, res) => {
    db.query("SELECT * FROM staff", (err, r) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true, staff: r });
    });
});
app.post('/admin_add_staff', (req, res) => {
    db.query("INSERT INTO staff (name, role, email, phone) VALUES (?, ?, ?, ?)", [req.body.name, req.body.role, req.body.email, req.body.phone], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_update_staff', (req, res) => {
    db.query("UPDATE staff SET name=?, role=?, email=?, phone=? WHERE id=?", [req.body.name, req.body.role, req.body.email, req.body.phone, req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});
app.post('/admin_delete_staff', (req, res) => {
    db.query("DELETE FROM staff WHERE id = ?", [req.body.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true });
    });
});

// ==========================================
// 5. ADMIN - PAYMENTS, REPORTS, VERIFY
// ==========================================
app.get('/admin_fetch_payment_history', (req, res) => {
  db.query("SELECT * FROM payments WHERE appointment_id = ? ORDER BY transaction_date DESC", [req.query.appointmentId], (err, r) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, history: r });
  });
});
app.post('/admin_process_payment', (req, res) => {
  const appointmentId = req.body.appointmentId;
  const amount = req.body.amount;
  // This automatically grabs the payment method sent from your frontend
  const paymentMethod = req.body.paymentMethod || req.body.paymentType || 'Cash'; 

  // Safely inserts into the correct 'payment_method' column and removes the 'remarks' column
  db.query(
    "INSERT INTO payments (appointment_id, amount_paid, payment_method) VALUES (?, ?, ?)", 
    [appointmentId, amount, paymentMethod], 
    (err) => {
      if (err) {
        console.error("Payment Insert Error:", err); // Helps us see the exact error if it fails again
        return res.status(500).json({ success: false, message: "Database error" });
      }
      return res.json({ success: true });
  });
});

app.get('/admin_fetch_reports', async (req, res) => {
  try {
    const pDb = db.promise();
    const [[rev]] = await pDb.query("SELECT SUM(amount_paid) as r FROM payments");
    const [[bk]] = await pDb.query("SELECT COUNT(*) as c FROM appointments");
    const [pkgs] = await pDb.query("SELECT package_type, COUNT(*) as count FROM appointments GROUP BY package_type");
    const revenue = rev.r || 0;
    return res.json({ success: true, summary: { revenue, expenses: revenue * 0.4, profit: revenue * 0.6, total_bookings: bk.c || 0 }, packages: pkgs });
  } catch (e) { 
    return res.status(500).json({ success: false, message: "Database error" }); 
  }
});

app.get('/admin_fetch_verification', (req, res) => {
  db.query("SELECT * FROM user_verifications WHERE status = 'Pending'", (err, r) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, requests: r });
  });
});

app.post('/admin_verify_user', (req, res) => {
  const { requestId, status } = req.body;
  db.query("UPDATE user_verifications SET status = ? WHERE id = ?", [status, requestId], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    
    if (status === 'Verified') {
        db.query("UPDATE users SET is_verified = 1 WHERE id = (SELECT user_id FROM user_verifications WHERE id = ?)", [requestId], (updateErr) => {
            if (updateErr) console.error("Failed to verify user account:", updateErr);
        });
    }
    return res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
