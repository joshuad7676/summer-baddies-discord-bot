/** Live game info: /server-info /online /teleport /search-player */
const { SlashCommandBuilder } = require('discord.js');
const { getDb } = require('../src/db');
const { embedBase, themeColorInt } = require('../src/embeds');
const { robloxUserId, robloxThumb, teleportLink } = require('../src/roblox');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('server-info').setDescription('Show Discord server info + link stats'),
    async execute(interaction) {
      const g = interaction.guild;
      const db = getDb();
      const e = embedBase(`🏠 ${g.name}`,
        `Members: **${g.memberCount}**\n` +
        `Linked accounts: **${Object.keys(db.links).length}**\n` +
        `Live game servers: **${Object.keys(db.servers).length}**\n` +
        `Tracked inventories: **${Object.keys(db.inventories).length}**\n` +
        `Queued game commands: **${db.commands.length}**`, themeColorInt())
        .setThumbnail(g.iconURL({ size: 256 }));
      return interaction.reply({ embeds: [e] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('online').setDescription('Show live game servers + online tracked players'),
    async execute(interaction) {
      const db = getDb();
      const servers = Object.values(db.servers || {});
      if (!servers.length) return interaction.reply({ embeds: [embedBase('🟢 Live servers', '_No live servers right now — start the game bridge and servers will appear here._', themeColorInt())] });
      const lines = servers.slice(0, 10).map((s) => {
        const tp = teleportLink(s.placeId, s.jobId);
        return `**${(s.players || []).length}** players — [Join](${tp})\n\`${(s.players || []).slice(0, 8).map((p) => p.robloxUsername).join(', ') || '—'}\``;
      });
      return interaction.reply({ embeds: [embedBase('🟢 Live servers', lines.join('\n\n').slice(0, 3900), themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('teleport').setDescription('Get a join link for an online player')
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true)),
    async execute(interaction) {
      await interaction.deferReply();
      const db = getDb();
      const q = interaction.options.getString('username', true).toLowerCase();
      const hit = Object.entries(db.inventories || {}).find(([, inv]) => (inv.robloxUsername || '').toLowerCase() === q);
      if (!hit || !hit[1].placeId || !hit[1].jobId) return interaction.editReply('❌ That player is not online in a tracked server.');
      const [, inv] = hit;
      const link = teleportLink(inv.placeId, inv.jobId);
      return interaction.editReply({ embeds: [embedBase(`🚀 Teleport to ${inv.robloxUsername}`, `[Join server](${link})\n\`roblox://placeId=${inv.placeId}&gameInstanceId=${inv.jobId}\``, themeColorInt())] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('search-player').setDescription('Search for player data (Roblox + cached game data)')
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true)),
    async execute(interaction) {
      await interaction.deferReply();
      const db = getDb();
      const q = interaction.options.getString('username', true);
      let r = null;
      try { r = await robloxUserId(q); } catch {}
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const cached = Object.values(db.playerCache || {}).find((p) => String(p.robloxId) === String(r.id));
      const discordId = db.robloxToDiscord[String(r.id)];
      const e = embedBase(`👤 ${r.name}`,
        `Display: ${r.displayName}\nID: \`${r.id}\`\nProfile: https://www.roblox.com/users/${r.id}/profile\n` +
        `Discord: ${discordId ? `<@${discordId}> ✅` : '`not linked`'}` +
        (cached ? `\n\n💰 Dinero: **${cached.money ?? '?'}**\n⚔️ Slays: **${cached.slays ?? '?'}**` : '\n\n_No cached game data yet._'),
        themeColorInt());
      const thumb = await robloxThumb(r.id);
      if (thumb) e.setThumbnail(thumb);
      return interaction.editReply({ embeds: [e] });
    },
  },
];
