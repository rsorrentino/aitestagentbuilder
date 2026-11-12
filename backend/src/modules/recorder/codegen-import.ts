/**
 * Import of scripts recorded with `npx playwright codegen` (JavaScript /
 * TypeScript or Python) as test case steps.
 *
 * Supported: goto, click/dblclick, fill, press, check/uncheck, selectOption,
 * hover and the common expect assertions, on page.locator / getByRole /
 * getByText / getByLabel / getByPlaceholder / getByTestId / getByTitle /
 * getByAltText, chained, with first() / last() / nth(). Anything else is
 * reported as skipped with its line, never guessed.
 */

export interface ImportedStep {
  action: string;
  target?: string;
  data?: Record<string, any>;
}

export interface ImportResult {
  steps: ImportedStep[];
  skipped: Array<{ line: number; code: string; reason: string }>;
  warnings: string[];
  language: 'javascript' | 'python';
}

const q = (s: string) => JSON.stringify(s);

/** Read a JS/Python string literal starting at text[0] (', " or `). */
function readString(text: string): { value: string; rest: string } | null {
  const quote = text[0];
  if (!['"', "'", '`'].includes(quote)) return null;
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i++;
    } else if (c === quote) {
      return { value, rest: text.slice(i + 1) };
    } else {
      value += c;
    }
  }
  return null;
}

/** Split the arguments of a call (top level commas only), returning the text after ')'. */
function readArgs(text: string): { args: string[]; rest: string } | null {
  if (text[0] !== '(') return null;
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const s = readString(text.slice(i));
      if (!s) return null;
      const consumed = text.length - i - s.rest.length;
      cur += text.slice(i, i + consumed);
      i += consumed - 1;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) {
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return { args, rest: text.slice(i + 1) };
      }
      depth--;
    }
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return null;
}

const str = (arg?: string): string | undefined => {
  if (!arg) return undefined;
  const s = readString(arg.trim());
  return s && !s.rest.trim() ? s.value : undefined;
};

/** Options such as { name: 'Sign in', exact: true } (JS) or name="Sign in", exact=True (Python kwargs). */
function readOptions(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of args) {
    const body = arg.trim().startsWith('{') ? arg.trim().slice(1, -1) : arg;
    for (const m of body.matchAll(/(\w+)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|True|False)/g)) {
      out[m[1]] = /^(true|True)$/.test(m[2]) ? true : /^(false|False)$/.test(m[2]) ? false : str(m[2]) ?? '';
    }
  }
  return out;
}

const LOCATOR_METHODS: Record<string, (args: string[]) => string | null> = {
  locator: (a) => str(a[0]) ?? null,
  getByRole: (a) => {
    const role = str(a[0]);
    if (!role) return null;
    const o = readOptions(a.slice(1));
    return typeof o.name === 'string' ? `role=${role}[name=${q(o.name)}${o.exact ? 's' : 'i'}]` : `role=${role}`;
  },
  getByText: (a) => (str(a[0]) !== undefined ? `text=${readOptions(a.slice(1)).exact ? q(str(a[0])!) : str(a[0])}` : null),
  getByLabel: (a) => (str(a[0]) !== undefined ? `internal:label=${q(str(a[0])!)}${readOptions(a.slice(1)).exact ? 's' : 'i'}` : null),
  getByPlaceholder: (a) => (str(a[0]) !== undefined ? `[placeholder=${q(str(a[0])!)}]` : null),
  getByTestId: (a) => (str(a[0]) !== undefined ? `[data-testid=${q(str(a[0])!)}]` : null),
  getByTitle: (a) => (str(a[0]) !== undefined ? `[title=${q(str(a[0])!)}]` : null),
  getByAltText: (a) => (str(a[0]) !== undefined ? `[alt=${q(str(a[0])!)}]` : null),
};

const PY_TO_JS: Record<string, string> = {
  get_by_role: 'getByRole', get_by_text: 'getByText', get_by_label: 'getByLabel', get_by_placeholder: 'getByPlaceholder',
  get_by_test_id: 'getByTestId', get_by_title: 'getByTitle', get_by_alt_text: 'getByAltText', select_option: 'selectOption',
  to_be_visible: 'toBeVisible', to_be_hidden: 'toBeHidden', to_have_text: 'toHaveText', to_contain_text: 'toContainText',
  to_have_url: 'toHaveURL', to_have_title: 'toHaveTitle', to_have_value: 'toHaveValue', to_be_checked: 'toBeChecked', dblclick: 'dblclick',
};

interface Chain { selector: string | null; calls: Array<{ name: string; args: string[] }> }

/** Parse `page.getByRole(...).first().click()` into the locator selector and the trailing calls. */
function parseChain(expr: string): Chain | null {
  let text = expr.trim().replace(/^await\s+/, '');
  const m = text.match(/^(page\d*|[a-z]\w*Page)\b/);
  if (!m) return null;
  text = text.slice(m[0].length);
  const parts: string[] = [];
  const calls: Chain['calls'] = [];
  let locatorDone = false;
  while (text.startsWith('.')) {
    const nm = text.match(/^\.(\w+)/);
    if (!nm) return null;
    const name = PY_TO_JS[nm[1]] ?? nm[1];
    text = text.slice(nm[0].length);
    const call = readArgs(text);
    if (!call) {
      // property such as .keyboard
      calls.push({ name, args: [] });
      continue;
    }
    text = call.rest;
    if (!locatorDone && LOCATOR_METHODS[name]) {
      const sel = LOCATOR_METHODS[name](call.args);
      if (sel === null) return null;
      parts.push(sel);
    } else if (!locatorDone && name === 'first') parts.push('nth=0');
    else if (!locatorDone && name === 'last') parts.push('nth=-1');
    else if (!locatorDone && name === 'nth') parts.push(`nth=${Number(call.args[0])}`);
    else {
      locatorDone = true;
      calls.push({ name, args: call.args });
    }
  }
  return { selector: parts.length ? parts.join(' >> ') : null, calls };
}

const SECRET_HINT = /pass(word)?|pwd|secret|token|otp|pin\b/i;

export function importCodegen(script: string, opts: { baseUrl?: string } = {}): ImportResult {
  const language: ImportResult['language'] = /^\s*(def |from playwright|import re\b)|\bget_by_\w+\(/m.test(script) ? 'python' : 'javascript';
  const steps: ImportedStep[] = [];
  const skipped: ImportResult['skipped'] = [];
  const warnings: string[] = [];
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  let secretCount = 0;

  // URLs of the agent become paths: "/x" when the base URL is a site root, "x" when it has a path (relative to it)
  const basePath = (() => { try { return new URL(base).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
  const relative = (url: string) => {
    if (!base || !(url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`))) return url;
    const rest = url.slice(base.length) || '/';
    return basePath && rest.startsWith('/') ? rest.slice(1) || './' : rest;
  };
  const urlPath = (url: string) => (base && url.startsWith(base) ? url.slice(base.length) || '/' : url);

  script.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/;\s*$/, '');
    if (!line || /^(\/\/|#|import |from |const |let |var |test\(|def |with |}|\)|browser|context|async |await (browser|context)\b|(browser|context)\s*=|return\b|run\(|asyncio|playwright\.|expect\.set_options)/.test(line) || /^\w+\s*=\s*(await\s+)?(context|browser|playwright)\b/.test(line)) return;
    const skip = (reason: string) => skipped.push({ line: i + 1, code: line.slice(0, 200), reason });

    // expect(...).toX(...)  /  expect(...).not.toX(...)
    const ex = line.replace(/^await\s+/, '').match(/^expect\((.*)\)\.(not\.|not_)?(\w+)(\(.*\))$/);
    if (ex) {
      const negate = !!ex[2];
      const assertion = PY_TO_JS[ex[3]] ?? ex[3];
      const args = readArgs(ex[4])?.args ?? [];
      const subject = ex[1].trim();
      if (/^page\d*$/.test(subject)) {
        const value = str(args[0]);
        if (assertion === 'toHaveURL' && value !== undefined && !negate) return void steps.push({ action: 'assert_url', data: { value: urlPath(value) } });
        if (assertion === 'toHaveTitle' && value !== undefined && !negate) return void steps.push({ action: 'assert_title', data: { value } });
        return skip(value === undefined ? 'only plain string expectations are supported (not regular expressions)' : `unsupported page assertion ${assertion}`);
      }
      const chain = parseChain(subject);
      if (!chain?.selector || chain.calls.length) return skip('unsupported locator');
      const target = chain.selector;
      if ((assertion === 'toBeVisible' && !negate) || (assertion === 'toBeHidden' && negate)) return void steps.push({ action: 'assert_visible', target });
      if ((assertion === 'toBeVisible' && negate) || (assertion === 'toBeHidden' && !negate)) return void steps.push({ action: 'assert_not_visible', target });
      if (['toHaveText', 'toContainText', 'toHaveValue'].includes(assertion) && !negate) {
        const value = str(args[0]);
        if (value === undefined) return skip('only plain string expectations are supported (not regular expressions or arrays)');
        return void steps.push({ action: 'assert_text', target, data: { value } });
      }
      return skip(`unsupported assertion ${negate ? 'not.' : ''}${assertion}`);
    }

    const chain = parseChain(line);
    if (!chain) return skip('not a page action');
    const last = chain.calls[chain.calls.length - 1];
    if (!last) return skip('no action');
    const target = chain.selector ?? undefined;
    const value = str(last.args[0]);

    if (!target) {
      if (last.name === 'goto' && value !== undefined) return void steps.push({ action: 'navigate', target: relative(value) });
      if (chain.calls[0]?.name === 'keyboard' && last.name === 'press' && value) return void steps.push({ action: 'press', data: { value } });
      if (last.name === 'waitForTimeout' || last.name === 'wait_for_timeout') return void steps.push({ action: 'wait', data: { ms: Number(last.args[0]) || 1000 } });
      if (last.name === 'close') return;
      return skip(`unsupported page call ${last.name}`);
    }

    switch (last.name) {
      case 'click':
      case 'dblclick':
      case 'tap':
        return void steps.push({ action: 'click', target });
      case 'fill':
      case 'type':
      case 'pressSequentially':
      case 'press_sequentially': {
        if (value === undefined) return skip('fill needs a plain string value');
        if (value && SECRET_HINT.test(target)) {
          const name = secretCount++ === 0 ? 'PASSWORD' : `PASSWORD_${secretCount}`;
          warnings.push(`Line ${i + 1}: the value typed into ${target} was replaced by {{secrets.${name}}}: add a secret named ${name} to the agent`);
          return void steps.push({ action: 'fill', target, data: { value: `{{secrets.${name}}}` } });
        }
        return void steps.push({ action: 'fill', target, data: { value } });
      }
      case 'press':
        return void steps.push({ action: 'press', target, data: { value: value ?? 'Enter' } });
      case 'check':
      case 'uncheck':
      case 'hover':
        return void steps.push({ action: last.name, target });
      case 'selectOption': {
        const v = value ?? str((last.args[0] ?? '').replace(/^\[|\]$/g, '').split(',')[0]);
        if (v === undefined) return skip('selectOption needs a plain string value');
        return void steps.push({ action: 'select', target, data: { value: v } });
      }
      case 'setChecked':
      case 'set_checked':
        return void steps.push({ action: /true|True/.test(last.args[0] ?? '') ? 'check' : 'uncheck', target });
      default:
        return skip(`unsupported action ${last.name}`);
    }
  });

  if (!steps.length) warnings.push('No steps were recognised: paste the script that `npx playwright codegen` produced');
  return { steps, skipped, warnings, language };
}
