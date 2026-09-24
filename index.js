      return interaction.reply({ content: `${u.username} has not linked a Roblox account. Use /link.`, ephemeral: true });
      const thumb = await robloxThumb(l.robloxId);
      const cached = db.playerCache[l.robloxId];
      const inv = db.inventories[l.robloxId];
      let desc = `**Roblox Username:** ${l.robloxUsername}\n` +
        `**Roblox ID:** \`${l.robloxId}\`\n` +
        `**Profile Link:** https://www.roblox.com/users/${l.robloxId}/profile\n` +
        `**Linked At:** <t:${Math.floor(l.at / 1000)}:R>\n\n`;

      if (cached) {
        desc += `**In-Game Statistics:**\n` +
          `• Dinero: **$${cached.money ?? 0}**\n` +
          `• Slays: **${cached.slays ?? 0}**\n` +
          `• Total Weapons: **${cached.weapons ?? 0}**\n` +
          `• Total Skins: **${cached.skins ?? 0}**\n` +
          `• Total Finishers: **${cached.finishers ?? 0}**\n\n`;
      } else {
        desc += `_No cached game data available (player has not joined while bridge was active)._\n\n`;
      }

      if (inv && inv.placeId && inv.jobId) {
        desc += `🟢 **Currently Online:**\n[Join Server](${teleportLink(inv.placeId, inv.jobId)})`;
      } else {
        desc += `🔴 **Status:** Offline or not in a tracked server.`;
      }

      const emb = embedBase(`👤 Profile — ${l.robloxUsername}`, desc, 0xff5da2);
      if (thumb) emb.setThumbnail(thumb);
      return interaction.reply({ embeds: [emb] });
    }

    if (cmd === 'value') {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      const v = lookupValue(type, name);
      return interaction.reply({ embeds: [embedBase('💰 Item Value', valueLine(v), demand.COLORS[v.demand] || 0xff5da2)] });
    }

    if (cmd === 'item') {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      await interaction.deferReply();
      const emb = await buildItemEmbed(type, name);
      return interaction.editReply({ embeds: [emb] });
    }

    if (cmd === 'owners') {
      const type = interaction.options.getString('type', true);
      const name = interaction.options.getString('name', true);
      const v = lookupValue(type, name);
      const owners = getOwners(v.type, v.name, 10);
      if (!owners.length) return interaction.reply({ embeds: [embedBase(`👥 Owners — ${v.name}`, '_No tracked owners found for this item._')] });
      const lines = owners.map(ownerLine);
      return interaction.reply({ embeds: [embedBase(`👥 Owners — ${v.name} (${owners.length})`, lines.join('\n').slice(0, 3900))] });
    }

    if (cmd === 'online') {
      const serverList = Object.values(db.servers || {});
      if (!serverList.length) return interaction.reply({ embeds: [embedBase('🟢 Live Game Servers', '_No active game servers currently online._')] });
      let totalPlayers = 0;
      const lines = serverList.map((s, idx) => {
        const count = s.players ? s.players.length : 0;
        totalPlayers += count;
        const tp = teleportLink(s.placeId, s.jobId);
        const tpTxt = tp ? `[Join Server](${tp})` : '`No TP Link`';
        return `**Server #${idx + 1}** • Players: **${count}** • ${tpTxt}`;
      });
      return interaction.reply({ embeds: [embedBase(`🟢 Live Game Servers (${serverList.length})`, `**Total Active Players:** ${totalPlayers}\n\n` + lines.join('\n').slice(0, 3800))] });
    }

    if (cmd === 'teleport') {
      const username = interaction.options.getString('username', true);
      await interaction.deferReply();
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const inv = db.inventories[r.id];
      if (!inv || !inv.placeId || !inv.jobId || !db.servers[inv.jobId]) {
        return interaction.editReply(`❌ **${r.name}** is not currently online in a tracked server.`);
      }
      const tp = teleportLink(inv.placeId, inv.jobId);
      return interaction.editReply({ embeds: [embedBase('🚀 Teleport Link', `[Click here to join **${r.name}**](${tp})\n\`roblox://placeId=${inv.placeId}&gameInstanceId=${inv.jobId}\``, 0x57f287)] });
    }

    if (cmd === 'search-skins' || cmd === 'search-weapons' || cmd === 'search-finishers') {
      const q = interaction.options.getString('query', true).toLowerCase();
      const type = cmd === 'search-skins' ? 'WeaponSkin' : cmd === 'search-weapons' ? 'Weapon' : 'Finisher';
      const cat = cmd === 'search-skins' ? catalogs.skinTypes : cmd === 'search-weapons' ? catalogs.weapons : catalogs.finishers;
      const matches = cat.filter(x => x.toLowerCase().includes(q)).slice(0, 10);
      if (!matches.length) return interaction.reply({ embeds: [embedBase('🔍 Search Results', `No ${type} items found matching \`${q}\`.`)] });
      const lines = matches.map(m => {
        const v = lookupValue(type, m);
        return valueLine(v);
      });
      return interaction.reply({ embeds: [embedBase(`🔍 ${type} Results (${matches.length})`, lines.join('\n'))] });
    }

    if (cmd === 'search-player') {
      const username = interaction.options.getString('username', true);
      await interaction.deferReply();
      const r = await robloxUserId(username);
      if (!r) return interaction.editReply('❌ Roblox user not found.');
      const cached = db.playerCache[r.id];
      const inv = db.inventories[r.id];
      const discordId = db.robloxToDiscord[r.id];
      const thumb = await robloxThumb(r.id);

      let txt = `**Username:** ${r.name} (\`${r.id}\`)\n` +
        `**Discord:** ${discordId ? `<@${discordId}>` : '`Not linked`'}\n\n`;

      if (cached) {
        txt += `**Cached Stats:**\n` +
          `• Dinero: **$${cached.money ?? 0}** • Slays: **${cached.slays ?? 0}**\n` +
          `• Weapons: **${cached.weapons ?? 0}** • Skins: **${cached.skins ?? 0}** • Finishers: **${cached.finishers ?? 0}**\n\n`;
      } else {
        txt += `_No cached stats found._\n\n`;
      }

      if (inv && inv.placeId && inv.jobId && db.servers[inv.jobId]) {
        txt += `🟢 **Online:** [Join Game](${teleportLink(inv.placeId, inv.jobId)})`;
      } else {
        txt += `🔴 **Status:** Offline`;
      }

      const emb = embedBase(`🔍 Player — ${r.name}`, txt);
      if (thumb) emb.setThumbnail(thumb);
      return interaction.editReply({ embeds: [emb] });
    }

    if (cmd === 'rules') {
      const mode = interaction.options.getString('mode') || 'custom';
      if (mode === 'tos') {
        return interaction.reply({
          embeds: [embedBase('📜 Discord Terms of Service & Community Guidelines',
            'All members are required to abide by Discord\'s official policies:\n\n' +
            '• [Discord Terms of Service](https://dis.gd/tos)\n' +
            '• [Discord Community Guidelines](https://dis.gd/guidelines)\n\n' +
            'Please treat all users with respect and maintain appropriate content at all times.')]
        });
      }
      const rules = db.settings.rulesText || 'No custom rules have been set yet. Staff can set rules with `/set-rules`.';
      return interaction.reply({ embeds: [embedBase('📜 Server Rules', rules)] });
    }

    // ----- STAFF COMMANDS -----
    if (cmd === 'give-weapon' || cmd === 'give-skin' || cmd === 'give-finisher') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      const by = interaction.user.tag;

      if (cmd === 'give-weapon') {
        const item = interaction.options.getString('weapon', true);
        queueCommand({ type: 'give_weapon', robloxUsername: r.name, robloxId: r.id, weapon: item, by });
        return interaction.reply({ embeds: [embedBase('✅ Command Queued', `Queued weapon **${item}** for **${r.name}**.`)] });
      } else if (cmd === 'give-skin') {
        const wType = interaction.options.getString('weapontype', true);
        const skin = interaction.options.getString('skin', true);
        queueCommand({ type: 'give_skin', robloxUsername: r.name, robloxId: r.id, weaponType: wType, skin, by });
        return interaction.reply({ embeds: [embedBase('✅ Command Queued', `Queued skin **${skin}** (${wType}) for **${r.name}**.`)] });
      } else {
        const finisher = interaction.options.getString('finisher', true);
        queueCommand({ type: 'give_finisher', robloxUsername: r.name, robloxId: r.id, finisher, by });
        return interaction.reply({ embeds: [embedBase('✅ Command Queued', `Queued finisher **${finisher}** for **${r.name}**.`)] });
      }
    }

    if (cmd === 'player-data') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      const cached = db.playerCache[r.id];
      const inv = db.inventories[r.id];
      const did = db.robloxToDiscord[r.id];

      let desc = `**Roblox:** ${r.name} (\`${r.id}\`)\n` +
        `**Discord:** ${did ? `<@${did}>` : '`Not linked`'}\n\n`;

      if (cached) {
        desc += `**Stats:**\nDinero: $${cached.money ?? 0} \vert{} Slays: ${cached.slays ?? 0}\n` +
          `Weapons: ${cached.weapons ?? 0} | Skins: ${cached.skins ?? 0} \vert{} Finishers: ${cached.finishers ?? 0}\n\n`;
      }
      if (inv) {
        desc += `**Inventory Details:**\n` +
          `• Weapons: ${(inv.weapons || []).length}\n` +
          `• Skins: ${(inv.skins || []).length}\n` +
          `• Finishers: ${(inv.finishers || []).length}\n`;
      }
      return interaction.reply({ embeds: [embedBase(`📊 Player Data — ${r.name}`, desc)], ephemeral: true });
    }

    if (cmd === 'game-kick' || cmd === 'game-ban' || cmd === 'game-unban') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const username = interaction.options.getString('username', true);
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      const by = interaction.user.tag;

      if (cmd === 'game-kick') {
        queueCommand({ type: 'kick', robloxUsername: r.name, robloxId: r.id, reason, by });
        return interaction.reply({ embeds: [embedBase('🦵 Kick Queued', `Kicking **${r.name}**.\nReason: \`${reason}\``)] });
      } else if (cmd === 'game-ban') {
        const syncDiscord = interaction.options.getBoolean('syncdiscord') ?? true;
        db.bans[r.id] = { reason, by, at: Date.now() };
        save();
        queueCommand({ type: 'ban', robloxUsername: r.name, robloxId: r.id, reason, by });
        if (syncDiscord) {
          const did = db.robloxToDiscord[r.id];
          if (did) {
            try {
              const m = await interaction.guild.members.fetch(did);
              await m.ban({ reason: `[Game Ban Sync] ${reason}` });
            } catch {}
          }
        }
        return interaction.reply({ embeds: [embedBase('🔨 Ban Queued', `Banned **${r.name}**.\nReason: \`${reason}\``)] });
      } else {
        delete db.bans[r.id];
        save();
        queueCommand({ type: 'unban', robloxUsername: r.name, robloxId: r.id, by });
        return interaction.reply({ embeds: [embedBase('🔓 Unban Queued', `Unbanning **${r.name}**.`)] });
      }
    }

    if (cmd === 'game-announce') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const message = interaction.options.getString('message', true);
      queueCommand({ type: 'announce', message: message.slice(0, 200), by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [embedBase('📢 Announcement Queued', `Broadcast: "${message.slice(0, 200)}"`)] });
    }

    if (cmd === 'game-restart') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const delay = interaction.options.getInteger('delay') || 30;
      const reason = interaction.options.getString('reason') || 'Server maintenance';
      queueCommand({ type: 'restart', delay, reason, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [embedBase('🔁 Restart Queued', `Servers will restart in ${delay} seconds.\nReason: ${reason}`)] });
    }

    if (cmd === 'game-luck') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const mult = interaction.options.getInteger('mult', true);
      const minutes = interaction.options.getInteger('minutes') || 10;
      queueCommand({ type: 'luck', mult, minutes, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [embedBase('🍀 Luck Boost Queued', `Server luck multiplier set to **x${mult}** for **${minutes}** minutes.`)] });
    }

    if (cmd === 'admin-abuse') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const event = interaction.options.getString('event', true);
      const duration = interaction.options.getInteger('duration') || 60;
      queueCommand({ type: 'abuse', event, duration, by: interaction.user.tag, broadcast: true });
      return interaction.reply({ embeds: [embedBase('🎉 Admin Event Queued', `Triggered event \`${event}\` (duration: ${duration}s).`)] });
    }

    if (cmd === 'game-money' || cmd === 'give-tokens' || cmd === 'give-spins') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const action = interaction.options.getString('action', true);
      const username = interaction.options.getString('username', true);
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      const amount = interaction.options.getInteger('amount', true);
      const by = interaction.user.tag;

      if (cmd === 'game-money') {
        queueCommand({ type: 'money', action, robloxUsername: r.name, robloxId: r.id, amount, by });
        return interaction.reply({ embeds: [embedBase('💵 Money Command Queued', `${action} $${amount} Dinero for **${r.name}**.`)] });
      } else if (cmd === 'give-tokens') {
        queueCommand({ type: 'give_tokens', action, robloxUsername: r.name, robloxId: r.id, amount, by });
        return interaction.reply({ embeds: [embedBase('🪙 Tokens Command Queued', `${action} ${amount} Tokens for **${r.name}**.`)] });
      } else {
        const kind = interaction.options.getString('type', true);
        queueCommand({ type: 'give_spins', kind, action, robloxUsername: r.name, robloxId: r.id, amount, by });
        return interaction.reply({ embeds: [embedBase('🎰 Spins Command Queued', `${action} ${amount} ${kind} spins for **${r.name}**.`)] });
      }
    }

    if (cmd === 'give-all-weapon' || cmd === 'give-all-skin' || cmd === 'give-all-finisher' || cmd === 'give-all-tokens' || cmd === 'give-all-spins') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const by = interaction.user.tag;

      if (cmd === 'give-all-weapon') {
        const weapon = interaction.options.getString('weapon', true);
        queueCommand({ type: 'give_all_weapon', weapon, by, broadcast: true });
        return interaction.reply({ embeds: [embedBase('🎁 Give All Queued', `Granting weapon **${weapon}** to all online players.`)] });
      } else if (cmd === 'give-all-skin') {
        const wType = interaction.options.getString('weapontype', true);
        const skin = interaction.options.getString('skin', true);
        queueCommand({ type: 'give_all_skin', weaponType: wType, skin, by, broadcast: true });
        return interaction.reply({ embeds: [embedBase('🎁 Give All Queued', `Granting skin **${skin}** (${wType}) to all online players.`)] });
      } else if (cmd === 'give-all-finisher') {
        const finisher = interaction.options.getString('finisher', true);
        queueCommand({ type: 'give_all_finisher', finisher, by, broadcast: true });
        return interaction.reply({ embeds: [embedBase('🎁 Give All Queued', `Granting finisher **${finisher}** to all online players.`)] });
      } else if (cmd === 'give-all-tokens') {
        const amount = interaction.options.getInteger('amount', true);
        queueCommand({ type: 'give_all_tokens', amount, by, broadcast: true });
        return interaction.reply({ embeds: [embedBase('🎁 Give All Queued', `Granting ${amount} Tokens to all online players.`)] });
      } else {
        const kind = interaction.options.getString('type', true);
        const amount = interaction.options.getInteger('amount', true);
        queueCommand({ type: 'give_all_spins', kind, amount, by, broadcast: true });
        return interaction.reply({ embeds: [embedBase('🎁 Give All Queued', `Granting ${amount} ${kind} spins to all online players.`)] });
      }
    }

    if (cmd === 'add-emoji' || cmd === 'remove-emoji' || cmd === 'force-pvp' || cmd === 'unforce-pvp' || cmd === 'force-show-emoji' || cmd === 'unforce-show-emoji') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const username = interaction.options.getString('username');
      const userId = interaction.options.getInteger('userid');
      let targetName = username, targetId = userId;

      if (!targetId && targetName) {
        const r = await robloxUserId(targetName);
        if (r) { targetId = r.id; targetName = r.name; }
      }
      if (!targetId) return interaction.reply({ content: '❌ Provide a valid Roblox username or User ID.', ephemeral: true });

      const by = interaction.user.tag;
      const qtype = cmd.replace(/-/g, '_');
      const emoji = cmd === 'add-emoji' ? interaction.options.getString('emoji', true) : null;

      queueCommand({ type: qtype, robloxUsername: targetName || String(targetId), robloxId: targetId, emoji, by, broadcast: true });
      return interaction.reply({ embeds: [embedBase('✅ Command Queued', `Queued \`${cmd}\` for **${targetName || targetId}**.`)] });
    }

    if (cmd === 'selfroles') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const setup = interaction.options.getString('setup', true);
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      if (!channel.isTextBased()) return interaction.reply({ content: '❌ Target channel must be a text channel.', ephemeral: true });

      const rawLines = setup.split(/[\n;]/).map(l => l.trim()).filter(Boolean).slice(0, 10);
      if (!rawLines.length) return interaction.reply({ content: '❌ Invalid setup format. Example: `Label | 🌸 | @Role`', ephemeral: true });

      const entries = [];
      const descriptionLines = [];

      for (const line of rawLines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 3) continue;
        const label = parts[0];
        const emojiStr = parts[1];
        const roleMention = parts[2];
        const roleIdMatch = roleMention.match(/\d+/);
        if (!roleIdMatch) continue;
        const roleId = roleIdMatch[0];

        entries.push({ label, emoji: emojiStr, roleId });
        descriptionLines.push(`${emojiStr} — <@&${roleId}> (${label})`);
      }

      if (!entries.length) return interaction.reply({ content: '❌ Could not parse valid self-role lines.', ephemeral: true });

      const embed = embedBase('🎭 Reaction Roles', `React to assign or remove roles:\n\n` + descriptionLines.join('\n'));
      const msg = await channel.send({ embeds: [embed] });

      for (const e of entries) {
        try { await msg.react(e.emoji); } catch {}
      }

      db.reactionRoles[msg.id] = { guildId: interaction.guildId, entries };
      save();
      return interaction.reply({ content: `✅ Self-roles posted in <#${channel.id}>!`, ephemeral: true });
    }

    if (cmd === 'shortcut-add' || cmd === 'shortcut-remove' || cmd === 'shortcut-list' || cmd === 'shortcut-prefix') {
      const staff = await requireStaff(interaction);
      if (!staff) return;

      if (cmd === 'shortcut-add') {
        const command = interaction.options.getString('command', true);
        const letters = interaction.options.getString('letters', true).toLowerCase().replace(/[^a-z0-9]/g, '');
        const customPrefix = interaction.options.getString('prefix') || db.shortcuts.prefix || ',';
        if (!letters) return interaction.reply({ content: '❌ Invalid shortcut letters.', ephemeral: true });
        db.shortcuts.map[letters] = { command, prefix: customPrefix };
        save();
        return interaction.reply({ content: `✅ Mapped \`${customPrefix}${letters}\` → \`/${command}\`.`, ephemeral: true });
      } else if (cmd === 'shortcut-remove') {
        const alias = interaction.options.getString('alias', true).toLowerCase();
        let keyToRemove = alias;
        const p = db.shortcuts.prefix || ',';
        if (alias.startsWith(p)) keyToRemove = alias.slice(p.length);
        if (db.shortcuts.map[keyToRemove]) {
          delete db.shortcuts.map[keyToRemove];
          save();
          return interaction.reply({ content: `✅ Shortcut removed.`, ephemeral: true });
        }
        return interaction.reply({ content: `❌ Shortcut not found.`, ephemeral: true });
      } else if (cmd === 'shortcut-list') {
        return interaction.reply({ embeds: [embedBase('⌨️ Text Shortcuts', shortcutsHelp())], ephemeral: true });
      } else {
        const prefix = interaction.options.getString('prefix', true).trim();
        db.shortcuts.prefix = prefix;
        save();
        return interaction.reply({ content: `✅ Default prefix set to \`${prefix}\`.`, ephemeral: true });
      }
    }

    if (cmd === 'sync-levels') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      await interaction.deferReply({ ephemeral: true });
      const members = await interaction.guild.members.fetch();
      let count = 0;
      for (const [id, member] of members) {
        if (member.user.bot) continue;
        const rec = db.levels[id];
        if (rec && rec.level > 0) {
          const ok = await syncLevelRole(member, rec.level);
          if (ok) count++;
        }
      }
      return interaction.editReply(`✅ Synced milestone roles for **${count}** members.`);
    }

    if (cmd === 'give-everything') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const username = interaction.options.getString('username', true);
      const cat = interaction.options.getString('category') || 'everything';
      const r = await robloxUserId(username);
      if (!r) return interaction.reply({ content: '❌ Roblox user not found.', ephemeral: true });
      queueCommand({ type: 'give_everything', robloxUsername: r.name, robloxId: r.id, category: cat, by: interaction.user.tag });
      return interaction.reply({ embeds: [embedBase('🎁 Give Everything Queued', `Queued full grant (\`${cat}\`) for **${r.name}**.`)] });
    }

    if (cmd === 'kick' || cmd === 'ban' || cmd === 'unban' || cmd === 'timeout' || cmd === 'untimeout') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (cmd === 'unban') {
        const uid = interaction.options.getString('userid', true);
        await interaction.guild.members.unban(uid, reason).catch(e => interaction.reply({ content: '❌ Unban failed: ' + e.message, ephemeral: true }));
        const rId = Object.keys(db.robloxToDiscord).find(k => db.robloxToDiscord[k] === uid);
        if (rId) {
          delete db.bans[rId];
          save();
          queueCommand({ type: 'unban', robloxId: Number(rId), by: interaction.user.tag });
        }
        return interaction.reply({ embeds: [embedBase('🔓 Member Unbanned', `Unbanned Discord user \`${uid}\`.`)] });
      }

      const user = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: '❌ User is not in this server.', ephemeral: true });

      if (cmd === 'kick') {
        await member.kick(reason);
        const rId = Object.keys(db.robloxToDiscord).find(k => db.robloxToDiscord[k] === user.id);
        if (rId) queueCommand({ type: 'kick', robloxId: Number(rId), reason, by: interaction.user.tag });
        return interaction.reply({ embeds: [embedBase('🦵 Member Kicked', `Kicked <@${user.id}>.\nReason: ${reason}`)] });
      } else if (cmd === 'ban') {
        await member.ban({ reason });
        const rId = Object.keys(db.robloxToDiscord).find(k => db.robloxToDiscord[k] === user.id);
        if (rId) {
          db.bans[rId] = { reason, by: interaction.user.tag, at: Date.now() };
          save();
          queueCommand({ type: 'ban', robloxId: Number(rId), reason, by: interaction.user.tag });
        }
        return interaction.reply({ embeds: [embedBase('🔨 Member Banned', `Banned <@${user.id}>.\nReason: ${reason}`)] });
      } else if (cmd === 'timeout') {
        const mins = interaction.options.getInteger('minutes', true);
        await member.timeout(mins * 60 * 1000, reason);
        return interaction.reply({ embeds: [embedBase('⏱️ Member Timed Out', `Timed out <@${user.id}> for **${mins}** minutes.\nReason: ${reason}`)] });
      } else {
        await member.timeout(null);
        return interaction.reply({ embeds: [embedBase('⏱️ Timeout Removed', `Removed timeout for <@${user.id}>.`)] });
      }
    }

    if (cmd === 'setup-welcome' || cmd === 'setup-leave' || cmd === 'setup-reports' || cmd === 'setup-verified' || cmd === 'setup-levels') {
      const staff = await requireStaff(interaction);
      if (!staff) return;

      if (cmd === 'setup-welcome') {
        const ch = interaction.options.getChannel('channel', true);
        db.settings.welcomeChannel = ch.id;
        save();
        return interaction.reply({ content: `✅ Welcome channel set to <#${ch.id}>.`, ephemeral: true });
      } else if (cmd === 'setup-leave') {
        const ch = interaction.options.getChannel('channel', true);
        db.settings.leaveChannel = ch.id;
        save();
        return interaction.reply({ content: `✅ Leave channel set to <#${ch.id}>.`, ephemeral: true });
      } else if (cmd === 'setup-reports') {
        const ch = interaction.options.getChannel('channel', true);
        db.settings.reportsChannel = ch.id;
        save();
        return interaction.reply({ content: `✅ In-game reports channel set to <#${ch.id}>.`, ephemeral: true });
      } else if (cmd === 'setup-verified') {
        const role = interaction.options.getRole('role', true);
        db.settings.verifiedRoleId = role.id;
        save();
        return interaction.reply({ content: `✅ Verified role set to <@&${role.id}>.`, ephemeral: true });
      } else {
        const ch = interaction.options.getChannel('channel');
        const enabled = interaction.options.getBoolean('enabled');
        if (ch) db.settings.levelChannelId = ch.id;
        if (enabled !== null) db.settings.levelsEnabled = enabled;
        save();
        return interaction.reply({ content: `✅ Level settings updated. (Enabled: ${db.settings.levelsEnabled}, Channel: ${db.settings.levelChannelId ? `<#${db.settings.levelChannelId}>` : 'Current channel'})`, ephemeral: true });
      }
    }

    if (cmd === 'test-welcome' || cmd === 'test-leave') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const fakeMember = await interaction.guild.members.fetch(targetUser.id).catch(() => interaction.member);

      if (cmd === 'test-welcome') {
        const res = await sendWelcome(fakeMember);
        return interaction.reply({ content: res.ok ? '✅ Sent test welcome!' : `❌ Welcome failed: ${res.err}`, ephemeral: true });
      } else {
        const res = await sendLeave(fakeMember);
        return interaction.reply({ content: res.ok ? '✅ Sent test leave!' : `❌ Leave failed: ${res.err}`, ephemeral: true });
      }
    }

    if (cmd === 'linked-list') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const entries = Object.entries(db.links).slice(-15).reverse();
      if (!entries.length) return interaction.reply({ content: 'No linked accounts found.', ephemeral: true });
      const lines = entries.map(([did, info]) => `<@${did}> → **${info.robloxUsername}** (\`${info.robloxId}\`) <t:${Math.floor(info.at / 1000)}:R>`);
      return interaction.reply({ embeds: [embedBase('🔗 Recent Linked Accounts', lines.join('\n'))], ephemeral: true });
    }

    if (cmd === 'set-rules') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      const text = interaction.options.getString('text', true).replace(/\\n/g, '\n');
      db.settings.rulesText = text;
      save();
      return interaction.reply({ content: '✅ Custom rules text updated! Check with `/rules`.', ephemeral: true });
    }

    if (cmd === 'send-tos') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      await interaction.reply({ content: 'Sending TOS embed...', ephemeral: true });
      return interaction.channel.send({
        embeds: [embedBase('📜 Discord Terms of Service & Community Guidelines',
          'All members are required to abide by Discord\'s official policies:\n\n' +
          '• [Discord Terms of Service](https://dis.gd/tos)\n' +
          '• [Discord Community Guidelines](https://dis.gd/guidelines)\n\n' +
          'Please treat all users with respect and maintain appropriate content at all times.')]
      });
    }

    // ----- OWNER COMMANDS -----
    if (cmd === 'setup-roles') {
      if (!await requireOwner(interaction)) return;
      await interaction.deferReply({ ephemeral: true });
      const res = await setupRoleLadder(interaction.guild);
      let desc = `**Role Ladder Setup Complete!**\n\n` +
        `• Created (${res.created.length}): ${res.created.join(', ') || 'None'}\n` +
        `• Skipped (${res.skipped.length}): ${res.skipped.join(', ') || 'None'}\n`;
      if (res.failed.length) desc += `• Failed: ${res.failed.join('; ')}\n`;
      if (res.orderWarning) desc += `\n⚠️ **Warning:** ${res.orderWarning}`;
      return interaction.editReply({ embeds: [embedBase('👑 Role Ladder Setup', desc)] });
    }

    if (cmd === 'setup-layout') {
      const staff = await requireStaff(interaction);
      if (!staff) return;
      await interaction.deferReply({ ephemeral: true });

      const preset = interaction.options.getString('preset');
      const desc = interaction.options.getString('description');
      let layoutToApply = [];

      if (desc) {
        const parsed = parseLayoutDescription(desc);
        layoutToApply = parsed.layout;
      } else if (preset === 'baddies' || !desc) {
        layoutToApply = getBaddiesPreset();
      }

      const res = await applyLayout(interaction.guild, layoutToApply);
      let outText = `**Layout Applied Successfully!**\n\n` +
        `• Categories Created: ${res.createdCats.length}\n` +
        `• Channels Created: ${res.createdChs.length}\n`;
      if (res.wired.length) outText += `• Auto-wired Settings: ${res.wired.join(', ')}\n`;
      if (res.failed.length) outText += `\n⚠️ **Failures:**\n${res.failed.join('\n')}`;

      return interaction.editReply({ embeds: [embedBase('🏗️ Server Layout Applied', outText)] });
    }

    if (cmd === 'reset-layout') {
      if (!await requireOwner(interaction)) return;
      const confirm = interaction.options.getString('confirm', true);
      if (confirm !== 'CONFIRM') return interaction.reply({ content: '❌ You must type `CONFIRM` exactly to run this danger command.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      await resetGuildLayout(interaction.guild);

      const preset = interaction.options.getString('preset');
      const desc = interaction.options.getString('description');
      let layoutToApply = [];

      if (desc) {
        const parsed = parseLayoutDescription(desc);
        layoutToApply = parsed.layout;
      } else {
        layoutToApply = getBaddiesPreset();
      }

      await setupRoleLadder(interaction.guild);
      const res = await applyLayout(interaction.guild, layoutToApply);

      return interaction.editReply({ embeds: [embedBase('💥 Layout Reset Complete', `Wiped server channels/roles and applied layout!\nCreated ${res.createdChs.length} channels across ${res.createdCats.length} categories.`)] });
    }

  } catch (e) {
    console.error('Interaction error:', e);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply('❌ An error occurred while executing this command: ' + e.message);
      else await interaction.reply({ content: '❌ An error occurred while executing this command: ' + e.message, ephemeral: true });
    } catch {}
  }
});

// ---------- Express HTTP API Bridge (for Roblox) ----------
const app = express();
app.use(express.json());

// Auth middleware for Roblox endpoint
app.use((req, res, next) => {
  if (req.path === '/ping') return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/ping', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Roblox polling endpoint: game fetches commands & posts server/player stats
app.post('/api/bridge', (req, res) => {
  try {
    const { server, inventories, playerCache, pushValues, ackIds } = req.body || {};

    // Ack processed commands
    if (Array.isArray(ackIds)) {
      for (const id of ackIds) ackCommand(id);
    }

    // Update live server status
    if (server && server.jobId) {
      db.servers[server.jobId] = {
        placeId: server.placeId,
        jobId: server.jobId,
        players: server.players || [],
        at: Date.now()
      };
    }

    // Update player inventories & player cache
    if (inventories && typeof inventories === 'object') {
      for (const [rid, data] of Object.entries(inventories)) {
        db.inventories[rid] = Object.assign(db.inventories[rid] || {}, data, { at: Date.now() });
      }
    }
    if (playerCache && typeof playerCache === 'object') {
      for (const [rid, data] of Object.entries(playerCache)) {
        db.playerCache[rid] = Object.assign(db.playerCache[rid] || {}, data, { at: Date.now() });
      }
    }

    // Update live RAP values if pushed by game
    if (pushValues && typeof pushValues === 'object') {
      db.valuesCache.at = Date.now();
      db.valuesCache.byKey = pushValues;
    }

    save();

    // Fetch pending commands for Roblox
    const pendingCmds = takeCommandsForRoblox();
    return res.json({ success: true, commands: pendingCmds });
  } catch (e) {
    console.error('Bridge error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Roblox endpoint to confirm verification code
app.post('/api/verify', (req, res) => {
  try {
    const { code, robloxUsername, robloxId } = req.body || {};
    if (!code || !robloxId) return res.status(400).json({ error: 'Missing code or robloxId' });

    const rec = db.linkCodes[code];
    if (!rec) return res.status(404).json({ error: 'Invalid or expired code' });
    if (Date.now() > rec.expires) {
      delete db.linkCodes[code];
      save();
      return res.status(400).json({ error: 'Code expired' });
    }

    // Save link mapping
    db.links[rec.discordId] = { robloxUsername: robloxUsername || rec.robloxUsername, robloxId: String(robloxId), at: Date.now() };
    db.robloxToDiscord[String(robloxId)] = rec.discordId;
    delete db.linkCodes[code];
    save();

    // Assign verified role in Discord if configured
    if (db.settings.verifiedRoleId) {
      client.guilds.fetch(GUILD_ID).then(guild => {
        guild.members.fetch(rec.discordId).then(member => {
          member.roles.add(db.settings.verifiedRoleId).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    }

    return res.json({ success: true, discordId: rec.discordId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- Start Server & Bot ----------
app.listen(PORT, () => {
  console.log(`HTTP API Bridge running on port ${PORT}`);
});

client.login(TOKEN).then(async () => {
  await registerCommands();
}).catch(err => {
  console.error('Discord login failed:', err);
});
