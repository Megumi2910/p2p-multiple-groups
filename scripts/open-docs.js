#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const docsIndexPath = resolve(__dirname, '../docs/index.html');

if (!existsSync(docsIndexPath)) {
  console.error(`[Docs] Documentation portal not found at ${docsIndexPath}`);
  process.exit(1);
}

const docsFileUrl = pathToFileURL(docsIndexPath).href;

console.log(`[Docs] Opening Interactive Documentation Suite:`);
console.log(`  File: ${docsIndexPath}`);
console.log(`  URL:  ${docsFileUrl}`);

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log(`[Docs] Dry run mode enabled. Verified docs entrypoint.`);
  process.exit(0);
}

const platform = process.platform;
let cmd;
let args;

if (platform === 'win32') {
  cmd = 'cmd.exe';
  args = ['/c', 'start', '""', docsFileUrl];
} else if (platform === 'darwin') {
  cmd = 'open';
  args = [docsFileUrl];
} else {
  cmd = 'xdg-open';
  args = [docsFileUrl];
}

const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
child.on('error', (err) => {
  console.warn(`[Docs] Could not launch default browser automatically: ${err.message}`);
  console.info(`[Docs] Please open ${docsFileUrl} directly in your browser.`);
});
child.unref();
