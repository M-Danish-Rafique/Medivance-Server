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

const pool = mysql.createPool({
  ...poolConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

module.exports = pool;
