/**
 * Resolve a command to something child_process.spawn can start without a
 * shell, on Linux, macOS and Windows.
 *
 * On Windows, npm installs CLIs (e.g. the GitHub Copilot CLI) as `.cmd`
 * shims. Node refuses to spawn `.cmd`/`.bat` files without `shell: true`,
 * and a shell would re-parse the arguments — unsafe when they carry an AI
 * prompt. Instead we read the shim, find the JavaScript entry point it runs
 * and start that with the current Node executable.
 */

import { existsSync, readFileSync } from 'fs';
import path, { delimiter, extname, isAbsolute, join, resolve } from 'path';

export interface ResolvedCommand {
  command: string;
  args: string[];
}

/** Windows: max command line is 32,767 characters, leave room for the executable and flags. */
export const MAX_ARGS_LENGTH = process.platform === 'win32' ? 30_000 : 120_000;

function windowsExtensions(): string[] {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return ['', ...exts];
}

/** Full path of a command found on PATH (honouring PATHEXT on Windows), or null. */
export function findOnPath(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = platform === 'win32' ? windowsExtensions() : [''];
  const candidates = (base: string) => exts.map((ext) => (ext && extname(base).toLowerCase() !== ext ? base + ext : base));
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return candidates(resolve(command)).find((c) => existsSync(c)) ?? null;
  }
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    const hit = candidates(join(dir, command)).find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

/** JavaScript entry point of an npm `.cmd` shim, e.g. "%dp0%\node_modules\@github\copilot\index.js". */
export function scriptFromCmdShim(shimPath: string, content = readFileSync(shimPath, 'utf8')): string | null {
  const match = content.match(/"%~?dp0%?\\?([^"%]+?\.(?:js|mjs|cjs))"/i);
  if (!match) return null;
  const p = /^[A-Za-z]:[\\/]|\\/.test(shimPath) ? path.win32 : path;
  return p.join(p.dirname(shimPath), ...match[1].split(/[\\/]+/).filter(Boolean));
}

/**
 * How to spawn `command args…` without a shell. Throws with a clear message
 * when a Windows batch file cannot be started safely.
 */
export function resolveCommand(command: string, args: string[], platform: NodeJS.Platform = process.platform): ResolvedCommand {
  if (platform !== 'win32') return { command, args };
  const found = findOnPath(command, platform);
  if (!found) return { command, args }; // spawn reports ENOENT
  const ext = extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const script = scriptFromCmdShim(found);
    if (!script || !existsSync(script)) {
      throw new Error(`${found} is a batch file that cannot be started safely; set the path of the program's .exe or .js file instead`);
    }
    return { command: process.execPath, args: [script, ...args] };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: process.execPath, args: [found, ...args] };
  return { command: found, args };
}
