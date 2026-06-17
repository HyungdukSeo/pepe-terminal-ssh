const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const cacheDir = path.join(projectRoot, '.cache', 'electron-builder');
const tempOutputDir = path.join(projectRoot, '.cache', 'electron-builder-output');
const finalOutputDir = path.join(projectRoot, 'release');

fs.mkdirSync(cacheDir, { recursive: true });
fs.rmSync(tempOutputDir, { recursive: true, force: true });
fs.mkdirSync(tempOutputDir, { recursive: true });

const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: cacheDir,
};

const cliPath = require.resolve('electron-builder/out/cli/cli.js');
const args = ['--config.directories.output=' + tempOutputDir, ...process.argv.slice(2)];
if (process.env.SKIP_SIGN && process.env.SKIP_SIGN !== '0') {
  console.log('[run-electron-builder] SKIP_SIGN enabled: disabling Windows code signing');
  args.push('--config.win.sign=false');
}
const result = spawnSync(process.execPath, [cliPath, ...args], {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if ((result.status ?? 1) === 0) {
  try {
    fs.rmSync(finalOutputDir, { recursive: true, force: true });
    fs.cpSync(tempOutputDir, finalOutputDir, { recursive: true });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

process.exit(result.status ?? 1);
