/**
 * Allowed browser origins for CORS (comma-separated CLIENT_URL env var).
 * Example: https://your-app.vercel.app,http://localhost:3000
 */
function getAllowedOrigins() {
  const raw = process.env.CLIENT_URL || 'http://localhost:3000';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function corsOptions() {
  const allowedOrigins = getAllowedOrigins();

  return {
    origin(origin, callback) {
      // Allow non-browser clients (Postman, server-to-server, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, origin);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  };
}

module.exports = { getAllowedOrigins, corsOptions };
