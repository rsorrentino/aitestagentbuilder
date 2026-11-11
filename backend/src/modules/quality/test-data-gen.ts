/**
 * Test data generation.
 *
 *  - `{{fake.<kind>}}` / `{{fake.<kind>:label}}` in steps: realistic fictitious
 *    values (Faker), one value per kind and label within a test, so a value
 *    typed in one step can be checked in a later one. Emails use example.*
 *    domains and cards are well-known test numbers: nothing reaches real people.
 *  - Data sets: a stored test data set ({ rows: [...] }) drives a test case
 *    (data.dataset): the test runs once per row and steps use `{{data.field}}`.
 *  - Generation of data sets from field kinds (Faker) or from a description (AI).
 *
 * Agent config: test_data: { locale: 'it', seed: 42 } — the seed makes values
 * reproducible (the same per test, row and persona in every run).
 */

import crypto from 'crypto';
import type { Faker } from '@faker-js/faker';

type Gen = (f: Faker) => string;

const TEST_CARDS = ['4111111111111111', '5555555555554444', '378282246310005', '4000056655665556'];
const two = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export const FAKE_KINDS: Record<string, { description: string; gen: Gen }> = {
  firstName: { description: 'First name', gen: (f) => f.person.firstName() },
  lastName: { description: 'Last name', gen: (f) => f.person.lastName() },
  fullName: { description: 'First and last name', gen: (f) => `${f.person.firstName()} ${f.person.lastName()}` },
  email: { description: 'Email at an example.com/.net/.org domain (never delivered)', gen: (f) => f.internet.exampleEmail().toLowerCase() },
  username: { description: 'User name', gen: (f) => f.internet.username().replace(/[^\w.-]/g, '').toLowerCase() },
  password: { description: 'Strong password (upper, lower, digit, symbol)', gen: (f) => `${f.internet.password({ length: 12, memorable: false, pattern: /[A-Za-z0-9]/ })}Aa1!` },
  phone: { description: 'Phone number in the locale format', gen: (f) => f.phone.number() },
  company: { description: 'Company name', gen: (f) => f.company.name() },
  jobTitle: { description: 'Job title', gen: (f) => f.person.jobTitle() },
  street: { description: 'Street address', gen: (f) => f.location.streetAddress() },
  city: { description: 'City', gen: (f) => f.location.city() },
  state: { description: 'State / region', gen: (f) => f.location.state() },
  zip: { description: 'Postal code', gen: (f) => f.location.zipCode() },
  country: { description: 'Country', gen: (f) => f.location.country() },
  countryCode: { description: 'ISO 3166 alpha-2 country code', gen: (f) => f.location.countryCode('alpha-2') },
  iban: { description: 'IBAN (valid format, fictitious)', gen: (f) => f.finance.iban() },
  testCard: { description: 'Well-known test card number (Visa, Mastercard, Amex)', gen: (f) => f.helpers.arrayElement(TEST_CARDS) },
  cvv: { description: 'Card security code', gen: (f) => f.finance.creditCardCVV() },
  expiry: { description: 'Card expiry MM/YY in the future', gen: (f) => { const d = f.date.future({ years: 4 }); return `${two(d.getMonth() + 1)}/${two(d.getFullYear() % 100)}`; } },
  uuid: { description: 'UUID', gen: (f) => f.string.uuid() },
  unique: { description: 'Short token unique to this test execution (ignores the seed): makes records unique across runs', gen: () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}` },
  number: { description: 'Whole number 1–1000', gen: (f) => String(f.number.int({ min: 1, max: 1000 })) },
  amount: { description: 'Amount with two decimals', gen: (f) => f.finance.amount({ min: 1, max: 5000, dec: 2 }) },
  date: { description: 'Future date YYYY-MM-DD', gen: (f) => isoDate(f.date.soon({ days: 90 })) },
  pastDate: { description: 'Past date YYYY-MM-DD', gen: (f) => isoDate(f.date.recent({ days: 365 })) },
  birthdate: { description: 'Birth date of an adult, YYYY-MM-DD', gen: (f) => isoDate(f.date.birthdate({ mode: 'age', min: 18, max: 80 })) },
  word: { description: 'One word', gen: (f) => f.lorem.word() },
  words: { description: 'A few words', gen: (f) => f.lorem.words(3) },
  sentence: { description: 'A sentence', gen: (f) => f.lorem.sentence() },
  paragraph: { description: 'A paragraph', gen: (f) => f.lorem.paragraph() },
  url: { description: 'URL at example.com', gen: (f) => `https://www.example.com/${f.lorem.slug(2)}` },
  color: { description: 'Color name', gen: (f) => f.color.human() },
};

export const LOCALE_RE = /^[a-z]{2,3}(_[A-Z]{2}|_[A-Za-z]+)?$/;

let fakerModule: Promise<typeof import('@faker-js/faker')> | null = null;
const loadFaker = () => (fakerModule ??= import('@faker-js/faker'));

/** A Faker instance for a locale (falls back to English for missing data). */
export async function createFaker(locale = 'en', seed?: number): Promise<Faker> {
  const { Faker, allLocales } = await loadFaker();
  const locales = allLocales as Record<string, any>;
  if (!LOCALE_RE.test(locale) || !locales[locale]) {
    throw new Error(`Unknown test data locale "${locale}" (e.g. en, en_US, it, de, fr, es, pt_BR)`);
  }
  const f = new Faker({ locale: [locales[locale], locales.en, locales.base] });
  if (seed !== undefined) f.seed(seed);
  return f;
}

/** Numeric seed for one test execution, derived from the configured seed. */
export function seedFor(seed: unknown, ...parts: Array<string | number | undefined>): number | undefined {
  if (seed === undefined || seed === null || seed === '') return undefined;
  const digest = crypto.createHash('sha256').update([String(seed), ...parts.map((p) => String(p ?? ''))].join('\u0000')).digest();
  return digest.readUInt32BE(0);
}

export function testDataSettings(config: any): { locale: string; seed?: unknown; environment?: string } {
  const td = config?.test_data ?? {};
  return {
    locale: typeof td.locale === 'string' && td.locale.trim() ? td.locale.trim() : 'en',
    ...(td.seed !== undefined && td.seed !== null && td.seed !== '' ? { seed: td.seed } : {}),
    ...(typeof td.environment === 'string' && td.environment ? { environment: td.environment } : {}),
  };
}

/** Fake values of one test execution: the same kind and label always give the same value. */
export class FakeValues {
  private values = new Map<string, string>();

  constructor(private faker: Faker) {}

  get(kind: string, label = ''): string {
    const spec = FAKE_KINDS[kind];
    if (!spec) throw new Error(`Unknown fake data kind "${kind}" — use one of: ${Object.keys(FAKE_KINDS).join(', ')}`);
    const key = label ? `${kind}:${label}` : kind;
    let v = this.values.get(key);
    if (v === undefined) {
      v = spec.gen(this.faker);
      this.values.set(key, v);
    }
    return v;
  }

  /** Values used so far (shown with the result). */
  used(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

/** Value at a dotted path of a data row; undefined when missing. */
export function rowValue(row: Record<string, any>, path: string): any {
  let cur: any = row;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export const MAX_DATASET_ROWS = 100;

/** Rows of a data set: data.rows when it is an array of objects, otherwise the object itself as one row. */
export function datasetRows(data: any): Array<Record<string, any>> {
  if (Array.isArray(data?.rows)) return data.rows.filter((r: any) => r && typeof r === 'object' && !Array.isArray(r));
  if (data && typeof data === 'object' && !Array.isArray(data)) return [data];
  return [];
}

/** Short label of a row for titles and reports. */
export function rowLabel(row: Record<string, any>, index: number): string {
  for (const key of ['_label', 'label', 'name', 'title', 'id']) {
    const v = row[key];
    // Placeholders ({{fake.firstName}}) make poor labels: they differ per run
    if (v !== undefined && v !== null && typeof v !== 'object' && String(v).trim() && !String(v).includes('{{')) return String(v).trim().slice(0, 60);
  }
  return `row ${index + 1}`;
}

/** Generate rows with Faker from { column: kind } (deterministic with a seed). */
export async function generateRows(fields: Record<string, string>, count: number, opts: { locale?: string; seed?: unknown } = {}): Promise<Array<Record<string, string>>> {
  const columns = Object.entries(fields ?? {});
  if (!columns.length) throw new Error('fields must map column names to fake data kinds, e.g. { "email": "email" }');
  for (const [col, kind] of columns) {
    if (!COLUMN_RE.test(col)) throw new Error(`Invalid column name "${col}" (letters, digits, underscore)`);
    if (!FAKE_KINDS[kind]) throw new Error(`Unknown fake data kind "${kind}" for column "${col}"`);
  }
  const n = clampCount(count);
  const faker = await createFaker(opts.locale ?? 'en', seedFor(opts.seed, 'generate'));
  return Array.from({ length: n }, () => {
    const values = new FakeValues(faker);
    return Object.fromEntries(columns.map(([col, kind]) => [col, values.get(kind, col)]));
  });
}

export const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const clampCount = (count: unknown) => Math.min(Math.max(Math.floor(Number(count) || 10), 1), MAX_DATASET_ROWS);

/** Keep only flat rows with safe column names and scalar values (AI output is untrusted). */
export function sanitizeRows(rows: unknown, max: number): Array<Record<string, string | number | boolean | null>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<Record<string, string | number | boolean | null>> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const clean: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row).slice(0, 50)) {
      if (!COLUMN_RE.test(k)) continue;
      if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) clean[k] = v as any;
      else if (typeof v === 'string') clean[k] = v.slice(0, 1000);
    }
    if (Object.keys(clean).length) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

export const AI_DATA_PROMPT =
  'You generate test data for software tests. Reply with a JSON array of flat objects only (no prose). '
  + 'All values must be fictitious: never use real people, real companies\' customer data, real phone numbers or real card numbers. '
  + 'Emails must use example.com, example.net or example.org. Use the same columns in every row. '
  + 'When the description asks for edge cases (invalid input, boundaries, special characters, long values), include them '
  + 'and add a "_label" column that names the case.';

/** Ask the AI for rows matching a description (and optional column hints). */
export async function aiRows(description: string, count: number, opts: { fields?: Record<string, string>; locale?: string; preferred?: string } = {}): Promise<{ rows: Array<Record<string, any>>; provider?: string }> {
  const { getLLMRouter } = await import('../../infra/llm/router.js');
  const { extractJsonArray } = await import('../../infra/llm/json.js');
  const router = getLLMRouter();
  if (!router.hasAnyProvider()) throw new Error('AI data generation needs an AI provider, and none is configured — use fields (Faker) instead');
  const n = clampCount(count);
  const columns = Object.entries(opts.fields ?? {}).filter(([c]) => COLUMN_RE.test(c));
  const user = [
    `Rows: ${n}`,
    opts.locale && opts.locale !== 'en' ? `Locale for names, addresses and formats: ${opts.locale}` : '',
    columns.length ? `Columns: ${columns.map(([c, k]) => `${c} (${FAKE_KINDS[k]?.description ?? k})`).join(', ')}` : '',
    `Data to generate: ${description.slice(0, 2000)}`,
  ].filter(Boolean).join('\n');
  const response = await router.chat([{ role: 'system', content: AI_DATA_PROMPT }, { role: 'user', content: user }], 'codegen', { preferred: opts.preferred, maxTokens: 4000 });
  const rows = sanitizeRows(extractJsonArray(response.content), n);
  if (!rows.length) throw new Error('The AI did not return usable rows — try a more precise description');
  return { rows, provider: response.provider };
}

/** Kinds with an example value, for the UI and the docs. */
export async function describeKinds(locale = 'en'): Promise<Array<{ kind: string; description: string; example: string }>> {
  const values = new FakeValues(await createFaker(locale, 7));
  return Object.entries(FAKE_KINDS).map(([kind, spec]) => ({ kind, description: spec.description, example: values.get(kind) }));
}
