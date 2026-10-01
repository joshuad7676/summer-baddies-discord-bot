/** /help (fixed) + /ping */
const { SlashCommandBuilder } = require('discord.js');
const { getDb } = require('../src/db');
const { embedBase, themeColorInt, themeColorHex, DIV } = require('../src/embeds');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),
    async execute(interaction) {
      const db = getDb();
      const e = embedBase('🌸 Summer Baddies — help',
        `Theme: **${themeColorHex()}** (change with \`/set-bot-theme\`)\n${DIV}\n` +
        `🔗 **Linking**\n\`/link\` \`/link-safety\` \`/unlink\` \`/verify-status\` \`/profile\`\n\n` +
        `💎 **Values & trading**\n\`/value\` \`/item\` \`/owners\` \`/search-weapons\` \`/search-skins\` \`/search-finishers\`\n\n` +
        `🎮 **Game info**\n\`/server-info\` \`/online\` \`/teleport\` \`/search-player\`\n\n` +
        `🛡️ **Staff — game mod**\n\`/game-kick\` \`/game-ban\` \`/game-unban\` \`/game-announce\` \`/game-restart\` \`/game-luck\` \`/admin-abuse\`\n\n` +
        `🎁 **Staff — giving**\n\`/game-money\` \`/give-tokens\` \`/give-spins\` \`/give-weapon\` \`/give-skin\` \`/give-finisher\` \`/give-everything\`\n\`/give-all-weapon\` \`/give-all-skin\` \`/give-all-finisher\` \`/give-all-tokens\` \`/give-all-spins\`\n\n` +
        `✨ **Staff — emoji / PvP**\n\`/add-emoji\` \`/remove-emoji\` \`/force-pvp\` \`/unforce-pvp\` \`/force-show-emoji\` \`/unforce-show-emoji\`\n\n` +
        `⚙️ **Customization**\n\`/set-welcome-message\` \`/set-leave-message\` \`/preview-welcome\` \`/preview-leave\`\n\`/set-bot-theme\` \`/setcommand-prefix\` \`/see-rcommands\`\n\`/setup-welcome\` \`/setup-leave\` \`/setup-reports\` \`/setup-verified\`\n\n` +
        `💬 **Natural language**\nMention me: \`@bot make a role called Hello and make it pink\`\nMention me with nothing else and I say hello.\n\n` +
        `${DIV}\nFull Roblox list: \`/see-rcommands\``,
        themeColorInt());
      return interaction.reply({ embeds: [e], ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    async execute(interaction) {
      const sent = await interaction.reply({ content: '🏓 Pinging…', fetchReply: true });
      const ms = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`🏓 Pong! **${ms}ms** • WS **${Math.round(interaction.client.ws.ping)}ms**`);
    },
  },
];
