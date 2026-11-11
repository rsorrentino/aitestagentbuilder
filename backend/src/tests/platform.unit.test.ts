/**
 * Cross-platform process launching (Windows .cmd shims, PATHEXT): `npm test`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findOnPath, resolveCommand, scriptFromCmdShim } from '../infra/process/resolve-command.js';

// The shim npm writes for a global CLI on Windows (npm 10, cmd-shim)
const NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\index.js" %*\r
`;

describe('cross-platform command launching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atab-cmd-'));
  const shim = join(dir, 'copilot.cmd');
  writeFileSync(shim, NPM_SHIM);
  mkdirSync(join(dir, 'node_modules', '@github', 'copilot'), { recursive: true });
  const entry = join(dir, 'node_modules', '@github', 'copilot', 'index.js');
  writeFileSync(entry, 'console.log("hi")');

  it('finds the JavaScript entry point of an npm .cmd shim', () => {
    assert.equal(scriptFromCmdShim(shim), entry);
    assert.equal(scriptFromCmdShim('C:\\x\\tool.cmd', '@node "%~dp0\\lib\\cli.mjs" %*'), 'C:\\x\\lib\\cli.mjs');
    assert.equal(scriptFromCmdShim(shim, '@echo off\r\nsomething.exe %*'), null);
  });

  it('honours PATHEXT on Windows when searching PATH', () => {
    const env = { PATH: `C:\\nowhere;${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findOnPath('copilot', 'win32', env), shim);
    assert.equal(findOnPath('copilot', 'linux', { PATH: dir }), null, 'no extension guessing on Linux');
    assert.equal(findOnPath('missing-tool', 'win32', env), null);
  });

  it('starts .cmd shims through node, never through a shell', () => {
    const launch = resolveCommand(shim, ['-p', 'prompt with "quotes" & ampersands | pipes'], 'win32');
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [entry, '-p', 'prompt with "quotes" & ampersands | pipes']);
  });

  it('refuses batch files it cannot unwrap', () => {
    const bat = join(dir, 'other.bat');
    writeFileSync(bat, '@echo off\r\nrealtool.exe %*');
    assert.throws(() => resolveCommand(bat, [], 'win32'), /cannot be started safely/);
  });

  it('leaves commands alone on Linux and macOS', () => {
    assert.deepEqual(resolveCommand('copilot', ['-p', 'x'], 'linux'), { command: 'copilot', args: ['-p', 'x'] });
  });
});

describe('page outline for the AI (runs inside the browser)', () => {
  it('works when the backend runs through tsx (no compiler helpers in the page)', async () => {
    const { launchBrowser, outlinePage } = await import('../modules/execution/browser.js');
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(`<title>Shop</title><h1>Welcome</h1>
        <label for="q">Search</label><input id="q" name="q" placeholder="Find">
        <button data-testid="go">Go   now</button><a href="/cart">Cart</a><button style="display:none">Hidden</button>`);
      const outline = await outlinePage(page, 20);
      assert.match(outline, /^url: about:blank\n/);
      assert.match(outline, /title: Shop/);
      assert.match(outline, /h1: Welcome/);
      assert.match(outline, /input selector="#q"/);
      assert.match(outline, /button selector="\[data-testid="go"\]" text="Go now"/);
      assert.match(outline, /a selector="text=Cart" text="Cart" href="\/cart"/);
      assert.doesNotMatch(outline, /Hidden/);
    } finally {
      await browser.close();
    }
  });
});
