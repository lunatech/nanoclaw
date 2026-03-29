import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const builtinCommands = {
  auth: ['tsx', 'src/whatsapp-auth.ts'],
  build: ['tsc'],
  dev: ['tsx', 'src/index.ts'],
  format: ['prettier', '--write', 'src/**/*.ts'],
  'format:check': ['prettier', '--check', 'src/**/*.ts'],
  'format:fix': ['prettier', '--write', 'src/**/*.ts'],
  lint: ['eslint', 'src/'],
  'lint:fix': ['eslint', 'src/', '--fix'],
  prepare: ['husky'],
  setup: ['tsx', 'setup/index.ts'],
  start: ['node', 'dist/index.js'],
  test: ['vitest', 'run'],
  'test:watch': ['vitest'],
  typecheck: ['tsc', '--noEmit'],
};

async function loadOverrides() {
  const overridePath = path.resolve('scripts/package-script.local.mjs');
  if (!existsSync(overridePath)) return {};
  const module = await import(pathToFileURL(overridePath).href);
  return module.commands && typeof module.commands === 'object'
    ? module.commands
    : {};
}

async function main() {
  const scriptName = process.argv[2];
  const extraArgs = process.argv.slice(3);
  if (!scriptName) {
    console.error('Missing script name');
    process.exit(1);
  }

  const overrideCommands = await loadOverrides();
  const command = overrideCommands[scriptName] || builtinCommands[scriptName];
  if (!command) {
    console.error(`Unknown package script: ${scriptName}`);
    process.exit(1);
  }

  const commandArgs = Array.isArray(command) ? [...command] : [String(command)];
  const child =
    commandArgs[0] === 'node'
      ? spawn(commandArgs[0], [...commandArgs.slice(1), ...extraArgs], {
          stdio: 'inherit',
          env: process.env,
        })
      : spawn(
          'npm',
          ['exec', '--', commandArgs[0], ...commandArgs.slice(1), ...extraArgs],
          {
            stdio: 'inherit',
            env: process.env,
          },
        );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
