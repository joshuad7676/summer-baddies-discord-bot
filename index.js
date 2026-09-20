const fs = require('fs');
const path = require('path');

// Recovery bootstrap: index.js was accidentally replaced by the startup patch.
// Restore the last complete bot source before loading it.
const restoredPath = path.join(__dirname, '.index-restored.js');
const sourceUrl = 'https://raw.githubusercontent.com/joshuad7676/summer-baddies-discord-bot/03fd8eeb7d4d4c6e2d1ef758ef960e00eed6bdab/index.js';

(async () => {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`restore download failed: HTTP ${response.status}`);
    const source = await response.text();
    if (!source.includes("require('discord.js')") || !source.includes('registerCommands')) {
      throw new Error('downloaded source failed validation');
    }
    fs.writeFileSync(restoredPath, source);
    require(restoredPath);
  } catch (error) {
    console.error('[startup] Could not restore bot source:', error.message);
    process.exitCode = 1;
  }
})();
