// Spawns a grandchild that records its pid file and loops forever.
const { spawn } = require('child_process');
const pidFile = process.argv[2];
const child = spawn(process.execPath, ['-e', `
  require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
