// VS Code scopes its API object to the importing extension. A harness outside the
// unpacked VSIX must use that extension's API for picker/notification automation.
const { createRequire } = require('node:module');
const { join } = require('node:path');
module.exports = createRequire(join(process.env.CO_EXTENSION_ROOT, 'package.json'))('vscode');
