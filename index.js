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

// Helper function to log admin activities
async function logSystemActivity(type, description) {
    try {
        const pDb = db.promise();
        await pDb.query("INSERT INTO activity_logs (type, description) VALUES (?, ?)", [type, description]);
    } catch (err) {
        console.error("Failed to log activity:", err);
    }
}

// NEW: Helper function to send notifications to clients
async function createNotification(userId, message) {
    try {
        const pDb = db.promise();
        await pDb.query("INSERT INTO notifications (user_id, message) VALUES (?, ?)", [userId, message]);
    } catch (err) {
        console.error("Failed to create notification:", err);
    }
}

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
// 2. CLIENT NOTIFICATIONS & BOOKING ROUTES
// ==========================================

app.get('/fetch_notifications', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ success: false, message: "User ID required" });

  db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, notifications: results });
  });
});

app.post('/mark_notifications_read', (req, res) => {
  const { userId } = req.body;
  db.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [userId], (err) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true });
  });
});

app.post('/notify_chat_message', (req, res) => {
  const { userId } = req.body;
  createNotification(userId, "You have a new unread message from our support team.");
  res.json({ success: true });
});

app.get('/fetch_booked_dates', (req, res) => {
  db.query("SELECT preferred_date FROM appointments WHERE status != 'Cancelled'", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    res.json({ success: true, bookedDates: results.map(row => row.preferred_date) });
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

app.get('/fetch_user_payments', (req, res) => {
  const userId = req.query.user_id; 
  if (!userId) return res.status(400).json({ success: false, message: "User ID is required." });

  const sql = `
    SELECT p.id, p.amount_paid, p.payment_type, p.transaction_date, p.remarks, a.event_type 
    FROM payments p 
    JOIN appointments a ON p.appointment_id = a.id 
    WHERE a.user_id = ? 
    ORDER BY p.transaction_date DESC
  `;
  
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Error fetching payments" });
    res.json({ success: true, payments: results });
  });
});

app.post('/book_event', (req, res) => {
  const { userId, eventType, packageType, preferredDate, guestCount, selectedDishes, notes } = req.body;
  if (!userId || !eventType || !packageType || !preferredDate || !guestCount || !selectedDishes) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  const inventoryNeedsPerGuest = { 'Chairs': 1, 'Plate': 1, 'Utensils - Spoon': 1, 'Utensils - Fork': 1, 'Glass': 1, 'Table Napkin': 1 };
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
    createNotification(userId, `Your booking for ${eventType} on ${preferredDate} has been received and is pending review.`);
    res.json({ success: true, message: "Event booking successful. We will contact you shortly!", booking_id: result.insertId });
  });
});

// ==========================================
// 3. ADMIN DASHBOARD & BOOKINGS
// ==========================================

app.get('/admin_fetch_dashboard_stats', async (req, res) => {
  try {
    const promiseDb = db.promise();
    const [[bookingsRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM appointments WHERE status IN ('Pending', 'Confirmed')");
    const [[revenueRow]] = await promiseDb.query("SELECT SUM(amount_paid) as total FROM payments");
    const [[menuRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM menu_items");
    const [[userRow]] = await promiseDb.query("SELECT COUNT(*) as count FROM users WHERE is_verified = 1");
    
    // 🔥 FIX: Only fetch Pending and Confirmed events for the Dashboard
    const [events] = await promiseDb.query("SELECT id, event_type, preferred_date, guest_count, status FROM appointments WHERE status IN ('Pending', 'Confirmed') ORDER BY preferred_date ASC");

    res.json({
      success: true,
      stats: { bookings: bookingsRow?.count || 0, revenue: revenueRow?.total || 0, menuItems: menuRow?.count || 0, customers: userRow?.count || 0 },
      upcomingEvents: events
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error fetching stats" });
  }
});

app.get('/admin_fetch_bookings', (req, res) => {
  const sql = `
    SELECT a.*, u.username as customer_name, u.email as customer_email,
    COALESCE(SUM(p.amount_paid), 0) as amount_paid,
    (a.total_cost - COALESCE(SUM(p.amount_paid), 0)) as balance
    FROM appointments a LEFT JOIN users u ON a.user_id = u.id 
    LEFT JOIN payments p ON a.id = p.appointment_id
    GROUP BY a.id, u.username, u.email ORDER BY a.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "Database error" });
    const formattedBookings = results.map(row => ({
      ...row, customer_name: row.customer_name || `Unknown User`, customer_email: row.customer_email || "N/A",
      total_cost: parseFloat(row.total_cost) || 0, amount_paid: parseFloat(row.amount_paid) || 0, balance: parseFloat(row.balance) || 0
    }));
    res.json({ success: true, bookings: formattedBookings });
  });
});

app.post('/admin_update_booking_status', async (req, res) => {
  const { bookingId, status } = req.body;
  if (!bookingId || !status) return res.status(400).json({ success: false, message: "Missing data" });

  try {
    const pDb = db.promise();
    
    // 1. Fetch details (FIXED: Changed u.full_name to u.username)
    const [rows] = await pDb.query(`
        SELECT a.user_id, a.required_inventory, a.status, a.event_type, a.preferred_date, u.username 
        FROM appointments a 
        LEFT JOIN users u ON a.user_id = u.id 
        WHERE a.id = ?
    `, [bookingId]);
    
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Booking not found" });
    const booking = rows[0];
    
    // 2. Auto-Deduction and Status Update Logic
    if (status === 'Confirmed' && booking.status !== 'Confirmed') {
      if (booking.required_inventory) {
        const items = booking.required_inventory.split('; '); 
        for (let itemStr of items) {
          const [itemName, qtyStr] = itemStr.split(': ');
          const qtyToDeduct = parseInt(qtyStr);
          if (itemName && qtyToDeduct > 0) {
            await pDb.query("UPDATE inventory SET quantity = quantity - ? WHERE name = ?", [qtyToDeduct, itemName]);
            await pDb.query("INSERT INTO inventory_logs (item_name, quantity_change, action_type, remarks) VALUES (?, ?, ?, ?)", [itemName, -qtyToDeduct, 'Auto-Deduction', `Allocated for Booking #${bookingId}`]);
          }
        }
      }
      await pDb.query("UPDATE appointments SET status = ?, total_cost = COALESCE(total_cost, 30000.00) WHERE id = ?", [status, bookingId]);
    } else {
      await pDb.query("UPDATE appointments SET status = ? WHERE id = ?", [status, bookingId]);
    }

    // 3. Send Notification to User
    if (typeof createNotification === 'function') {
        await createNotification(booking.user_id, `Your ${booking.event_type} event booking status is now: ${status}.`);
    }

    // 4. DETAILED ACTIVITY LOG (FIXED: Changed booking.full_name to booking.username)
    const clientName = booking.username || 'Unknown Client';
    const dateObj = new Date(booking.preferred_date);
    const formattedDate = !booking.preferred_date || isNaN(dateObj.getTime()) 
        ? 'Unknown Date' 
        : dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    
    const logMessage = `Updated booking to "${status}" for ${clientName} (${booking.event_type} on ${formattedDate})`;
    await logSystemActivity('Booking', logMessage);

    res.json({ success: true, message: `Booking #${bookingId} status successfully updated to ${status}.` });
    
  } catch (err) {
    console.error("Error updating booking status:", err);
    res.status(500).json({ success: false, message: "Error updating status." });
  }
});

app.post('/admin_reconcile_booking', async (req, res) => {
  // 1. Add default {} to damagedItems to prevent undefined crashes
  const { bookingId, damagedItems = {} } = req.body; 
  if (!bookingId) return res.status(400).json({ success: false, message: "Missing booking ID" });

  try {
    const pDb = db.promise();
    
    // 2. Validate that the booking actually exists in the database
    const [rows] = await pDb.query("SELECT user_id, required_inventory FROM appointments WHERE id = ?", [bookingId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Booking not found in database." });
    
    const booking = rows[0];
    
    // 3. Safer item deduction loop
    if (booking.required_inventory) {
      const items = booking.required_inventory.split('; ');
      for (let itemStr of items) {
        const [itemName, allocatedQtyStr] = itemStr.split(': ');
        const allocatedQty = parseInt(allocatedQtyStr) || 0;
        const damagedQty = damagedItems[itemName] ? parseInt(damagedItems[itemName]) : 0;
        const returnQty = allocatedQty - damagedQty;
        
        if (returnQty > 0 && itemName) {
          await pDb.query("UPDATE inventory SET quantity = quantity + ? WHERE name = ?", [returnQty, itemName]);
          await pDb.query("INSERT INTO inventory_logs (item_name, quantity_change, action_type, remarks) VALUES (?, ?, ?, ?)", [itemName, returnQty, 'Reconciliation Return', `Returned from Booking #${bookingId}`]);
        }
      }
    }
    
    await pDb.query("UPDATE appointments SET status = 'Completed' WHERE id = ?", [bookingId]);
    
    if (typeof createNotification === 'function') {
        await createNotification(booking.user_id, `Your booking #${bookingId} has been successfully completed. Thank you!`);
    }
    await logSystemActivity('Booking', `Reconciled and Completed Booking #${bookingId}`);
    
    res.json({ success: true, message: "Event completed and inventory successfully reconciled!" });
  } catch (err) {
    console.error("Reconciliation Error:", err);
    // 4. Send exact error back to the frontend
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

// --- DELETE BOOKING ---
app.post('/admin_delete_booking', async (req, res) => {
  const id = req.body.id || req.body.bookingId || req.params.id;
  if (!id) return res.status(400).json({ success: false, message: "Missing ID" });

  try {
    const pDb = db.promise();

    // 🚨 1. Fetch the user's name and event date BEFORE deleting (FIXED: Changed u.full_name to u.username)
    const [bookingInfo] = await pDb.query(`
        SELECT a.event_type, a.preferred_date, u.username 
        FROM appointments a 
        LEFT JOIN users u ON a.user_id = u.id 
        WHERE a.id = ?
    `, [id]);

    let logMessage = `Deleted booking ID ${id}`;

    if (bookingInfo.length > 0) {
        // FIXED: Changed full_name to username
        const { event_type, preferred_date, username } = bookingInfo[0];
        const clientName = username || 'Unknown Client';
        const dateObj = new Date(preferred_date);
        const formattedDate = !preferred_date || isNaN(dateObj.getTime()) 
            ? 'Unknown Date' 
            : dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        
        logMessage = `Deleted booking for ${clientName} (${event_type} on ${formattedDate})`;
    }

    // 2. Delete the booking
    await pDb.query('DELETE FROM appointments WHERE id = ?', [id]);
    
    // 3. Log the detailed action (USING CORRECT LOG FUNCTION)
    await logSystemActivity('Booking', logMessage);

    res.json({ success: true, message: 'Booking deleted' });
  } catch (err) {
    console.error("Error deleting booking:", err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================
// 4. ADMIN - INVENTORY, MENU, STAFF
// ==========================================

// --- INVENTORY ---
app.get('/admin_fetch_inventory', (req, res) => {
    db.query("SELECT * FROM inventory", (err, r) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true, inventory: r });
    });
});
app.get('/admin_fetch_inventory_logs', (req, res) => {
  db.query("SELECT * FROM inventory_logs ORDER BY created_at DESC", (err, results) => {
    res.json({ success: true, logs: results });
  });
});
app.post('/admin_add_inventory', (req, res) => {
    db.query("SELECT id FROM inventory WHERE name = ?", [req.body.name], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        if (results.length > 0) return res.status(400).json({ success: false, message: "An item with this name already exists!" });

        db.query("INSERT INTO inventory (name, quantity, unit) VALUES (?, ?, ?)", [req.body.name, req.body.quantity, req.body.unit], async (err) => {
            if (err) return res.status(500).json({ success: false, message: "Database error" });
            await logSystemActivity('Inventory', `Added new inventory item: ${req.body.name}`);
            return res.json({ success: true });
        });
    });
});
app.post('/admin_update_inventory', (req, res) => {
    db.query("UPDATE inventory SET name=?, quantity=?, unit=? WHERE id=?", [req.body.name, req.body.quantity, req.body.unit, req.body.id], async (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        await logSystemActivity('Inventory', `Updated inventory item: ${req.body.name}`);
        return res.json({ success: true });
    });
});
app.post('/admin_delete_inventory', async (req, res) => {
  const id = req.body.id || req.params.id; 
  if (!id) return res.status(400).json({ success: false, message: "Missing ID" });

  try {
    const pDb = db.promise();
    
    // 🚨 1. Fetch the item name BEFORE deleting it
    const [item] = await pDb.query('SELECT name FROM inventory WHERE id = ?', [id]);
    const itemName = item.length > 0 ? item[0].name : `Item ID ${id}`;

    // 2. Delete the item
    await pDb.query('DELETE FROM inventory WHERE id = ?', [id]);

    // 3. Log the descriptive action (USING CORRECT LOG FUNCTION)
    await logSystemActivity('Inventory', `Deleted inventory item: ${itemName}`);

    res.json({ success: true, message: 'Inventory item deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- MENU ---
app.get('/admin_fetch_menu', (req, res) => {
    db.query("SELECT * FROM menu_items", (err, r) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        return res.json({ success: true, items: r });
    });
});
app.post('/admin_add_menu', (req, res) => {
    db.query("SELECT id FROM menu_items WHERE name = ?", [req.body.name], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        if (results.length > 0) return res.status(400).json({ success: false, message: "A menu dish with this name already exists!" });

        db.query("INSERT INTO menu_items (name, category, price, description) VALUES (?, ?, ?, ?)", [req.body.name, req.body.category, req.body.price, req.body.description], async (err) => {
            if (err) return res.status(500).json({ success: false, message: "Database error" });
            await logSystemActivity('Menu', `Added new menu item: ${req.body.name}`);
            return res.json({ success: true });
        });
    });
});
app.post('/admin_update_menu', (req, res) => {
    db.query("UPDATE menu_items SET name=?, category=?, price=?, description=? WHERE id=?", [req.body.name, req.body.category, req.body.price, req.body.description, req.body.id], async (err) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        await logSystemActivity('Menu', `Updated menu item: ${req.body.name}`);
        return res.json({ success: true });
    });
});
app.post('/admin_delete_menu', async (req, res) => {
  const id = req.body.id || req.params.id;
  if (!id) return res.status(400).json({ success: false, message: "Missing ID" });

  try {
    const pDb = db.promise();
    
    // 🚨 1. Fetch the dish name BEFORE deleting it
    const [dish] = await pDb.query('SELECT name FROM menu_items WHERE id = ?', [id]);
    const dishName = dish.length > 0 ? dish[0].name : `Dish ID ${id}`;

    // 2. Delete the item
    await pDb.query('DELETE FROM menu_items WHERE id = ?', [id]);

    // 3. Log the descriptive action (USING CORRECT LOG FUNCTION)
    await logSystemActivity('Menu', `Deleted menu item: ${dishName}`);

    res.json({ success: true, message: 'Menu item deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- STAFF & PAYMENTS & REPORTS---
app.get('/admin_fetch_staff', (req, res) => {
    db.query("SELECT * FROM staff", (err, r) => { res.json({ success: true, staff: r }); });
});
app.post('/admin_add_staff', (req, res) => {
    db.query("INSERT INTO staff (name, role, email, phone) VALUES (?, ?, ?, ?)", [req.body.name, req.body.role, req.body.email, req.body.phone], () => { res.json({ success: true }); });
});
app.post('/admin_update_staff', (req, res) => {
    db.query("UPDATE staff SET name=?, role=?, email=?, phone=? WHERE id=?", [req.body.name, req.body.role, req.body.email, req.body.phone, req.body.id], () => { res.json({ success: true }); });
});
app.post('/admin_delete_staff', async (req, res) => {
    const id = req.body.id || req.params.id;
    try {
        const pDb = db.promise();
        const [staff] = await pDb.query('SELECT name FROM staff WHERE id = ?', [id]);
        const staffName = staff.length > 0 ? staff[0].name : `Staff ID ${id}`;
        
        await pDb.query("DELETE FROM staff WHERE id = ?", [id]);
        await logSystemActivity('Staff', `Deleted staff member: ${staffName}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get('/admin_fetch_all_payments', (req, res) => {
  db.query(`SELECT p.*, a.event_type, u.username as customer_name FROM payments p LEFT JOIN appointments a ON p.appointment_id = a.id LEFT JOIN users u ON a.user_id = u.id ORDER BY p.transaction_date DESC`, (err, results) => {
    res.json({ success: true, payments: results });
  });
});
app.get('/admin_fetch_payment_history', (req, res) => {
  db.query("SELECT * FROM payments WHERE appointment_id = ? ORDER BY transaction_date DESC", [req.query.appointmentId], (err, r) => {
    res.json({ success: true, history: r });
  });
});

app.post('/admin_process_payment', async (req, res) => {
  const { appointmentId, amount, paymentType, remarks } = req.body;
  
  if (!appointmentId || !amount) {
      return res.status(400).json({ success: false, message: "Appointment ID and Amount are required." });
  }

  try {
      const pDb = db.promise();
      
      // FIX 1: We explicitly pass NOW() for transaction_date to prevent null timestamp errors
      await pDb.query(
          "INSERT INTO payments (appointment_id, amount_paid, payment_type, remarks, transaction_date) VALUES (?, ?, ?, ?, NOW())", 
          [appointmentId, amount, paymentType || 'Cash', remarks || '']
      );
      
      await logSystemActivity('Payment', `Processed payment of ₱${amount} for Booking #${appointmentId}`);
      
      res.json({ success: true, message: "Payment recorded successfully" });
  } catch (err) {
      console.error("Payment Database Error:", err);
      // FIX 2: Send the EXACT error message back to the frontend so we aren't guessing
      res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

app.get('/admin_fetch_users', (req, res) => {
  db.query("SELECT id, username, email, is_verified, created_at FROM users ORDER BY created_at DESC", (err, results) => {
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
    UNION ALL
    SELECT type, date, description FROM activity_logs
    ORDER BY date DESC LIMIT 50
  `;
  db.query(sql, (err, results) => {
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
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.get('/admin_fetch_verification', (req, res) => {
  db.query("SELECT * FROM verification_requests WHERE status = 'Pending'", (err, r) => { res.json({ success: true, requests: r }); });
});

app.post('/admin_verify_user', (req, res) => {
  const { requestId, status } = req.body;
  db.query("UPDATE verification_requests SET status = ? WHERE id = ?", [status, requestId], (err) => {
    if (status === 'Verified') {
        db.query("UPDATE users SET is_verified = 1 WHERE id = (SELECT user_id FROM verification_requests WHERE id = ?)", [requestId]);
    }
    return res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
