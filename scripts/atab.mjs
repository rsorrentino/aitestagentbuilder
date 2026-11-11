#!/usr/bin/env node
/**
 * AI Test Agent Builder — operations, the same on Windows, Linux and macOS.
 * Use it through the root package.json:
 *
 *   npm run setup                      development install (.env from .env.example)
 *   npm run setup -- --production --host atab.contoso.local --db postgresql://…
 *                                      production install: generated secrets, build, migrations
 *   npm run build                      build API and web UI
 *   npm run db:migrate                 apply database migrations
 *   npm start                          run API + web UI (production build) until Ctrl+C
 *   npm run dev                        run both with live reload
 *   npm run status                     are they answering?
 *   npm run service:install            start at boot (Windows service / systemd unit)
 *   npm run service:uninstall
 *
 * No dependencies: only Node.js built-ins, and child processes are started
 * without a shell.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const FRONTEND = join(ROOT, 'frontend');
const ENV_FILE = join(ROOT, '.env');
const IS_WINDOWS = process.platform === 'win32';
const NODE = process.execPath;

// ------------------------------------------------------------------ helpers

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const cyan = color(36);
const green = color(32);
const yellow = color(33);
const red = color(31);
const step = (msg) => console.log(cyan(`==> ${msg}`));

class UsageError extends Error {}
function fail(msg) {
  throw new UsageError(msg);
}

/** On/off options: never take the next word as their value. */
const FLAGS = new Set(['production', 'noAuth', 'noNssm', 'withE2e', 'withDeps', 'skipBuild', 'https']);

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    const name = key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (inline !== undefined) opts[name] = FLAGS.has(name) ? !/^(false|no|0)$/i.test(inline) : inline;
    else if (!FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[name] = argv[++i];
    else opts[name] = true;
  }
  return opts;
}

/** KEY=value pairs of .env (comments and blank lines ignored). */
export function readEnvFile(file = ENV_FILE) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Path of npm's JavaScript entry point, so npm runs through node without a shell (npm.cmd on Windows). */
function npmCli() {
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) return process.env.npm_execpath;
  const candidates = [
    join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    join(dirname(NODE), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux/macOS
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) fail('Cannot find npm next to Node.js; reinstall Node.js with npm included');
  return found;
}

/** Run a command to completion, inheriting output; throws on failure. */
function run(command, args, { cwd = ROOT, env = {}, what } = {}) {
  const res = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  if (res.error) fail(`${what ?? command} could not start: ${res.error.message}`);
  if (res.status !== 0) fail(`${what ?? command} failed (exit code ${res.status})`);
}
const npm = (args, opts = {}) => run(NODE, [npmCli(), ...args], { what: `npm ${args.join(' ')}`, ...opts });

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 19);
}

function secret(bytes = 32) {
  return randomBytes(bytes).toString('base64');
}

function password() {
  // Meets the password policy: upper, lower, digit and symbol, 20 characters.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return 'Aa1!' + Array.from(randomBytes(16), (b) => chars[b % chars.length]).join('');
}

/** Restrict a file to its owner (POSIX) or Administrators, SYSTEM and the current user (Windows). */
function restrictFile(file) {
  if (IS_WINDOWS) {
    const user = process.env.USERNAME ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}` : null;
    const grants = ['*S-1-5-32-544:F', '*S-1-5-18:F', ...(user ? [`${user}:F`] : [])];
    const res = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', ...grants], { stdio: 'ignore', windowsHide: true });
    if (res.status !== 0) console.warn(yellow(`    Could not restrict access to ${file}; limit it to administrators and the service account.`));
  } else {
    chmodSync(file, 0o600);
  }
}

function urls(env) {
  const apiPort = Number(env.PORT || 3000);
  const uiPort = Number(env.UI_PORT || 4000);
  return {
    apiPort,
    uiPort,
    health: `http://127.0.0.1:${apiPort}/health/ready`,
    ui: `http://127.0.0.1:${uiPort}`,
  };
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ------------------------------------------------------------------ setup

export function productionEnv(opts) {
  const host = opts.host || (IS_WINDOWS ? (process.env.COMPUTERNAME || 'localhost').toLowerCase() : 'localhost');
  const apiPort = Number(opts.apiPort || 3000);
  const uiPort = Number(opts.uiPort || 4000);
  const scheme = opts.https ? 'https' : 'http';
  const publicApi = opts.publicUrl ? `${String(opts.publicUrl).replace(/\/+$/, '')}` : `${scheme}://${host}:${apiPort}`;
  const publicUi = opts.publicUiUrl ? String(opts.publicUiUrl).replace(/\/+$/, '') : `${scheme}://${host}:${uiPort}`;
  const adminPassword = password();
  const content = `# AI Test Agent Builder — generated by "npm run setup -- --production" on ${new Date().toISOString()}
NODE_ENV=production
PORT=${apiPort}
UI_PORT=${uiPort}
DATABASE_URL=${opts.db || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder'}

AUTH_ENABLED=${opts.noAuth ? 'false' : 'true'}
JWT_SECRET=${secret(48)}
# Keep this key with your backups: without it stored credentials cannot be decrypted.
SECRETS_ENCRYPTION_KEY=${secret(32)}
ADMIN_EMAIL=${opts.adminEmail || 'admin@example.com'}
ADMIN_PASSWORD=${adminPassword}

# Browsers live inside the installation so a service account can use them
PLAYWRIGHT_BROWSERS_PATH=${join(ROOT, '.playwright-browsers')}
CORS_ORIGIN=${publicUi},http://localhost:${uiPort}
LOG_TO_FILE=true

# Compiled into the web UI by "npm run build"
NEXT_PUBLIC_API_URL=${publicApi}/api/v1
NEXT_PUBLIC_WS_URL=${publicApi}

# AI providers (optional)
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# COPILOT_MODE=api
# GITHUB_TOKEN=
`;
  return { content, adminPassword, adminEmail: opts.adminEmail || 'admin@example.com', publicUi };
}

async function setup(opts) {
  step('Checking Node.js');
  if (!nodeVersionOk()) fail(`Node.js 20.19+ is required (found ${process.versions.node}); Node.js 22 LTS is recommended`);
  console.log(`    Node.js ${process.versions.node} (${NODE})`);

  if (existsSync(ENV_FILE)) {
    step('.env exists - keeping it');
  } else if (opts.production) {
    step('Creating .env for production (generated secrets)');
    const env = productionEnv(opts);
    writeFileSync(ENV_FILE, env.content, { mode: 0o600 });
    restrictFile(ENV_FILE);
    console.log(yellow(`\n    Administrator: ${env.adminEmail}`));
    console.log(yellow(`    Password:      ${env.adminPassword}   (shown once - change it after the first login)\n`));
  } else {
    step('Creating .env from .env.example');
    copyFileSync(join(ROOT, '.env.example'), ENV_FILE);
  }
  const env = readEnvFile();

  step('Installing API dependencies');
  npm(['ci', '--no-audit', '--no-fund'], { cwd: BACKEND });
  step(`Installing Chromium${env.PLAYWRIGHT_BROWSERS_PATH ? ` into ${env.PLAYWRIGHT_BROWSERS_PATH}` : ''}`);
  run(NODE, [join(BACKEND, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium', ...(!IS_WINDOWS && opts.withDeps ? ['--with-deps'] : [])], {
    cwd: BACKEND,
    env: env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH } : {},
    what: 'playwright install chromium',
  });
  step('Installing web UI dependencies');
  npm(['ci', '--no-audit', '--no-fund'], { cwd: FRONTEND });
  if (opts.withE2e) {
    step('Installing end-to-end test dependencies');
    npm(['ci', '--no-audit', '--no-fund'], { cwd: join(ROOT, 'e2e') });
  }

  const production = env.NODE_ENV === 'production' || opts.production;
  if (production && !opts.skipBuild) await build();
  try {
    await migrate();
  } catch (error) {
    if (production) throw error;
    console.warn(yellow(`    ${error.message}\n    Start PostgreSQL and run "npm run db:migrate" (the API also migrates when it starts).`));
  }

  console.log(green('\nSetup complete.'));
  if (production) {
    console.log(`  Run now:          npm start`);
    console.log(`  Start at boot:    npm run service:install   (as administrator / root)`);
    console.log(`  Web UI:           ${env.CORS_ORIGIN?.split(',')[0] || `http://localhost:${env.UI_PORT || 4000}`}`);
  } else {
    console.log('  Run with live reload:  npm run dev');
    console.log('  Then open http://localhost:4000 and click "Try the demo".');
  }
}

// ------------------------------------------------------------------ build / migrate

async function build() {
  const env = readEnvFile();
  step('Building the API');
  npm(['run', 'build'], { cwd: BACKEND });
  const apiUrl = env.NEXT_PUBLIC_API_URL || `http://localhost:${env.PORT || 3000}/api/v1`;
  step(`Building the web UI (API at ${apiUrl})`);
  npm(['run', 'build'], {
    cwd: FRONTEND,
    env: {
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_PUBLIC_WS_URL: env.NEXT_PUBLIC_WS_URL || apiUrl.replace(/\/api\/v\d+\/?$/, ''),
      NEXT_TELEMETRY_DISABLED: '1',
      // next build must not see the API's NODE_ENV from a shell; it sets its own
      NODE_ENV: 'production',
    },
  });
}

async function migrate() {
  step('Migrating the database');
  const built = join(BACKEND, 'dist', 'infra', 'db', 'migrate.js');
  if (existsSync(built)) run(NODE, [built], { cwd: BACKEND, what: 'database migration (is PostgreSQL running and DATABASE_URL right?)' });
  else run(NODE, [join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/infra/db/migrate.ts'], { cwd: BACKEND, what: 'database migration (is PostgreSQL running and DATABASE_URL right?)' });
}

// ------------------------------------------------------------------ start / dev

/** Run API and web UI side by side; stop both when either stops or on Ctrl+C. */
async function supervise(mode) {
  const env = readEnvFile();
  const { uiPort, health, ui } = urls(env);
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (childEnv[k] === undefined) childEnv[k] = v;

  let apps;
  if (mode === 'start') {
    const api = join(BACKEND, 'dist', 'index.js');
    if (!existsSync(api) || !existsSync(join(FRONTEND, '.next', 'BUILD_ID'))) fail('Not built yet: run "npm run build" (or "npm run setup -- --production")');
    apps = [
      { name: 'api', cwd: BACKEND, args: [api], env: childEnv },
      { name: 'ui', cwd: FRONTEND, args: [join(FRONTEND, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(uiPort)], env: { ...childEnv, NODE_ENV: 'production' } },
    ];
  } else {
    const apiUrl = env.NEXT_PUBLIC_API_URL || `http://localhost:${env.PORT || 3000}/api/v1`;
    apps = [
      { name: 'api', cwd: BACKEND, args: [join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'src/index.ts'], env: { ...childEnv, NODE_ENV: env.NODE_ENV === 'production' ? 'development' : childEnv.NODE_ENV } },
      { name: 'ui', cwd: FRONTEND, args: [join(FRONTEND, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(uiPort)], env: { ...childEnv, NODE_ENV: 'development', NEXT_PUBLIC_API_URL: apiUrl } },
    ];
  }

  let stopping = false;
  const children = apps.map((app) => {
    const child = spawn(NODE, app.args, { cwd: app.cwd, env: app.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const tag = app.name === 'api' ? cyan('[api]') : green('[ui] ');
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => console.log(`${tag} ${line}`));
    }
    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(red(`[${app.name}] stopped (${signal ?? `exit code ${code}`}) - stopping everything`));
      shutdown(1);
    });
    return child;
  });

  // A child killed by a signal has exitCode null but signalCode set.
  const alive = (c) => c.exitCode === null && c.signalCode === null;
  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const c of children) if (alive(c)) c.kill(IS_WINDOWS ? undefined : 'SIGTERM');
    // Give the API a moment to finish in-flight work, then make sure everything is gone.
    const force = setTimeout(() => {
      for (const c of children) if (alive(c)) c.kill('SIGKILL');
      process.exit(code);
    }, 10_000);
    Promise.all(children.map((c) => (alive(c) ? new Promise((r) => c.on('exit', r)) : null))).then(() => {
      clearTimeout(force);
      process.exit(code);
    });
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => shutdown(0)); } catch { /* signal not supported on this platform */ }
  }

  const [apiUp, uiUp] = await Promise.all([waitFor(health, 180_000), waitFor(ui, 180_000)]);
  if (stopping) return;
  if (apiUp && uiUp) {
    console.log(green(`\nReady: web UI http://localhost:${uiPort} | API http://localhost:${env.PORT || 3000}/api/docs | Ctrl+C to stop\n`));
  } else {
    console.error(red(`\n${apiUp ? 'web UI' : 'API'} did not answer within 3 minutes - see the [${apiUp ? 'ui' : 'api'}] lines above`));
  }
}

// ------------------------------------------------------------------ status

async function status() {
  const env = readEnvFile();
  const { health, ui } = urls(env);
  const [apiUp, uiUp] = await Promise.all([waitFor(health, 1), waitFor(ui, 1)]);
  console.log(`API     ${health}  ${apiUp ? green('up') : red('down')}`);
  console.log(`Web UI  ${ui}  ${uiUp ? green('up') : red('down')}`);
  if (!apiUp || !uiUp) process.exitCode = 1;
}

// ------------------------------------------------------------------ service

function serviceInstall(opts, remove = false) {
  if (IS_WINDOWS) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'windows', 'install-service.ps1')];
    if (remove) args.push('-Remove');
    if (opts.noNssm) args.push('-NoNssm');
    if (opts.nssm) args.push('-NssmPath', String(opts.nssm));
    if (opts.user) args.push('-User', String(opts.user));
    if (opts.password) args.push('-Password', String(opts.password));
    run('powershell.exe', args, { what: 'install-service.ps1 (run this from an elevated prompt)' });
    return;
  }
  if (process.platform !== 'linux') fail('service:install supports Windows and Linux (systemd); on macOS use launchd with "npm start"');
  const unitFile = '/etc/systemd/system/atab.service';
  if (remove) {
    spawnSync('systemctl', ['disable', '--now', 'atab'], { stdio: 'inherit' });
    spawnSync('rm', ['-f', unitFile], { stdio: 'inherit' });
    spawnSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
    console.log('Removed.');
    return;
  }
  if (process.getuid?.() !== 0) fail('Run as root: sudo npm run service:install -- --user <account that owns the installation>');
  const user = opts.user || process.env.SUDO_USER || 'root';
  const unit = `[Unit]
Description=AI Test Agent Builder (API + web UI)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${ROOT}
ExecStart=${NODE} ${join(ROOT, 'scripts', 'atab.mjs')} start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;
  writeFileSync(unitFile, unit);
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', '--now', 'atab']);
  console.log(green(`Installed ${unitFile} (runs as ${user}). Logs: journalctl -u atab -f`));
}

// ------------------------------------------------------------------ main

const COMMANDS = {
  setup: (o) => setup(o),
  build: () => build(),
  migrate: () => migrate(),
  start: () => supervise('start'),
  dev: () => supervise('dev'),
  status: () => status(),
  'service:install': (o) => serviceInstall(o),
  'service:uninstall': (o) => serviceInstall(o, true),
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Usage: node scripts/atab.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  Promise.resolve(handler(parseArgs(rest))).catch((error) => {
    console.error(red(`ERROR: ${error.message}`));
    process.exit(1);
  });
}
