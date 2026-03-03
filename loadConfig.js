const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Load subject.env and generate spec and opts objects for Glooko source
 * @param {string} [envPath] - Path to subject.env file (defaults to repo root)
 * @returns {{spec: object, opts: object}}
 */
function loadGlookoConfig(envPath = path.resolve(process.cwd(), 'subject.env')) {
  // Read and parse .env file
  const envFile = fs.readFileSync(envPath, 'utf8');
  const env = dotenv.parse(envFile);

  // Build spec object (server/environment configuration)
  const spec = {
    glookoEnv: env.CONNECT_GLOOKO_ENV || 'default',
    // Optionally set glookoServer if needed; otherwise it derives from glookoEnv
  };

  // Build opts object (user credentials & configuration)
  const opts = {
    glookoEnv: env.CONNECT_GLOOKO_ENV || 'default',
    glookoEmail: env.CONNECT_GLOOKO_EMAIL,
    glookoPassword: env.CONNECT_GLOOKO_PASSWORD,
    glookoTimezoneOffset: env.CONNECT_GLOOKO_TIMEZONE_OFFSET
      ? Number(env.CONNECT_GLOOKO_TIMEZONE_OFFSET)
      : 0,
  };

  return { spec, opts };
}

module.exports = { loadGlookoConfig };
