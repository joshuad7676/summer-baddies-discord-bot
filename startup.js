/**
 * Clean startup — no runtime patching.
 * All fixes live directly in index.js / commands/*.js / src/*.js.
 * Run with: npm start  (package.json -> node index.js)
 * This file exists only for hosts that use `node startup.js`.
 */
require('./index.js');
