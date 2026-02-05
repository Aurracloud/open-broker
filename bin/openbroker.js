#!/usr/bin/env node

// This wrapper uses tsx to run the TypeScript CLI
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.join(__dirname, 'cli.ts');

// Run the TypeScript CLI with tsx
const child = spawn(
  process.execPath,
  ['--import', 'tsx', cliPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
