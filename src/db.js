/**
 * JSON database — single file (data.json), atomic writes, deep-merged defaults.
 * Preserves unknown keys from older bot versions (economy, tickets, etc.)
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

const DEFAULT_SETTINGS = {
  welcomeChannel: '',
  leaveChannel: '',
  reportsChannel: '',
  linkLogChannel: '',
  verifiedRoleId: '',
  // Custom greeting templates. Supported variables:
  // {user} {username} {mention} {server} {membercount}
  welcomeMessage: 'Welcome {mention} to **{server}**! You are member **#{membercount}**. Link with /link to get Verified.',
  leaveMessage: '**{user}** left {server}. We now have **{membercount}** members.',
  // Global embed theme (hex string like "#FF5DA2")
  themeColor: '#FF5DA2',
  // Per-command text prefixes: { "game-ban": "!", "game-kick": "?" }
  // Trigger via message: "<prefix><command> args..." e.g. "!game-ban user reason"
  commandPrefixes: {},
  // Raid protection: block links + spam (3+ messages fast / 3 identical)
  raidProtect: { enabled: false, blockLinks: true, spamLimit: 3, spamWindowSec: 10, timeoutMin: 10 },
};

const DEFAULTS = {
  links: {},
  robloxToDiscord: {},
  linkCodes: {},
  settings: { ...DEFAULT_SETTINGS },
  commands: [],
  playerCache: {},
  bans: {},
  valuesCache: { at: 0, byKey: {} },
  inventories: {},
  servers: {},
  levels: {},
  iconCache: {},
};

let db = JSON.parse(JSON.stringify(DEFAULTS));

function mergeSettings(raw) {
  const base = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  base.commandPrefixes = { ...((raw && raw.commandPrefixes) || {}) };
  base.raidProtect = { ...DEFAULT_SETTINGS.raidProtect, ...((raw && raw.raidProtect) || {}) };
  // clamp to sane ranges so a bad edit can't break the bot
  base.raidProtect.spamLimit = Math.min(Math.max(Number(base.raidProtect.spamLimit) || 3, 2), 10);
  base.raidProtect.spamWindowSec = Math.min(Math.max(Number(base.raidProtect.spamWindowSec) || 10, 5), 60);
  base.raidProtect.timeoutMin = Math.min(Math.max(Number(base.raidProtect.timeoutMin) || 10, 1), 60);
  base.raidProtect.enabled = !!base.raidProtect.enabled;
  base.raidProtect.blockLinks = base.raidProtect.blockLinks !== false;
  return base;
}

try {
  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...raw };
    db.settings = mergeSettings(raw.settings);
    if (!Array.isArray(db.commands)) db.commands = [];
    db.valuesCache = raw.valuesCache || { at: 0, byKey: {} };
    db.levels = raw.levels || {};
    db.iconCache = raw.iconCache || {};
  }
} catch (e) {
  console.error('[db] load failed, using fresh:', e.message);
}

let saveTimer = null;
function save() {
  try {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}
/** Debounced save for hot paths (player-data pushes). */
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 2000);
}

function getDb() {
  return db;
}

module.exports = { DB_PATH, DEFAULT_SETTINGS, getDb, save, saveSoon };
