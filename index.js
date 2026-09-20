const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

// Discord requires required slash-command options to come before optional ones.
const selfrolesStart = source.indexOf("new SlashCommandBuilder().setName('selfroles')");
if (selfrolesStart !== -1) {
  const nextCommand = source.indexOf("new SlashCommandBuilder()", selfrolesStart + 10);
  const end = nextCommand === -1 ? source.length : nextCommand;
  const block = source.slice(selfrolesStart, end);
  const setup = block.match(/\.addStringOption\(o\s*=>\s*o\.setName\(['"]setup['"]\)[\s\S]*?\.setRequired\(true\)\)?/);
  const channel = block.match(/\.addChannelOption\(o\s*=>\s*o\.setName\(['"]channel['"]\)[\s\S]*?\)\)?/);
  if (setup && channel && block.indexOf(setup[0]) > block.indexOf(channel[0])) {
    const reordered = block
      .replace(setup[0], '')
      .replace(channel[0], '')
      .replace(/(\.setDMPermission\(false\)|\.setDefaultMemberPermissions\([^)]*\))/, `$1\n     ${setup[0]}\n     ${channel[0]}`);
    source = source.slice(0, selfrolesStart) + reordered + source.slice(end);
  }
}

// --- SAFER, cuter Roblox linking flow ---
if (!source.includes("setName('link-safety')")) {
  const anchor = "  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')";
  const insert = "  new SlashCommandBuilder().setName('link-safety').setDescription('Learn how safe our Roblox linking works'),\n";
  if (source.includes(anchor)) {
    source = source.replace(anchor, insert + anchor);
  }
}

if (!source.includes("SAFE_LINK_TEXT")) {
  const oldLinkCmd = "  new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (type your Roblox username)')";
  const newLinkCmd = "  new SlashCommandBuilder().setName('link').setDescription('Safely link your Roblox account with a one-time code')";
  if (source.includes(oldLinkCmd)) {
    source = source.replace(oldLinkCmd, newLinkCmd);
  }
}

if (source.includes("if (cmd === 'link') {")) {
  const oldHandler = `    if (cmd === 'link') {\n      const username = interaction.options.getString('username', true).replace('@', '');\n      await interaction.deferReply({ ephemeral: true });\n      const r = await robloxUserId(username);\n      if (!r) return interaction.editReply('❌ Roblox user not found. Check spelling.');\n      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)\n        return interaction.editReply('❌ That Roblox account is already linked to someone else. Ask staff for help.');\n      // clear old codes for this user\n      for (const [code, rec] of Object.entries(db.linkCodes)) if (rec.discordId === interaction.user.id) delete db.linkCodes[code];\n      const code = String(Math.floor(100000 + Math.random() * 900000));\n      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };\n      save();\n      const thumb = await robloxThumb(r.id);\n      const e = embedBase('🔗 Link your account', `Found **${r.name}** (${r.displayName})\n\n**Step 2:** join Summer Baddies and chat:\n\`!verify ${code}\`\n\nCode expires in 10 minutes. Once the Roblox game confirms it, your Discord and Roblox accounts are linked.`, 0xff5da2);\n      if (thumb) e.setThumbnail(thumb);\n      return interaction.editReply({ embeds: [e] });\n    }`;
  const newHandler = `    if (cmd === 'link') {\n      const username = interaction.options.getString('username', true).replace('@', '').trim();\n      await interaction.deferReply({ ephemeral: true });\n      const r = await robloxUserId(username);\n      if (!r) return interaction.editReply('❌ I could not find that Roblox username. No account information was changed.');\n      if (db.robloxToDiscord[r.id] && db.robloxToDiscord[r.id] !== interaction.user.id)\n        return interaction.editReply('❌ That Roblox account is already linked. Nothing was changed—please contact staff if this is your account.');\n      for (const [code, rec] of Object.entries(db.linkCodes)) if (rec.discordId === interaction.user.id) delete db.linkCodes[code];\n      const code = String(Math.floor(100000 + Math.random() * 900000));\n      db.linkCodes[code] = { discordId: interaction.user.id, robloxUsername: r.name, robloxId: r.id, expires: Date.now() + 10 * 60 * 1000 };\n      save();\n      const e = embedBase('🌸 Safe account link',\n        'You are linking **Discord** to **Roblox** — without giving anyone your password.\\n\\n' +\n        '🔒 **We will never ask for your Roblox password, cookies, email, backup codes, or 2FA code.**\\n\\n' +\n        '✅ We only use your public username and a temporary one-time code.\\n\\n' +\n        '### Finish in Roblox\\n' +\n        'Join the Summer Baddies server and type this in chat:\\n\\n' +\n        '`!verify ' + code + '`\\n\\n' +\n        'This code expires in **10 minutes** and is deleted after use. If you did not request this, ignore it — nothing changes.', 0xff8fc7)\n        .setFooter({ text: 'Password-free • one-time code • expires in 10 minutes' });\n      const thumb = await robloxThumb(r.id);\n      if (thumb) e.setThumbnail(thumb);\n      return interaction.editReply({ embeds: [e] });\n    }`;
  if (source.includes(oldHandler)) {
    source = source.replace(oldHandler, newHandler);
  }
}

if (!source.includes("if (cmd === 'link-safety')")) {
  const anchor = "    if (cmd === 'profile') {";
  const insert = "    if (cmd === 'link-safety') {\n      return interaction.reply({ embeds: [embedBase('🛡️ Your Roblox link is safe',\n        '**What we use:** your Roblox username and a temporary 6-digit code.\\n\\n' +\n        '**What we never use:** your password, cookies, email, backup codes, or 2FA code.\\n\\n' +\n        '**How it works:** /link finds your public username, then you type `!verify CODE` inside the Roblox game. The code expires after 10 minutes and is deleted after use.\\n\\n' +\n        'If anyone asks for your password or cookie, do not send it — staff and this bot will never need it.', 0x57d9a3)] });\n    }\n";
  if (source.includes(anchor)) {
    source = source.replace(anchor, insert + anchor);
  }
}

if (source.includes("**Link / Verify**\\n/link, /unlink, /verify-status, /profile")) {
  source = source.replace("**Link / Verify**\\n/link, /unlink, /verify-status, /profile", "**Link / Verify**\\n/link, /link-safety, /unlink, /verify-status, /profile");
}

fs.writeFileSync(indexPath, source);
require('./index.js');
