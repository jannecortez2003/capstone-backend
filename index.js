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
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: true 
  }
});

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
        admin: { id: admin.id, username: admin.username, role: 'admin' }
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

  const sql = `INSERT INTO appointments (user_id, event_type, package_type, preferred_date, guest_count, selected_dishes, required_inventory, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`;
  db.query(sql, [userId, eventType, packageType, preferredDate, guestCount, selectedDishes, requiredInventoryStr], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: "Database error: " + err.message });
    res.json({ success: true, message: "Event booking successful. We will contact you shortly!", booking_id: result.insertId });
  });
});

// ==========================================
// 3. ADMIN DASHBOARD & BOOKINGS
// ==========================================

app.get('/admin_fetch_dashboard_stats', async (req, res) => {
  try {
    const promiseDb = db.promise();
    const [[bookingsRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM appointments");
    const [[revenueRow]] = await promiseDb.query("SELECT SUM(amount_paid) as total FROM payments");
    const [[menuRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM menu_items");
    const [[userRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM users WHERE is_verified = 1");
    
    // FIX: Show all active/pending bookings so nothing is hidden
    const [events] = await promiseDb.query("SELECT id, event_type, preferred_date, status FROM appointments WHERE status IN ('Pending', 'Confirmed') ORDER BY preferred_date ASC");

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
  // FIX: Grouped properly to prevent SQL Strict Mode from dropping the query
  const sql = `
    SELECT a.*, u.username as customer_name, u.email as customer_email,
    COALESCE(SUM(p.amount_paid), 0) as amount_paid,
    (a.total_cost - COALESCE(SUM(p.amount_paid), 0)) as balance
    FROM appointments a
    LEFT JOIN users u ON a.user_id = u.id 
    LEFT JOIN payments p ON a.id = p.appointment_id
    GROUP BY a.id, u.username, u.email ORDER BY a.created_at DESC
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

app.post('/admin_update_booking_status', async (req, res) => {
  const { bookingId, status } = req.body;
  if (!bookingId || !status) return res.status(400).json({ success: false, message: "Missing data" });

  try {
    const pDb = db.promise();
    
    // SMART INVENTORY AUTO-DEDUCTION
    if (status === 'Confirmed') {
      // Fetch the booking details to get the required inventory
      const [rows] = await pDb.query("SELECT required_inventory, status FROM appointments WHERE id = ?", [bookingId]);
      const booking = rows[0];

      // Only deduct if it wasn't already confirmed (prevents double deduction)
      if (booking.status !== 'Confirmed' && booking.required_inventory) {
        const items = booking.required_inventory.split('; '); // e.g. ["Chairs: 50", "Plate: 50"]
        
        for (let itemStr of items) {
          const [itemName, qtyStr] = itemStr.split(': ');
          const qtyToDeduct = parseInt(qtyStr);
          
          if (itemName && qtyToDeduct > 0) {
            // Subtract from inventory
            await pDb.query("UPDATE inventory SET quantity = quantity - ? WHERE name = ?", [qtyToDeduct, itemName]);
          }
        }
      }
      // Update appointment to confirmed and set standard cost
      await pDb.query("UPDATE appointments SET status = ?, total_cost = COALESCE(total_cost, 30000.00) WHERE id = ?", [status, bookingId]);
    } else {
      // For Pending or Cancelled
      await pDb.query("UPDATE appointments SET status = ? WHERE id = ?", [status, bookingId]);
    }

    res.json({ success: true, message: `Booking #${bookingId} status successfully updated to ${status}. Inventory adjusted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error updating status or inventory." });
  }
});

app.post('/admin_reconcile_booking', async (req, res) => {
  const { bookingId, damagedItems } = req.body; 
  // damagedItems will look like: { 'Chairs': 2, 'Plate': 5 }

  try {
    const pDb = db.promise();
    
    // Fetch what was originally allocated for this event
    const [rows] = await pDb.query("SELECT required_inventory FROM appointments WHERE id = ?", [bookingId]);
    const reqInv = rows[0].required_inventory;
    
    if (reqInv) {
      const items = reqInv.split('; ');
      for (let itemStr of items) {
        const [itemName, allocatedQtyStr] = itemStr.split(': ');
        const allocatedQty = parseInt(allocatedQtyStr);
        
        // Find if any were damaged, default to 0 if none
        const damagedQty = damagedItems[itemName] ? parseInt(damagedItems[itemName]) : 0;
        
        // Calculate how many to return to the warehouse
        const returnQty = allocatedQty - damagedQty;
        
        if (returnQty > 0) {
          await pDb.query("UPDATE inventory SET quantity = quantity + ? WHERE name = ?", [returnQty, itemName]);
        }
      }
    }
    
    // Mark event as completed
    await pDb.query("UPDATE appointments SET status = 'Completed' WHERE id = ?", [bookingId]);
    res.json({ success: true, message: "Event completed and inventory successfully reconciled!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error reconciling inventory." });
  }
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

app.get('/admin_fetch_all_payments', (req, res) => {
  const sql = `
    SELECT p.*, a.event_type, u.username as customer_name 
    FROM payments p 
    LEFT JOIN appointments a ON p.appointment_id = a.id 
    LEFT JOIN users u ON a.user_id = u.id 
    ORDER BY p.transaction_date DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, payments: results });
  });
});
app.get('/admin_fetch_payment_history', (req, res) => {
  db.query("SELECT * FROM payments WHERE appointment_id = ? ORDER BY transaction_date DESC", [req.query.appointmentId], (err, r) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, history: r });
  });
});

app.post('/admin_process_payment', (req, res) => {
  const { appointmentId, amount, paymentType, remarks } = req.body;
  db.query(
    "INSERT INTO payments (appointment_id, amount_paid, payment_type, remarks) VALUES (?, ?, ?, ?)", 
    [appointmentId, amount, paymentType || 'Additional', remarks || ''], 
    (err) => {
      if (err) {
        console.error("Payment Insert Error:", err);
        return res.status(500).json({ success: false, message: "Database error" });
      }
      return res.json({ success: true });
  });
});

// ADMIN LOGS

app.get('/admin_fetch_users', (req, res) => {
  db.query("SELECT id, username, email, is_verified, created_at FROM users ORDER BY created_at DESC", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, users: results });
  });
});
app.get('/admin_fetch_activity_logs', (req, res) => {
  const sql = `
    SELECT 'Booking' as type, created_at as date, CONCAT('New booking created for ', event_type) as description FROM appointments
    UNION ALL
    SELECT 'Payment' as type, transaction_date as date, CONCAT('Payment of ₱', amount_paid, ' received via ', payment_type) as description FROM payments
    UNION ALL
    SELECT 'User' as type, created_at as date, CONCAT('New user registered: ', username) as description FROM users
    ORDER BY date DESC LIMIT 50
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, logs: results });
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
  db.query("SELECT * FROM verification_requests WHERE status = 'Pending'", (err, r) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    return res.json({ success: true, requests: r });
  });
});

app.post('/admin_verify_user', (req, res) => {
  const { requestId, status } = req.body;
  db.query("UPDATE verification_requests SET status = ? WHERE id = ?", [status, requestId], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    
    if (status === 'Verified') {
        db.query("UPDATE users SET is_verified = 1 WHERE id = (SELECT user_id FROM verification_requests WHERE id = ?)", [requestId], (updateErr) => {
            if (updateErr) console.error("Failed to verify user account:", updateErr);
        });
    }
    return res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
