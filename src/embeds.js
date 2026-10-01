/**
 * Professional embed styling + theme + greeting-template helpers.
 * All embeds go through here so colors stay consistent.
 */
const { EmbedBuilder } = require('discord.js');
const { getDb } = require('./db');

const FOOTER = '🌸 Summer Baddies';
const DIV = '─────────────────────';
const FALLBACK_COLOR = 0xff5da2;

function parseHexColor(input, fallback = FALLBACK_COLOR) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input || '').trim();
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return fallback;
  return parseInt(m[1], 16);
}

function themeColorHex() {
  const db = getDb();
  const raw = db.settings && db.settings.themeColor;
  if (typeof raw === 'string' && /^#?[0-9a-fA-F]{6}$/.test(raw.trim())) {
    return raw.trim().startsWith('#') ? raw.trim() : '#' + raw.trim();
  }
  return '#FF5DA2';
}

function themeColorInt() {
  return parseHexColor(themeColorHex(), FALLBACK_COLOR);
}

/** Base embed every command should use. */
function embedBase(title, desc, color) {
  return new EmbedBuilder()
    .setTitle(title || '')
    .setDescription(desc || '')
    .setColor(color ?? themeColorInt())
    .setTimestamp()
    .setFooter({ text: FOOTER });
}

function okEmbed(title, desc) {
  return embedBase(`✅ ${title}`, desc, 0x57f287);
}

function errEmbed(desc) {
  return embedBase('❌ Something went wrong', desc, 0xed4245);
}

/**
 * Fill greeting variables:
 * {user} {username} {mention} {server} {membercount}
 */
function formatTemplate(template, member) {
  const guild = member.guild;
  const user = member.user;
  const map = {
    '{user}': user.username,
    '{username}': user.username,
    '{mention}': `<@${user.id}>`,
    '{server}': guild.name,
    '{membercount}': String(guild.memberCount),
  };
  let out = String(template || '');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  // also support uppercase variants
  out = out.replace(/\{USER\}/g, map['{user}'])
    .replace(/\{SERVER\}/g, map['{server}'])
    .replace(/\{MEMBERCOUNT\}/g, map['{membercount}'])
    .replace(/\{MENTION\}/g, map['{mention}']);
  return out;
}

function welcomeEmbed(member) {
  const db = getDb();
  const text = formatTemplate(db.settings.welcomeMessage, member);
  return embedBase(`🌸 Welcome, ${member.user.username}!`, `${text}\n${DIV}\n🔗 Link Roblox: \`/link <RobloxUsername>\` → type \`!verify CODE\` in Summer Baddies\n📜 Read \`/rules\` • 💎 Try \`/value\``)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${FOOTER} • Member #${member.guild.memberCount}` });
}

function leaveEmbed(member) {
  const db = getDb();
  const username = member.user?.username || 'Someone';
  const text = formatTemplate(db.settings.leaveMessage, member);
  return embedBase(`👋 ${username} left`, `${text} 💔`, 0x808080);
}

module.exports = {
  FOOTER,
  DIV,
  FALLBACK_COLOR,
  parseHexColor,
  themeColorHex,
  themeColorInt,
  embedBase,
  okEmbed,
  errEmbed,
  formatTemplate,
  welcomeEmbed,
  leaveEmbed,
};
