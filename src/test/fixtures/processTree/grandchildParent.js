// Spawns a stubborn grandchild that records its pid and ignores POSIX SIGTERM.
// The parent keeps the default signal behavior, so it exits before the force
// phase while the supervisor must still find and terminate the descendant.
const { spawn } = require('child_process');
const pidFile = process.argv[2];
const child = spawn(process.execPath, ['-e', `
  require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  if (process.platform !== 'win32') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
`], { stdio: 'ignore' });
setInterval(() => {}, 1000);
