/** /link suite — password-free Roblox linking (username -> !verify CODE -> game POSTs /roblox/verify) */
const { SlashCommandBuilder } = require('discord.js');
const { getDb, save } = require('../src/db');
const { embedBase, okEmbed, themeColorInt } = require('../src/embeds');
const { robloxUserId, robloxThumb } = require('../src/roblox');

async function doLink(interaction) {
  const username = interaction.options.getString('username', true).replace('@', '').trim();
  await interaction.deferReply({ ephemeral: true });
  const db = getDb();
  let r;
  try { r = await robloxUserId(username); } catch { r = null; }
  if (!r) return interaction.editReply('❌ I could not find that Roblox username. Nothing was changed.');
  if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id) {
    return interaction.editReply('❌ That Roblox account is already linked to someone else. Contact staff if this is your account.');
  }
  for (const [code, rec] of Object.entries(db.linkCodes)) {
    if (rec.discordId === interaction.user.id) delete db.linkCodes[code];
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };
  save();
  const e = embedBase('🌸 Safe account link',
    'You are linking **Discord** to **Roblox** — not giving anyone access to your account.\n\n' +
    '🔒 **We will never ask for your Roblox password, cookie, email, or 2FA code.**\n' +
    `✅ Username found: **${r.name}**\n\n` +
    '### Finish in Roblox\nJoin the Summer Baddies Roblox game and type this in chat:\n\n' +
    `\`!verify ${code}\`\n\n` +
    'This one-time code expires in **10 minutes**. Never share it. If you did not request this, ignore it — nothing happens.',
    themeColorInt())
    .setFooter({ text: 'Password-free • one-time code • expires in 10 minutes' });
  const thumb = await robloxThumb(r.id);
  if (thumb) e.setThumbnail(thumb);
  return interaction.editReply({ embeds: [e] });
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')
      .addStringOption((o) => o.setName('username').setDescription('Your Roblox username').setRequired(true)),
    async execute(interaction) { await doLink(interaction); },
  },
  {
    data: new SlashCommandBuilder().setName('link-safety').setDescription('Learn how safe Roblox linking works'),
    async execute(interaction) {
      return interaction.reply({
        embeds: [embedBase('🛡️ Your Roblox link is safe',
          '**What we use:** your Roblox username and a temporary six-digit code.\n\n' +
          '**What we never use:** your password, email, browser cookie, backup codes, or 2FA code.\n\n' +
          '**How it works:** /link finds your public username, then you type a one-time `!verify CODE` message inside the Roblox game. ' +
          'The code expires after 10 minutes and is deleted after use.\n\n' +
          'If anyone asks for your password or cookie, do not send it — staff and this bot will never need it.', 0x57d9a3)],
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Roblox account'),
    async execute(interaction) {
      const db = getDb();
      const link = db.links[interaction.user.id];
      if (!link) return interaction.reply({ content: 'You are not linked. Use `/link` first.', ephemeral: true });
      delete db.robloxToDiscord[String(link.robloxId)];
      delete db.links[interaction.user.id];
      save();
      try {
        const m = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (m && db.settings.verifiedRoleId) await m.roles.remove(db.settings.verifiedRoleId).catch(() => {});
      } catch {}
      return interaction.reply({ embeds: [okEmbed('Unlinked', `Removed link to **${link.robloxUsername}** (\`${link.robloxId}\`).`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('verify-status').setDescription('Check if you (or someone) is verified/linked')
      .addUserOption((o) => o.setName('user').setDescription('Discord user (default: you)')),
    async execute(interaction) {
      const u = interaction.options.getUser('user') || interaction.user;
      const link = getDb().links[u.id];
      if (!link) return interaction.reply({ embeds: [embedBase('🔍 Verify status', `<@${u.id}> is **not linked**. Use \`/link\` to connect a Roblox account.`, themeColorInt())] });
      return interaction.reply({ embeds: [embedBase('✅ Verified', `Discord: <@${u.id}>\nRoblox: **${link.robloxUsername}** (\`${link.robloxId}\`)\nProfile: https://www.roblox.com/users/${link.robloxId}/profile`, 0x57d9a3)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('profile').setDescription('Show linked Roblox profile + game data')
      .addUserOption((o) => o.setName('user').setDescription('Discord user (default: you)')),
    async execute(interaction) {
      const db = getDb();
      const u = interaction.options.getUser('user') || interaction.user;
      const link = db.links[u.id];
      if (!link) return interaction.reply({ content: `<@${u.id}> is not linked. Use \`/link\`.`, ephemeral: true });
      const cached = db.playerCache[String(link.robloxId)];
      const inv = db.inventories[String(link.robloxId)];
      let desc = `Roblox: **${link.robloxUsername}** (\`${link.robloxId}\`)\nProfile: https://www.roblox.com/users/${link.robloxId}/profile`;
      if (cached) desc += `\n\n💰 Dinero: **${cached.money ?? '?'}**\n⚔️ Slays: **${cached.slays ?? '?'}**`;
      if (inv) desc += `\n🎒 Tracked: **${(inv.weapons || []).length}** weapons • **${(inv.skins || []).length}** skins • **${(inv.finishers || []).length}** finishers`;
      const e = embedBase(`🌸 ${link.robloxUsername}`, desc, themeColorInt());
      const thumb = await robloxThumb(link.robloxId);
      if (thumb) e.setThumbnail(thumb);
      return interaction.reply({ embeds: [e] });
    },
  },
];
