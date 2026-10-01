/**
 * Raid protection: block links + spam (3+ fast messages / 3 identical).
 * Toggle with /raid-protect. State in settings.raidProtect, memory tracker here.
 */
const { PermissionFlagsBits } = require('discord.js');
const { getDb } = require('./db');
const { embedBase } = require('./embeds');
const { isStaffHigherThanBot } = require('./bridge');

const LINK_RE = /(https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/|\b\w+\.(gg|xyz|cfd|tk|ml|ga|ly)\b)/i;

// userKey -> [{ text, at }]
const history = new Map();
function keyOf(guildId, userId) { return `${guildId}:${userId}`; }

function prune(list, windowMs) {
  const cutoff = Date.now() - Math.max(windowMs, 30000); // keep 30s for identical-spam check
  return list.filter((e) => e.at > cutoff);
}

function isExempt(message, member) {
  // Staff (role above bot) + anyone with Manage Messages bypass filters
  if (member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return false;
}

async function staffExempt(message) {
  try {
    if (await isStaffHigherThanBot(message.member)) return true;
  } catch {}
  return false;
}

/**
 * Returns true if the message was deleted/handled (caller should stop processing).
 */
async function checkRaid(message) {
  const cfg = getDb().settings.raidProtect;
  if (!cfg?.enabled) return false;
  if (!message.guild || message.author.bot) return false;
  if (isExempt(message, message.member)) return false;
  if (await staffExempt(message)) return false;

  const content = message.content || '';

  // 1) link blocking
  if (cfg.blockLinks && LINK_RE.test(content)) {
    try {
      if (message.deletable) await message.delete().catch(() => {});
      const { sendModLog } = require('./modlog');
      await sendModLog(message.guild, embedBase('🔗 Link blocked', `${message.author.tag} (<@${message.author.id}>) in <#${message.channel.id}>\n> ${content.slice(0, 300)}`, 0xf97316));
      const warn = await message.channel.send(`${message.author}, links are blocked while raid protection is on.`).catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
    } catch {}
    return true;
  }

  // 2) spam: 3+ messages in window OR 3 identical in 30s
  const k = keyOf(message.guild.id, message.author.id);
  const list = prune(history.get(k) || [], cfg.spamWindowSec * 1000);
  list.push({ text: content.toLowerCase().trim().slice(0, 200), at: Date.now() });
  history.set(k, list);

  const windowStart = Date.now() - cfg.spamWindowSec * 1000;
  const inWindow = list.filter((e) => e.at > windowStart);
  const sameAsCurrent = list.filter((e) => e.text && e.text === content.toLowerCase().trim().slice(0, 200));

  const spammy = inWindow.length >= cfg.spamLimit || sameAsCurrent.length >= cfg.spamLimit;
  if (!spammy) return false;

  try {
    if (message.deletable) await message.delete().catch(() => {});
    // timeout repeat spammers
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const me = await message.guild.members.fetchMe().catch(() => null);
    if (member?.moderatable && me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await member.timeout(cfg.timeoutMin * 60000, `Raid protect: spam (${inWindow.length} msgs in ${cfg.spamWindowSec}s)`).catch(() => {});
    }
    const emb = embedBase('🛡️ Raid protect', `${message.author} was stopped for spamming (${inWindow.length} messages in ${cfg.spamWindowSec}s).${member ? `\nTimed out for **${cfg.timeoutMin}m**.` : ''}`, 0xed4245);
    const note = await message.channel.send({ embeds: [emb] }).catch(() => null);
    if (note) setTimeout(() => note.delete().catch(() => {}), 8000);
    const { sendModLog } = require('./modlog');
    await sendModLog(message.guild, embedBase('🛡️ Spam stopped', `${message.author.tag} (<@${message.author.id}>) in <#${message.channel.id}>\n${inWindow.length} msgs in ${cfg.spamWindowSec}s → timeout **${cfg.timeoutMin}m**.`, 0xed4245));
    history.set(k, []); // reset so one punishment doesn't chain-timeout the next message
  } catch {}
  return true;
}

module.exports = { checkRaid, LINK_RE };
