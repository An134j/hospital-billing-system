const mysql = require('mysql2/promise');
require('dotenv').config();

// MySQL connection pool banao
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ MySQL Database connected successfully!');
    connection.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
  }
}

testConnection();

module.exports = pool;