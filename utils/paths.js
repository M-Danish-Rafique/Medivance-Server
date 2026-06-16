const path = require('path');
const fs = require('fs');

/** Public assets: prefer server/public (Railway), fall back to client/public (local monorepo). */
function getPublicDir() {
  const serverPublic = path.resolve(__dirname, '../public');
  const clientPublic = path.resolve(__dirname, '../../client/public');
  if (fs.existsSync(serverPublic)) return serverPublic;
  if (fs.existsSync(clientPublic)) return clientPublic;
  return serverPublic;
}

module.exports = { getPublicDir };
