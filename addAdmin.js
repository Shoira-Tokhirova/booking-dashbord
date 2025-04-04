require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// 👤 Customize admin credentials here
const email = 'admin@example.com';
const plainPassword = 'mypassword123';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // ❗ If using local PostgreSQL
});

async function createAdmin() {
  try {
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const result = await pool.query(
      'INSERT INTO admins (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );
    console.log('✅ Admin created:', result.rows[0]);
  } catch (err) {
    console.error('❌ Error inserting admin:', err);
  } finally {
    await pool.end();
  }
}

createAdmin();