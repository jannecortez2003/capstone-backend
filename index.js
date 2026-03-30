require('dotenv').config(); // Loads your .env variables
const express = require('express');
const mysql = require('mysql'); // Use 'mysql2' if you installed that instead
const cors = require('cors');   // Needed so your React app can fetch data

const app = express();

// Render assigns a dynamic port, so we use process.env.PORT. 
// If it's running locally, it will default to 5000.
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); 
app.use(express.json());

// Database Connection using your Railway credentials
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

// Connect to the database
db.connect((err) => {
  if (err) {
    console.error('Error connecting to the database:', err.stack);
    return;
  }
  console.log('Successfully connected to the Railway MySQL database!');
});

// Test Route
app.get('/', (req, res) => {
  res.send('Backend is running and connected to the database!');
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});