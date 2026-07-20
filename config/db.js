const mysql = require('mysql2/promise');
require('dotenv').config();

function parseDatabaseUrl(urlString) {
  const url = new URL(urlString);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

function getPoolConfig() {
  const connectionUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (connectionUrl) {
    return parseDatabaseUrl(connectionUrl);
  }

  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'medivance',
  };
}

const poolConfig = getPoolConfig();

// PKT = UTC+5 year-round (Asia/Karachi has no DST).
// mysql2 `timezone` only affects JS Date conversion — CURDATE()/NOW() use the
// MySQL session time_zone, so we set that on every pooled connection.
const PKT_OFFSET = '+05:00';

const pool = mysql.createPool({
  ...poolConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: PKT_OFFSET,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('connection', (connection) => {
  connection.query(`SET time_zone = '${PKT_OFFSET}'`);
});

module.exports = pool;
