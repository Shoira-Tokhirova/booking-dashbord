console.log("✅ Server file loaded");

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.admin = decoded; // Store admin info in request
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }
}
// SYNC ICAL ROUTE
app.get('/api/sync-calendars', async (req, res) => {
  try {
    const apartmentsResult = await pool.query('SELECT * FROM apartments');
    const apartments = apartmentsResult.rows;

    let newImports = 0;

    for (const apt of apartments) {
      const urls = [
        { url: apt.airbnb_ical_url, source: 'Airbnb' },
        { url: apt.booking_ical_url, source: 'Booking.com' }
      ];

      for (const { url, source } of urls) {
        if (!url) continue;

        try {
          const response = await axios.get(url);
          const data = ical.parseICS(response.data);

          for (const k in data) {
            const event = data[k];
            if (!event.start || !event.end) continue;

            const checkin = new Date(event.start);
            const checkout = new Date(event.end);

            const guest = event.summary || 'Guest';
            const external_id = event.uid;

            // Prevent duplicate entries
            const exists = await pool.query(
              'SELECT * FROM bookings WHERE external_id = $1',
              [external_id]
            );

            if (exists.rowCount > 0) continue;

            // Insert into bookings
            await pool.query(
              `INSERT INTO bookings (apartment, checkin, checkout, guest, price, source, external_id, synced_from_ical)
               VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
              [apt.name, checkin, checkout, guest, 0, source, external_id]
            );

            newImports++;
          }

        } catch (err) {
          console.error(`❌ Failed to sync from ${source} for ${apt.name}:`, err.message);
        }
      }
    }

    res.json({ message: `✅ Sync complete. ${newImports} new bookings added.` });

  } catch (err) {
    console.error("❌ Error syncing calendars:", err);
    res.status(500).json({ error: 'Failed to sync calendars' });
  }
});
// === Middleware ===
app.use(cors());
app.use(express.json());

const path = require('path');

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'booking_dashbord_frontend')));



// === PostgreSQL connection ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // Set to true if using Supabase or production SSL
});

pool.connect()
  .then(() => console.log("✅ Connected to local PostgreSQL"))
  .catch(err => console.error("❌ Connection error:", err));

// === JWT secret ===
const SECRET_KEY = process.env.JWT_SECRET || 'my-secret';

// ============================
// 🔐 ADMIN ROUTES
// ============================

// Create Admin (one-time use)
app.post('/api/admins', async (req, res) => {
  const { email, password } = req.body;

  console.log("📨 Attempting to create admin:", email);

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO admins (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );

    console.log("✅ Admin created:", result.rows[0]);

    res.status(201).json({ message: 'Admin registered!', admin: result.rows[0] });

  } catch (err) {
    console.error("❌ Error registering admin:", err);  // <-- log the actual error
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// Admin login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '1h' });
    res.json({ token, name: user.email }); // You can change 'name' to 'user.name' if you store names
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================
// 📅 BOOKING ROUTES
// ============================

// Get all bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY checkin ASC');
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching bookings:", err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Add a new booking
app.post('/api/bookings', async (req, res) => {
  const { apartment, checkin, checkout, guest, price } = req.body;

  try {
    // Check for overlapping bookings
    const overlapCheck = await pool.query(
      `SELECT * FROM bookings 
       WHERE apartment = $1 
       AND NOT (checkout <= $2 OR checkin >= $3)`,
      [apartment, checkin, checkout]
    );

    if (overlapCheck.rowCount > 0) {
      return res.status(409).json({ error: '❌ Dates overlap with existing booking.' });
    }

    // Proceed to insert
    const result = await pool.query(
      'INSERT INTO bookings (apartment, checkin, checkout, guest, price) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [apartment, checkin, checkout, guest, price]
    );

    res.status(201).json({ message: '✅ Booking added', booking: result.rows[0] });

  } catch (err) {
    console.error("❌ Error adding booking:", err);
    res.status(500).json({ error: 'Failed to add booking' });
  }
});


// Delete a booking
app.delete('/api/bookings/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount > 0) {
      res.json({ message: 'Booking deleted' });
    } else {
      res.status(404).json({ message: 'Booking not found' });
    }
  } catch (err) {
    console.error("❌ Error deleting booking:", err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// ============================
// 🏘️ APARTMENTS
// ============================
app.get('/api/apartments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM apartments ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching apartments:", err);
    res.status(500).json({ error: 'Failed to fetch apartments' });
  }
});

// ============================
// 📊 REPORTS
// ============================
app.get('/api/reports', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const aptsResult = await pool.query('SELECT * FROM apartments');
    const bookingsResult = await pool.query('SELECT * FROM bookings');

    const apartments = aptsResult.rows;
    const bookings = bookingsResult.rows;

    const apartmentIncome = {};
    apartments.forEach(apt => {
      apartmentIncome[apt.name] = {};
      for (let m = 1; m <= 12; m++) {
        apartmentIncome[apt.name][String(m).padStart(2, '0')] = 0;
      }
    });

    bookings.forEach(b => {
      const date = new Date(b.checkin);
      if (date.getFullYear() === year) {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        if (apartmentIncome[b.apartment]) {
          apartmentIncome[b.apartment][month] += parseFloat(b.price || 0);
        }
      }
    });

    res.json(apartmentIncome);
  } catch (err) {
    console.error("❌ Error generating report:", err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});
const ical = require('ical');
const axios = require('axios');


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'booking_dashbord_frontend', 'booking_dashbord.html'));
});
// ============================
// 🟢 Start Server
// ============================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
