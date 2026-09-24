const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Database placeholder (ensure db setup exists in your startup script or local files)
let db = {
  inventories: {},
  robloxToDiscord: {},
  servers: {},
  iconCache: {}
};

// Helper function to safely normalize text
function norm(s) {
  return String(s || '').toLowerCase().trim();
}

// Fetch Roblox Asset Icon
async function getAssetIcon(id) {
  if (db.iconCache[id] && Date.now() - db.iconCache[id].at < 86400000) {
    return db.iconCache[id].url;
  }
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png&isCircular=false`);
    const j = await r.json();
    const url = j.data?.[0]?.imageUrl;
    if (url) {
      db.iconCache[id] = { url, at: Date.now() };
      return url;
    }
  } catch (e) {
    console.error('Thumbnail fetch error:', e);
  }
  return null;
}

// Find item owners across registered server inventories
function getOwners(type, name, limit = 10) {
  const out = [];
  const want = norm(name);

  for (const [rid, inv] of Object.entries(db.inventories || {})) {
    let list = [];
    if (type === 'Weapon') list = inv.weapons || [];
    else if (type === 'WeaponSkin') list = inv.skins || [];
    else list = inv.finishers || [];

    const has = list.some(x => {
      const itemVal = norm(typeof x === 'string' ? x : x.name);
      return itemVal === want || (itemVal.includes(want) && want.length > 3);
    });

    if (!has) continue;

    out.push({
      robloxId: rid,
      robloxUsername: inv.robloxUsername || 'Unknown',
      discordId: db.robloxToDiscord[rid] || db.robloxToDiscord[String(rid)] || null,
      placeId: inv.placeId,
      jobId: inv.jobId,
      at: inv.at || 0
    });

    if (out.length >= limit) break;
  }

  // Sort by active server status first, then by timestamp
  out.sort((a, b) => {
    const aOn = a.jobId && db.servers[a.jobId] ? 0 : 1;
    const bOn = b.jobId && db.servers[b.jobId] ? 0 : 1;
    return aOn - bOn || (b.at - a.at);
  });

  return out;
}

// Build Roblox server join URL
function teleportLink(placeId, jobId) {
  if (!placeId || !jobId) return null;
  return `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`;
}

// Format owner info into clean string lines
function ownerLine(o) {
  const disc = o.discordId ? `<@${o.discordId}> ☕` : '`not linked`';
  const isOnline = o.jobId && db.servers[o.jobId];
  const status = isOnline ? '🟢 **In Game**' : '🔴 **Offline**';
  
  return `• **[${o.robloxUsername}](https://www.roblox.com/users/${o.robloxId}/profile)** | Discord: ${disc} \vert{} Status:${status}`;
}

// Command Handler
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ----------------------------------------------------
  // ROBLOX BRIDGE COMMANDS
  // ----------------------------------------------------

  // Search weapon/item owners
  if (command === 'find' || command === 'owners') {
    const query = args.join(' ');
    if (!query) return message.reply('❌ Please specify an item name. Example: `!find Shadow Blade`');

    const results = getOwners('Weapon', query);

    if (results.length === 0) {
      return message.reply(`🔍 No active players found holding **${query}**.`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔎 Item Search: "${query}"`)
      .setColor(0x5865F2)
      .setDescription(results.map(ownerLine).join('\n'))
      .setFooter({ text: 'Roblox Discord Bridge System • Game Sync Active' })
      .setTimestamp();

    const activeLink = results.find(o => o.jobId && o.placeId);
    if (activeLink) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Active Server')
          .setStyle(ButtonStyle.Link)
          .setURL(teleportLink(activeLink.placeId, activeLink.jobId))
      );
      return message.reply({ embeds: [embed], components: [row] });
    }

    return message.reply({ embeds: [embed] });
  }

  // Check active server count
  if (command === 'servers' || command === 'gameinfo') {
    const activeServers = Object.keys(db.servers || {}).length;
    const trackedPlayers = Object.keys(db.inventories || {}).length;

    const embed = new EmbedBuilder()
      .setTitle('🎮 Game Bridge Overview')
      .setColor(0x57F287)
      .addFields(
        { name: 'Active Game Servers', value: `\`${activeServers}\``, inline: true },
        { name: 'Cached Player Inventories', value: `\`${trackedPlayers}\``, inline: true }
      )
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ----------------------------------------------------
  // CARL-BOT & GREED STYLE UTILITY COMMANDS
  // ----------------------------------------------------

  // Server Info Command
  if (command === 'serverinfo') {
    const { guild } = message;
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${guild.name} Stats`)
      .setThumbnail(guild.iconURL({ dynamic: true }))
      .setColor(0xEB459E)
      .addFields(
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Total Members', value: `\`${guild.memberCount}\``, inline: true },
        { name: 'Roles', value: `\`${guild.roles.cache.size}\``, inline: true },
        { name: 'Created On', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
      )
      .setFooter({ text: `ID: ${guild.id}` });

    return message.reply({ embeds: [embed] });
  }

  // User Info Command
  if (command === 'userinfo' || command === 'whois') {
    const member = message.mentions.members.first() || message.member;
    const embed = new EmbedBuilder()
      .setTitle(`👤 ${member.user.tag}`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Roles', value: member.roles.cache.map(r => r.toString()).slice(0, 10).join(', ') || 'None' }
      )
      .setFooter({ text: `User ID: ${member.id}` });

    return message.reply({ embeds: [embed] });
  }

  // Clear Messages Command (Moderation)
  if (command === 'purge' || command === 'clear') {
    if (!message.member.permissions.has('ManageMessages')) {
      return message.reply('❌ You do not have permission to delete messages.');
    }
    const count = parseInt(args[0]);
    if (isNaN(count) || count < 1 || count > 100) {
      return message.reply('⚠️ Please enter a number between 1 and 100.');
    }

    await message.channel.bulkDelete(count, true);
    const msg = await message.channel.send(`🧹 Cleaned **${count}** messages.`);
    setTimeout(() => msg.delete().catch(() => {}), 3000);
  }
});

client.login(process.env.DISCORD_TOKEN);
