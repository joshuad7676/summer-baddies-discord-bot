function normalizeEnv(key, opts = {}) {
  const raw = process.env[key];
  if (raw == null) return '';
  let value = String(raw).trim();
  if (opts.stripKeyPrefix) {
    value = value.replace(new RegExp(`^${key}=`, 'i'), '').trim();
  }
  return value;
}

function maskToken(token) {
  if (!token) return 'MISSING';
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const TOKEN = normalizeEnv('DISCORD_TOKEN');
const CLIENT_ID = normalizeEnv('CLIENT_ID', { stripKeyPrefix: true });
const GUILD_ID = normalizeEnv('GUILD_ID', { stripKeyPrefix: true });
const API_KEY = normalizeEnv('BOT_API_KEY', { stripKeyPrefix: true }) || 'change_me';
const PORT = normalizeEnv('PORT', { stripKeyPrefix: true }) || '3000';

console.log('[env] TOKEN:', maskToken(TOKEN));
console.log('[env] CLIENT_ID:', CLIENT_ID || 'MISSING');
console.log('[env] GUILD_ID:', GUILD_ID || 'MISSING');
console.log('[env] PORT:', PORT);

if (GUILD_ID.includes('=')) {
  console.warn('[env] GUILD_ID still contains an equals sign after trim; stripping it now.');
}

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env');
  process.exit(1);
}

if (!/^\d{17,20}$/.test(String(GUILD_ID))) {
  console.warn(`[env] GUILD_ID looks invalid: "${GUILD_ID}". It must be a Discord snowflake (usually 17-20 digits).`);
}

if (!/^\d{17,20}$/.test(String(CLIENT_ID))) {
  console.warn(`[env] CLIENT_ID looks invalid: "${CLIENT_ID}". It must be a Discord snowflake (usually 17-20 digits).`);
}

// ---------- tiny JSON db (deep-merged so new fields survive restarts) ----------
