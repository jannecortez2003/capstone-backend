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

app.use('/uploads', express.static('uploads'));
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: { rejectUnauthorized: true }
});

// =====================================
// DATABASE AUTO-UPGRADES
// =====================================
db.query("SHOW COLUMNS FROM packages LIKE 'physical_assets'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE packages ADD COLUMN physical_assets TEXT NULL");
});
db.query("SHOW COLUMNS FROM appointments LIKE 'end_date'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE appointments ADD COLUMN end_date DATE NULL AFTER preferred_date");
});
db.query("SHOW COLUMNS FROM appointments LIKE 'event_time'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE appointments ADD COLUMN event_time VARCHAR(50) NULL AFTER end_date");
});
db.query("SHOW COLUMNS FROM appointments LIKE 'event_location'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE appointments ADD COLUMN event_location VARCHAR(255) NULL AFTER event_time");
});
db.query("SHOW COLUMNS FROM appointments LIKE 'service_type'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE appointments ADD COLUMN service_type VARCHAR(255) NULL AFTER event_type");
});
db.query("SHOW COLUMNS FROM payments LIKE 'receipt_url'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE payments ADD COLUMN receipt_url VARCHAR(255) NULL");
});
db.query("SHOW COLUMNS FROM admins LIKE 'role'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE admins ADD COLUMN role ENUM('admin', 'manager', 'staff') NOT NULL DEFAULT 'admin'");
});
db.query("SHOW COLUMNS FROM users LIKE 'google_id'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE users ADD COLUMN google_id VARCHAR(255) NULL");
});
db.query("SHOW COLUMNS FROM menu_items LIKE 'image_url'", (err, results) => {
    if (!err && results.length === 0) db.query("ALTER TABLE menu_items ADD COLUMN image_url VARCHAR(255) NULL");
});

app.get('/', (req, res) => { res.send('Node.js Backend is running perfectly!'); });

async function logSystemActivity(type, description) {
    try {
        const pDb = db.promise();
        await pDb.query("INSERT INTO activity_logs (type, description) VALUES (?, ?)", [type, description]);
    } catch (err) {}
}

async function createNotification(userId, message) {
    try {
        const pDb = db.promise();
        await pDb.query("INSERT INTO notifications (user_id, message) VALUES (?, ?)", [userId, message]);
    } catch (err) {}
}

// =====================================
// AUTHENTICATION ROUTES
// =====================================
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  db.query("SELECT id FROM users WHERE email = ?", [email], async (err, results) => {
    if (results.length > 0) return res.status(400).json({ success: false, message: "Email already registered" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    db.query("INSERT INTO users (username, email, password, is_verified, email_verified, email_verification_token) VALUES (?, ?, ?, 0, 0, ?)", 
    [name, email, hashedPassword, otp], async (err, result) => {
      try {
          await fetch("https://api.brevo.com/v3/smtp/email", {
              method: "POST", headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
              body: JSON.stringify({
                  sender: { name: "Mommy Rosal Catering", email: process.env.EMAIL_USER }, to: [{ email: email }],
                  subject: "Your Verification Code - Mommy Rosal Catering",
                  htmlContent: `<div style="text-align: center; padding: 20px;"><h2>Welcome to Mommy Rosal's!</h2><p>Your email verification code is:</p><h1 style="color: #db2777; letter-spacing: 5px;">${otp}</h1></div>`
              })
          });
          res.json({ success: true, message: "OTP sent to your email. Please verify." });
      } catch (mailError) {
          db.query("DELETE FROM users WHERE id = ?", [result.insertId]);
          res.status(500).json({ success: false, message: "Failed to send OTP Email. Check your backend logs." });
      }
    });
  });
});

app.post('/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    db.query("SELECT id FROM users WHERE email = ? AND email_verification_token = ?", [email, otp], (err, results) => {
        if (results.length === 0) return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
        db.query("UPDATE users SET email_verified = 1, email_verification_token = NULL WHERE id = ?", [results[0].id], (err) => {
            res.json({ success: true, message: "Email verified successfully! You can now log in." });
        });
    });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body; 
  db.query("SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1", [email, email], async (err, results) => {
    if (results.length === 0) return res.status(400).json({ success: false, message: "No user found with that email or name" });
    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      if (user.email_verified === 0) {
          const otp = Math.floor(100000 + Math.random() * 900000).toString();
          db.query("UPDATE users SET email_verification_token = ? WHERE id = ?", [otp, user.id], async (updateErr) => {
              if (!updateErr) {
                  fetch("https://api.brevo.com/v3/smtp/email", {
                      method: "POST", headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
                      body: JSON.stringify({ sender: { name: "Mommy Rosal Catering", email: process.env.EMAIL_USER }, to: [{ email: user.email }], subject: "Your Verification Code - Mommy Rosal Catering", htmlContent: `<div style="text-align: center; padding: 20px;"><h2>Welcome back to Mommy Rosal's!</h2><h1 style="color: #db2777;">${otp}</h1></div>`})
                  }).catch(e => console.error(e));
              }
          });
          return res.status(403).json({ success: false, message: "Please verify your email address before logging in." });
      }
      res.json({ success: true, message: "Login successful", user: { id: user.id, fullName: user.username, email: user.email, verified: Boolean(user.is_verified) } });
    } else {
      res.status(400).json({ success: false, message: "Invalid password" });
    }
  });
});

app.post('/google-login', (req, res) => {
    const { email, name, googleId } = req.body;
    db.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email], (err, results) => {
        if (results.length > 0) {
            const user = results[0];
            if (!user.google_id) db.query("UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?", [googleId, user.id]);
            res.json({ success: true, message: "Login successful", user: { id: user.id, fullName: user.username, email: user.email, verified: Boolean(user.is_verified) } });
        } else {
            db.query("INSERT INTO users (username, email, password, is_verified, email_verified, google_id) VALUES (?, ?, '', 0, 1, ?)", 
            [name, email, googleId], (err, result) => {
                res.json({ success: true, message: "Signup successful", user: { id: result.insertId, fullName: name, email, verified: false } });
            });
        }
    });
});

app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;
  db.query("SELECT * FROM admins WHERE username = ?", [username], (err, results) => {
    if (results.length === 0) return res.status(400).json({ success: false, message: "Admin not found" });
    const admin = results[0];
    if (password === admin.password) res.json({ success: true, message: "Login successful", admin: { id: admin.id, username: admin.username, role: admin.role || 'admin' } });
    else res.status(400).json({ success: false, message: "Invalid password" });
  });
});

app.post('/forgot-password', (req, res) => {
    const { email } = req.body;
    db.query("SELECT id FROM users WHERE email = ?", [email], (err, results) => {
        if (results.length === 0) return res.status(400).json({ success: false, message: "Email not found" });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        db.query("UPDATE users SET email_verification_token = ? WHERE email = ?", [otp, email], async (err) => {
            try {
                await fetch("https://api.brevo.com/v3/smtp/email", {
                    method: "POST", headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
                    body: JSON.stringify({ sender: { name: "Mommy Rosal Catering", email: process.env.EMAIL_USER }, to: [{ email: email }], subject: "Password Reset Code", htmlContent: `<div style="text-align: center; padding: 20px;"><h2>Password Reset</h2><h1 style="color: #db2777;">${otp}</h1></div>` })
                });
                res.json({ success: true, message: "A 6-digit code has been sent to your email." });
            } catch (error) { res.status(500).json({ success: false, message: "Failed to send reset email." }); }
        });
    });
});

app.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    db.query("SELECT id FROM users WHERE email = ? AND email_verification_token = ?", [email, otp], async (err, results) => {
        if (results.length === 0) return res.status(400).json({ success: false, message: "Invalid or expired 6-digit code." });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.query("UPDATE users SET password = ?, email_verification_token = NULL WHERE email = ?", [hashedPassword, email], (err) => {
            res.json({ success: true, message: "Password reset successful! You can now log in." });
        });
    });
});

// =====================================
// SYSTEM ROUTES
// =====================================
app.post('/verify', async (req, res) => {
  try {
    const { userId, idType, idNumber, lastName, firstName, address, phone, email, idImage } = req.body;
    const pDb = db.promise();
    const sql = `INSERT INTO verification_requests (user_id, id_type, id_number, last_name, first_name, address, phone, email, id_image_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending') ON DUPLICATE KEY UPDATE id_type = VALUES(id_type), id_number = VALUES(id_number), last_name = VALUES(last_name), first_name = VALUES(first_name), address = VALUES(address), phone = VALUES(phone), email = VALUES(email), id_image_path = VALUES(id_image_path), status = 'Pending'`;
    await pDb.query(sql, [userId, idType, idNumber, lastName, firstName, address, phone || '', email || '', idImage]);
    await logSystemActivity('User', `Verification request submitted by ${firstName} ${lastName}`);
    res.json({ success: true, message: "Verification request submitted successfully!" });
  } catch (error) { res.status(500).json({ success: false, message: "Database error processing verification." }); }
});

app.post('/contact-message', async (req, res) => {
    const { name, email, message } = req.body;
    try {
        await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST", headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
            body: JSON.stringify({
                sender: { name: "Website Contact Form", email: process.env.EMAIL_USER }, to: [{ email: process.env.EMAIL_USER }],
                replyTo: { email: email, name: name }, subject: `New Inquiry from ${name}`,
                htmlContent: `<div style="padding: 20px;"><h2>New Contact Message</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><blockquote>${message}</blockquote></div>`
            })
        });
        res.json({ success: true, message: "Your message has been sent successfully!" });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to send message." }); }
});

app.get('/fetch_notifications', (req, res) => {
  db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC", [req.query.userId], (err, results) => {
    res.json({ success: true, notifications: results });
  });
});

app.post('/mark_notifications_read', (req, res) => {
  db.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.body.userId], (err) => {
    res.json({ success: true });
  });
});

app.post('/notify_chat_message', (req, res) => {
  createNotification(req.body.userId, "You have a new unread message from our support team.");
  res.json({ success: true });
});

app.get('/fetch_booked_dates', (req, res) => {
  db.query("SELECT preferred_date, end_date FROM appointments WHERE status != 'Cancelled'", (err, results) => {
    let allBookedDates = new Set();
    results.forEach(row => {
        let curr = new Date(row.preferred_date);
        let end = row.end_date ? new Date(row.end_date) : new Date(row.preferred_date);
        curr.setHours(0,0,0,0); end.setHours(0,0,0,0);
        let bufferStart = new Date(curr); bufferStart.setDate(bufferStart.getDate() - 3);
        let bufferEnd = new Date(end); bufferEnd.setDate(bufferEnd.getDate() + 3);
        let pointer = new Date(bufferStart);
        while (pointer <= bufferEnd) {
            const y = pointer.getFullYear();
            const m = String(pointer.getMonth() + 1).padStart(2, '0');
            const d = String(pointer.getDate()).padStart(2, '0');
            allBookedDates.add(`${y}-${m}-${d}`);
            pointer.setDate(pointer.getDate() + 1);
        }
    });
    res.json({ success: true, bookedDates: Array.from(allBookedDates) });
  });
});

app.get('/fetch_user_appointments', (req, res) => {
  const sql = `SELECT a.*, p.description as inclusions FROM appointments a LEFT JOIN packages p ON a.package_type = p.package_name WHERE a.user_id = ? ORDER BY a.created_at DESC`;
  db.query(sql, [req.query.user_id], (err, results) => {
    res.json({ success: true, appointments: results });
  });
});

app.get('/fetch_user_payments', (req, res) => {
  const sql = `SELECT p.id, p.amount_paid, p.payment_type, p.transaction_date, p.remarks, a.event_type FROM payments p JOIN appointments a ON p.appointment_id = a.id WHERE a.user_id = ? ORDER BY p.transaction_date DESC`;
  db.query(sql, [req.query.user_id], (err, results) => {
    res.json({ success: true, payments: results });
  });
});

// =====================================
// PHASE 3 BOOK EVENT FLOW (DYNAMIC INVENTORY)
// =====================================
app.post('/book_event', async (req, res) => {
  const { userId, eventType, serviceType, packageType, preferredDate, eventTime, eventLocation, duration, guestCount, selectedDishes } = req.body;
  
  if (!userId || !eventType || !serviceType || !preferredDate || !eventTime || !eventLocation || !guestCount) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  let endDate = preferredDate;
  if (duration > 1) {
      const d = new Date(preferredDate);
      d.setDate(d.getDate() + (Number(duration) - 1));
      endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  let requiredInventory = [];

  // ONLY allocate food items if 'Food/Catering' is checked
  if (serviceType.includes('Food/Catering')) {
      requiredInventory.push(`Plate: ${guestCount}`);
      requiredInventory.push(`Utensils - Spoon: ${guestCount}`);
      requiredInventory.push(`Utensils - Fork: ${guestCount}`);
      requiredInventory.push(`Glass: ${guestCount}`);
  }

  // ONLY allocate tables/chairs if 'Tables & Chairs' is checked
  if (serviceType.includes('Tables & Chairs')) {
      requiredInventory.push(`Chairs: ${guestCount}`);
      requiredInventory.push(`Table (10 seater): ${Math.ceil(guestCount / 10)}`);
  }

  // ONLY allocate styling & lights if checked
  if (serviceType.includes('Event Styling')) {
      requiredInventory.push(`Table Napkin: ${guestCount}`);
  }
  
  if (serviceType.includes('Lights & Sound')) {
      requiredInventory.push('Lights (assorted): 1');
      requiredInventory.push('Sound System: 1');
  }

  const requiredInventoryStr = requiredInventory.join('; ');

  try {
    const pDb = db.promise();
    
    // Insert with totalCost = 0 for negotiation
    const sql = `INSERT INTO appointments (user_id, event_type, service_type, package_type, preferred_date, end_date, event_time, event_location, guest_count, selected_dishes, required_inventory, total_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Pending')`;
    const [result] = await pDb.query(sql, [userId, eventType, serviceType, packageType || 'Custom', preferredDate, endDate, eventTime, eventLocation, guestCount, selectedDishes || '', requiredInventoryStr]);
    
    createNotification(userId, `Your booking for ${eventType} starting on ${preferredDate} has been received and is pending review.`);
    res.json({ success: true, message: "Event booking successful.", booking_id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

// =====================================
// ADMIN & DASHBOARD ROUTES
// =====================================
app.get('/admin_fetch_dashboard_stats', async (req, res) => {
  try {
    const pDb = db.promise();
    const [[bookingsRow]] = await pDb.query("SELECT COUNT(*) as count FROM appointments WHERE status IN ('Pending', 'Confirmed')");
    const [[revenueRow]] = await pDb.query("SELECT SUM(amount_paid) as total FROM payments");
    const [[menuRow]] = await pDb.query("SELECT COUNT(*) as count FROM menu_items");
    const [[userRow]] = await pDb.query("SELECT COUNT(*) as count FROM users WHERE is_verified = 1");
    const [events] = await pDb.query("SELECT id, event_type, preferred_date, end_date, guest_count, status FROM appointments WHERE status IN ('Pending', 'Confirmed') ORDER BY preferred_date ASC");
    res.json({ success: true, stats: { bookings: bookingsRow?.count || 0, revenue: revenueRow?.total || 0, menuItems: menuRow?.count || 0, customers: userRow?.count || 0 }, upcomingEvents: events });
  } catch (err) { res.status(500).json({ success: false, message: "Database error fetching stats" }); }
});

app.get('/admin_fetch_bookings', (req, res) => {
  const sql = `
    SELECT 
        a.*, 
        u.username as customer_name, 
        u.email as customer_email, 
        COALESCE(SUM(p.amount_paid), 0) as amount_paid, 
        (a.total_cost - COALESCE(SUM(p.amount_paid), 0)) as balance,
        pk.dish_limit
    FROM appointments a 
    LEFT JOIN users u ON a.user_id = u.id 
    LEFT JOIN payments p ON a.id = p.appointment_id 
    LEFT JOIN packages pk ON a.package_type = pk.package_name
    GROUP BY a.id, u.username, u.email, pk.dish_limit 
    ORDER BY a.created_at DESC
  `;
  db.query(sql, (err, results) => {
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
  const { bookingId, status, agreedPrice } = req.body;
  try {
    const pDb = db.promise();
    const [rows] = await pDb.query(`SELECT a.user_id, a.package_type, a.required_inventory, a.status, a.event_type, a.preferred_date, a.total_cost, u.username FROM appointments a LEFT JOIN users u ON a.user_id = u.id WHERE a.id = ?`, [bookingId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Booking not found" });
    const booking = rows[0];
    
    if (status === 'Confirmed' && booking.status !== 'Confirmed') {
        
      // ==========================================
      // PROFESSIONAL RULE: ONLY 1 ACTIVE BOOKING
      // ==========================================
      const [activeBookings] = await pDb.query("SELECT id FROM appointments WHERE status = 'Confirmed'");
      if (activeBookings.length > 0) {
          return res.status(400).json({ 
              success: false, 
              message: "Approval Denied. There is already a 'Confirmed' event in progress. You must complete the current event before approving a new one to prevent double-booking." 
          });
      }

      // If clear, proceed with inventory deduction
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

      let finalPrice = agreedPrice !== undefined ? agreedPrice : booking.total_cost;
      await pDb.query("UPDATE appointments SET status = ?, total_cost = ? WHERE id = ?", [status, finalPrice, bookingId]);
    } else {
      await pDb.query("UPDATE appointments SET status = ? WHERE id = ?", [status, bookingId]);
    }

    await createNotification(booking.user_id, `Your ${booking.event_type} event booking status is now: ${status}.`);
    await logSystemActivity('Booking', `Updated booking #${bookingId} to ${status}`);
    res.json({ success: true, message: `Booking #${bookingId} status successfully updated to ${status}.` });
  } catch (err) { 
      res.status(500).json({ success: false, message: "Error updating status." }); 
  }
});

app.post('/admin_update_booking_details', async (req, res) => {
  const { id, event_type, event_time, event_location, guest_count, service_type, selected_dishes } = req.body;
  
  try {
    const pDb = db.promise();

    // 1. Fetch the user_id associated with this booking before updating
    const [rows] = await pDb.query("SELECT user_id, event_type FROM appointments WHERE id = ?", [id]);
    const userId = rows.length > 0 ? rows[0].user_id : null;

    // 2. Update the booking details in the database
    await pDb.query(
      "UPDATE appointments SET event_type=?, event_time=?, event_location=?, guest_count=?, service_type=?, selected_dishes=? WHERE id=?",
      [event_type, event_time, event_location, guest_count, service_type, selected_dishes, id]
    );

    // 3. Log the activity for the Admin
    await logSystemActivity('Booking', `Admin modified booking details for ID #${id}`);

    // 4. INITIATE CLOSED-LOOP COMMUNICATION: Notify the specific customer
    if (userId) {
        await createNotification(
            userId, 
            `ADMIN UPDATE: The details for your ${event_type} event (Time, Guest Count, or Menu) have been modified by the administrator. Please review your profile for the finalized details.`
        );
    }

    res.json({ success: true, message: "Booking details updated and customer notified!" });
  } catch (err) { 
    res.status(500).json({ success: false, message: "Failed to update booking details." }); 
  }
});

app.post('/admin_reconcile_booking', async (req, res) => {
  const { bookingId, damagedItems = {} } = req.body; 
  try {
    const pDb = db.promise();
    const [rows] = await pDb.query("SELECT user_id, required_inventory, status FROM appointments WHERE id = ?", [bookingId]);
    const booking = rows[0];
    if (booking.status === 'Completed') return res.status(400).json({ success: false, message: "This booking has already been reconciled." });
    
    if (booking.required_inventory) {
      const items = booking.required_inventory.split('; ');
      for (let itemStr of items) {
        if (!itemStr || !itemStr.includes(':')) continue; 
        const [itemName, allocatedQtyStr] = itemStr.split(': ');
        const returnQty = (parseInt(allocatedQtyStr, 10) || 0) - (parseInt(damagedItems[itemName], 10) || 0);
        
        if (returnQty > 0 && itemName) {
          const cleanItemName = itemName.trim();
          await pDb.query("UPDATE inventory SET quantity = quantity + ? WHERE name = ?", [returnQty, cleanItemName]);
          await pDb.query("INSERT INTO inventory_logs (item_name, quantity_change, action_type, remarks) VALUES (?, ?, ?, ?)", [cleanItemName, returnQty, 'Reconciliation Return', `Returned from Booking #${bookingId}`]);
        }
      }
    }
    
    await pDb.query("UPDATE appointments SET status = 'Completed' WHERE id = ?", [bookingId]);
    await createNotification(booking.user_id, `Your booking #${bookingId} has been successfully completed. Thank you!`);
    await logSystemActivity('Booking', `Reconciled and Completed Booking #${bookingId}`);
    res.json({ success: true, message: "Event completed and inventory successfully reconciled!" });
  } catch (err) { res.status(500).json({ success: false, message: "Server error" }); }
});

app.post('/admin_delete_booking', async (req, res) => {
  const id = req.body.id || req.body.bookingId || req.params.id;
  try {
    const pDb = db.promise();
    await pDb.query('DELETE FROM appointments WHERE id = ?', [id]);
    await logSystemActivity('Booking', `Deleted booking ID ${id}`);
    res.json({ success: true, message: 'Booking deleted' });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/admin_fetch_inventory', (req, res) => { db.query("SELECT * FROM inventory", (err, r) => { res.json({ success: true, inventory: r }); }); });
app.get('/admin_fetch_inventory_logs', (req, res) => { db.query("SELECT * FROM inventory_logs ORDER BY created_at DESC", (err, results) => { res.json({ success: true, logs: results }); }); });
app.post('/admin_add_inventory', (req, res) => {
    db.query("INSERT INTO inventory (name, quantity, unit) VALUES (?, ?, ?)", [req.body.name, req.body.quantity, req.body.unit], async (err) => {
        await logSystemActivity('Inventory', `Added new inventory item: ${req.body.name}`);
        res.json({ success: true });
    });
});
app.post('/admin_update_inventory', (req, res) => {
    db.query("UPDATE inventory SET name=?, quantity=?, unit=? WHERE id=?", [req.body.name, req.body.quantity, req.body.unit, req.body.id], async (err) => {
        await logSystemActivity('Inventory', `Updated inventory item: ${req.body.name}`);
        res.json({ success: true });
    });
});
app.post('/admin_delete_inventory', async (req, res) => {
    db.query('DELETE FROM inventory WHERE id = ?', [req.body.id || req.params.id], () => res.json({ success: true, message: 'Inventory item deleted' }));
});
app.post('/admin_delete_inventory_logs', async (req, res) => {
    db.query('DELETE FROM inventory_logs WHERE id IN (?)', [req.body.logIds], () => res.json({ success: true, message: 'Logs deleted successfully' }));
});

app.get('/admin_fetch_menu', (req, res) => { db.query("SELECT * FROM menu_items", (err, r) => { res.json({ success: true, items: r }); }); });
app.post('/admin_add_menu', (req, res) => {
    db.query("INSERT INTO menu_items (name, category, price, description, image_url) VALUES (?, ?, ?, ?, ?)", [req.body.name, req.body.category, req.body.price, req.body.description, req.body.image_url], () => res.json({ success: true }));
});
app.post('/admin_update_menu', (req, res) => {
    db.query("UPDATE menu_items SET name=?, category=?, price=?, description=?, image_url=? WHERE id=?", [req.body.name, req.body.category, req.body.price, req.body.description, req.body.image_url, req.body.id], () => res.json({ success: true }));
});
app.post('/admin_delete_menu', async (req, res) => {
    db.query('DELETE FROM menu_items WHERE id = ?', [req.body.id || req.params.id], () => res.json({ success: true, message: 'Menu item deleted' }));
});

app.get('/admin_fetch_staff', (req, res) => { db.query("SELECT * FROM staff", (err, r) => { res.json({ success: true, staff: r }); }); });
app.post('/admin_add_staff', (req, res) => { db.query("INSERT INTO staff (name, role, email, phone) VALUES (?, ?, ?, ?)", [req.body.name, req.body.role, req.body.email, req.body.phone], () => { res.json({ success: true }); }); });
app.post('/admin_update_staff', (req, res) => { db.query("UPDATE staff SET name=?, role=?, email=?, phone=? WHERE id=?", [req.body.name, req.body.role, req.body.email, req.body.phone, req.body.id], () => { res.json({ success: true }); }); });
app.post('/admin_delete_staff', async (req, res) => { db.query("DELETE FROM staff WHERE id = ?", [req.body.id || req.params.id], () => res.json({ success: true })); });

app.get('/admin_fetch_all_payments', (req, res) => { db.query(`SELECT p.*, a.event_type, u.username as customer_name FROM payments p LEFT JOIN appointments a ON p.appointment_id = a.id LEFT JOIN users u ON a.user_id = u.id ORDER BY p.transaction_date DESC`, (err, results) => { res.json({ success: true, payments: results }); }); });
app.get('/admin_fetch_payment_history', (req, res) => { db.query("SELECT * FROM payments WHERE appointment_id = ? ORDER BY transaction_date DESC", [req.query.appointmentId], (err, r) => { res.json({ success: true, history: r }); }); });
app.post('/admin_process_payment', async (req, res) => {
  db.query("INSERT INTO payments (appointment_id, amount_paid, payment_type, remarks, transaction_date, receipt_url) VALUES (?, ?, ?, ?, NOW(), ?)", [req.body.appointmentId, req.body.amount, req.body.paymentType || 'Cash', req.body.remarks || '', req.body.receiptImage], () => res.json({ success: true, message: "Payment recorded successfully" }));
});

app.get('/admin_fetch_users', (req, res) => { db.query("SELECT id, username, email, is_verified, created_at FROM users ORDER BY created_at DESC", (err, results) => { res.json({ success: true, users: results }); }); });
app.get('/admin_fetch_activity_logs', (req, res) => {
  const sql = `SELECT 'Booking' as type, created_at as date, CONCAT('New booking created for ', event_type) as description FROM appointments UNION ALL SELECT 'Payment' as type, transaction_date as date, CONCAT('Payment of ₱', amount_paid, ' received via ', payment_type) as description FROM payments UNION ALL SELECT 'User' as type, created_at as date, CONCAT('New user registered: ', username) as description FROM users UNION ALL SELECT type, date, description FROM activity_logs ORDER BY date DESC LIMIT 50`;
  db.query(sql, (err, results) => { res.json({ success: true, logs: results }); });
});

app.get('/admin_fetch_reports', async (req, res) => {
  try {
    const pDb = db.promise();
    
    // 1. Financial Data (Payments)
    const [[rev]] = await pDb.query("SELECT COALESCE(SUM(amount_paid), 0) as total_rev FROM payments");
    const [recentPayments] = await pDb.query(`
        SELECT p.amount_paid, p.payment_type, p.transaction_date, u.username as client_name 
        FROM payments p 
        LEFT JOIN appointments a ON p.appointment_id = a.id 
        LEFT JOIN users u ON a.user_id = u.id 
        ORDER BY p.transaction_date DESC LIMIT 5
    `);

    // 2. Booking Data
    const [[bookings]] = await pDb.query(`
        SELECT 
            COUNT(*) as total_events, 
            COALESCE(SUM(guest_count), 0) as total_guests_served, 
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_events, 
            SUM(CASE WHEN status = 'Confirmed' THEN 1 ELSE 0 END) as upcoming_events, 
            SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_events,
            SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) as cancelled_events 
        FROM appointments
    `);
    const [eventsByType] = await pDb.query(`
        SELECT event_type, COUNT(*) as count, COALESCE(SUM(guest_count), 0) as total_guests 
        FROM appointments GROUP BY event_type ORDER BY count DESC
    `);
    const [recentCateringOrders] = await pDb.query(`
        SELECT a.id, a.event_type, a.preferred_date, a.end_date, a.guest_count, a.status, a.total_cost, u.username as client_name 
        FROM appointments a LEFT JOIN users u ON a.user_id = u.id 
        ORDER BY a.created_at DESC LIMIT 5
    `);

    // 3. Inventory Data
    const [inventoryAlerts] = await pDb.query(`SELECT name, quantity, unit FROM inventory WHERE quantity <= 20 ORDER BY quantity ASC`);
    const [[inventoryStats]] = await pDb.query(`SELECT COUNT(*) as total_item_types, COALESCE(SUM(quantity), 0) as total_physical_stock FROM inventory`);

    res.json({ 
        success: true, 
        summary: { 
            revenue: rev.total_rev || 0, 
            total_events: bookings.total_events || 0, 
            total_guests_served: bookings.total_guests_served || 0, 
            completed_events: bookings.completed_events || 0, 
            upcoming_events: bookings.upcoming_events || 0, 
            pending_events: bookings.pending_events || 0,
            cancelled_events: bookings.cancelled_events || 0,
            total_inventory_types: inventoryStats.total_item_types || 0,
            total_physical_stock: inventoryStats.total_physical_stock || 0
        }, 
        eventsByType, 
        inventoryAlerts, 
        recentCateringOrders,
        recentPayments
    });
  } catch (e) { 
      res.status(500).json({ success: false, message: "Error generating reports: " + e.message }); 
  }
});
app.get('/fetch_packages', (req, res) => { db.query("SELECT * FROM packages", (err, results) => { res.json({ success: true, packages: results }); }); });
app.post('/admin_add_package', (req, res) => { db.query("INSERT INTO packages (package_name, description, price, pax_capacity, dish_limit, physical_assets) VALUES (?, ?, ?, ?, ?, ?)", [req.body.package_name, req.body.description, req.body.price, req.body.pax_capacity, req.body.dish_limit, req.body.physical_assets], () => res.json({ success: true, message: "Package added successfully" })); });
app.post('/admin_update_package', (req, res) => { db.query("UPDATE packages SET package_name=?, description=?, price=?, pax_capacity=?, dish_limit=?, physical_assets=? WHERE id=?", [req.body.package_name, req.body.description, req.body.price, req.body.pax_capacity, req.body.dish_limit, req.body.physical_assets, req.body.id], () => res.json({ success: true, message: "Package updated successfully" })); });
app.post('/admin_delete_package', (req, res) => { db.query("DELETE FROM packages WHERE id=?", [req.body.id], () => res.json({ success: true, message: "Package deleted successfully" })); });

app.get('/admin_fetch_verification', (req, res) => { db.query("SELECT * FROM verification_requests WHERE status = 'Pending'", (err, r) => { res.json({ success: true, requests: r }); }); });
app.post('/admin_verify_user', (req, res) => {
  const { requestId, status } = req.body;
  db.query("UPDATE verification_requests SET status = ? WHERE id = ?", [status, requestId], (err) => {
    if (status === 'Verified') db.query("UPDATE users SET is_verified = 1 WHERE id = (SELECT user_id FROM verification_requests WHERE id = ?)", [requestId]);
    res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
