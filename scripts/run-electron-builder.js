const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const cacheDir = path.join(projectRoot, '.cache', 'electron-builder');

fs.mkdirSync(cacheDir, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: cacheDir,
};

const cliPath = require.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
