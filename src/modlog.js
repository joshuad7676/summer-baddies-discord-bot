/** Mod-log helper: posts embeds to settings.logChannel when set. Returns true if sent. */
async function sendModLog(guild, embed) {
  try {
    const { getDb } = require('./db');
    const id = getDb().settings.logChannel;
    if (!id) return false;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch || !ch.isTextBased()) return false;
    await ch.send({ embeds: [embed] }).catch(() => null);
    return true;
  } catch { return false; }
}

module.exports = { sendModLog };
