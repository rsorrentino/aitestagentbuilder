/**
 * Database steps: check what the application wrote, prepare and clean test data.
 *
 *   databases: [{ name: "shop", type: "postgres" | "mysql" | "sqlserver" | "oracle",
 *                 host, port, database, user, password (secret) — or url (secret) —, ssl, read_only }]
 *
 * Steps (target = database name, optional when the agent has one):
 *   db_query   { sql, params?, save_as?, extract? }      run a query, keep values as {{vars.x}}
 *   assert_db  { sql, params?, rows?, equals?, contains?, empty? }   check the result
 *   db_execute { sql, params? }                          INSERT / UPDATE / DELETE (needs read_only: false)
 *
 * Parameters are written as ? in any database (converted to $1, @p1, :1); values like
 * {{vars.orderId}} go in params, never into the SQL text. Databases are read-only unless
 * read_only is false: only SELECT-like statements run, inside a read-only transaction where the
 * database has one (PostgreSQL, MySQL, Oracle). Every statement has a 30-second limit.
 */

export const DB_TYPES = ['postgres', 'mysql', 'sqlserver', 'oracle'] as const;
export type DbType = typeof DB_TYPES[number];
export const DB_SECRET_FIELDS = ['password', 'url'];
const DEFAULT_PORT: Record<DbType, number> = { postgres: 5432, mysql: 3306, sqlserver: 1433, oracle: 1521 };
const TIMEOUT_MS = 30_000;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface DbConfig {
  name: string; type: DbType; url?: string; host?: string; port?: number; database?: string; user?: string; password?: string;
  ssl?: boolean; read_only?: boolean;
}

export interface QueryResult { rows: Array<Record<string, any>>; rowCount: number; columns: string[] }

export function validateDatabases(list: any): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return ['config.databases must be a list'];
  const errors: string[] = [];
  const names = new Set<string>();
  list.forEach((d: any, i: number) => {
    const at = `config.databases[${i}]`;
    if (!d || typeof d !== 'object') return void errors.push(`${at} must be an object`);
    if (!NAME_RE.test(String(d.name ?? ''))) errors.push(`${at}.name must be a short name (letters, digits, - and _)`);
    else if (names.has(String(d.name).toLowerCase())) errors.push(`${at}.name "${d.name}" is used twice`);
    else names.add(String(d.name).toLowerCase());
    if (!DB_TYPES.includes(d.type)) errors.push(`${at}.type must be one of ${DB_TYPES.join(', ')}`);
    if (!d.url && !d.host) errors.push(`${at} needs host (and database, user, password) or url`);
    if (d.port !== undefined && (!Number.isInteger(Number(d.port)) || Number(d.port) < 1 || Number(d.port) > 65535)) errors.push(`${at}.port must be a port number`);
    if (d.read_only !== undefined && typeof d.read_only !== 'boolean') errors.push(`${at}.read_only must be true or false`);
  });
  return errors;
}

/** "? " placeholders → the database's own ($1, @p1, :1); ? inside quotes, comments or ?? is kept. */
export function toDriverSql(sql: string, type: DbType): string {
  if (type === 'mysql') return sql;
  let n = 0;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === '?' && sql[i + 1] === '?') {
      out += '?';
      i++;
    } else if (c === '?') {
      n++;
      out += type === 'postgres' ? `$${n}` : type === 'sqlserver' ? `@p${n}` : `:${n}`;
    } else out += c;
  }
  return out;
}

/** Statements allowed on a read-only database: one SELECT-like statement. */
export function isReadOnlySql(sql: string): boolean {
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (/;\s*\S/.test(s.replace(/'[^']*'/g, "''"))) return false;
  if (!/^(select|with|show|describe|desc|explain|values)\b/i.test(s)) return false;
  // CTEs that write ("WITH x AS (DELETE …)") and SELECT … INTO
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|exec|execute)\b/i.test(s.replace(/'[^']*'/g, "''")) && !/\binto\s+\w/i.test(s.replace(/'[^']*'/g, "''"));
}

/** Compare a cell with an expected value (numbers and dates as text, null as "null"). */
export const cellText = (v: any): string => (v === null || v === undefined ? 'null' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Check a result against the expectations of assert_db (pure); returns what does not match. */
export function checkResult(r: QueryResult, expect: { rows?: number | string; equals?: Record<string, any>; contains?: string; empty?: boolean }): string[] {
  const problems: string[] = [];
  if (expect.empty === true && r.rowCount !== 0) problems.push(`expected no rows but got ${r.rowCount}`);
  if (expect.empty === false && r.rowCount === 0) problems.push('expected rows but got none');
  if (expect.rows !== undefined) {
    const m = /^\s*(>=|<=|>|<|=)?\s*(\d+)\s*$/.exec(String(expect.rows));
    if (!m) problems.push(`rows must be a number or a comparison like ">0" (got ${expect.rows})`);
    else {
      const n = Number(m[2]);
      const ok = { '>=': r.rowCount >= n, '<=': r.rowCount <= n, '>': r.rowCount > n, '<': r.rowCount < n, '=': r.rowCount === n, undefined: r.rowCount === n }[m[1] as '>'];
      if (!ok) problems.push(`expected ${m[1] ?? ''}${n} row(s) but got ${r.rowCount}`);
    }
  }
  if (expect.equals && typeof expect.equals === 'object') {
    const first = r.rows[0];
    if (!first) problems.push('expected a row to compare but got none');
    else {
      for (const [col, want] of Object.entries(expect.equals)) {
        const key = Object.keys(first).find((k) => k.toLowerCase() === col.toLowerCase());
        if (key === undefined) problems.push(`no column "${col}" (columns: ${Object.keys(first).join(', ')})`);
        else if (cellText(first[key]) !== cellText(want)) problems.push(`${key} is "${cellText(first[key])}", expected "${cellText(want)}"`);
      }
    }
  }
  if (expect.contains !== undefined && !r.rows.some((row) => Object.values(row).some((v) => cellText(v).includes(String(expect.contains))))) {
    problems.push(`no cell contains "${expect.contains}"`);
  }
  return problems;
}

interface Driver {
  query(sql: string, params: any[], write: boolean): Promise<QueryResult>;
  close(): Promise<void>;
}

const result = (rows: any[], columns?: string[]): QueryResult => ({ rows, rowCount: rows.length, columns: columns ?? (rows[0] ? Object.keys(rows[0]) : []) });

async function openDriver(c: DbConfig): Promise<Driver> {
  const port = Number(c.port ?? DEFAULT_PORT[c.type]);
  if (c.type === 'postgres') {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      ...(c.url ? { connectionString: c.url } : { host: c.host, port, database: c.database, user: c.user, password: c.password }),
      ...(c.ssl ? { ssl: { rejectUnauthorized: false } } : {}), max: 4, statement_timeout: TIMEOUT_MS, connectionTimeoutMillis: 15_000,
    });
    return {
      async query(sql, params, write) {
        const client = await pool.connect();
        try {
          if (!write) await client.query('BEGIN TRANSACTION READ ONLY');
          const r = await client.query(toDriverSql(sql, 'postgres'), params);
          if (!write) await client.query('ROLLBACK');
          return { rows: r.rows ?? [], rowCount: r.rows?.length ?? r.rowCount ?? 0, columns: (r.fields ?? []).map((f: any) => f.name) };
        } catch (e) {
          if (!write) await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (c.type === 'mysql') {
    const mysql: any = await import('mysql2/promise');
    const pool = (mysql.default ?? mysql).createPool({
      ...(c.url ? { uri: c.url } : { host: c.host, port, database: c.database, user: c.user, password: c.password }),
      ...(c.ssl ? { ssl: { rejectUnauthorized: false } } : {}), connectionLimit: 4, connectTimeout: 15_000, dateStrings: false,
    });
    return {
      async query(sql, params, write) {
        const conn = await pool.getConnection();
        try {
          if (!write) await conn.query('START TRANSACTION READ ONLY');
          const [rows, fields] = await conn.query({ sql, timeout: TIMEOUT_MS }, params);
          if (!write) await conn.query('ROLLBACK');
          return Array.isArray(rows) ? result(rows as any[], (fields ?? []).map((f: any) => f.name)) : { rows: [], rowCount: (rows as any).affectedRows ?? 0, columns: [] };
        } catch (e) {
          if (!write) await conn.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          conn.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (c.type === 'sqlserver') {
    const mssql: any = await import('mssql');
    const sqlLib = mssql.default ?? mssql;
    const pool = await new sqlLib.ConnectionPool(c.url ?? {
      server: c.host, port, database: c.database, user: c.user, password: c.password,
      options: { encrypt: c.ssl !== false, trustServerCertificate: true }, requestTimeout: TIMEOUT_MS, connectionTimeout: 15_000, pool: { max: 4 },
    }).connect();
    return {
      async query(sql, params) {
        const request = pool.request();
        params.forEach((v, i) => request.input(`p${i + 1}`, v));
        const r = await request.query(toDriverSql(sql, 'sqlserver'));
        const rows = r.recordset ?? [];
        return rows.length || r.recordset ? result(rows, r.recordset?.columns ? Object.keys(r.recordset.columns) : undefined) : { rows: [], rowCount: r.rowsAffected?.[0] ?? 0, columns: [] };
      },
      close: () => pool.close(),
    };
  }
  const oracledb: any = await import('oracledb');
  const ora = oracledb.default ?? oracledb;
  const pool = await ora.createPool({
    user: c.user, password: c.password, connectString: c.url ?? `${c.host}:${port}/${c.database ?? ''}`, poolMax: 4, poolMin: 0, queueTimeout: 15_000,
  });
  return {
    async query(sql, params, write) {
      const conn = await pool.getConnection();
      try {
        conn.callTimeout = TIMEOUT_MS;
        if (!write) await conn.execute('SET TRANSACTION READ ONLY');
        const r = await conn.execute(toDriverSql(sql, 'oracle'), params, { outFormat: ora.OUT_FORMAT_OBJECT, autoCommit: write });
        if (!write) await conn.rollback();
        return r.rows ? result(r.rows, (r.metaData ?? []).map((m: any) => m.name)) : { rows: [], rowCount: r.rowsAffected ?? 0, columns: [] };
      } catch (e) {
        if (!write) await conn.rollback().catch(() => undefined);
        throw e;
      } finally {
        await conn.close();
      }
    },
    close: () => pool.close(0),
  };
}

/** The agent's databases for one run: opened on first use, closed at the end. */
export class DbConnections {
  private open = new Map<string, Promise<Driver>>();

  constructor(private configs: DbConfig[]) {}

  get names(): string[] {
    return this.configs.map((c) => c.name);
  }

  private config(name?: string): DbConfig {
    if (!this.configs.length) throw new Error('The agent has no databases: add one under databases in the agent settings');
    if (!name) {
      if (this.configs.length === 1) return this.configs[0];
      throw new Error(`Say which database (target): ${this.names.join(', ')}`);
    }
    const c = this.configs.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`Unknown database "${name}" (the agent has: ${this.names.join(', ')})`);
    return c;
  }

  async query(name: string | undefined, sql: string, params: any[] = [], opts: { write?: boolean } = {}): Promise<QueryResult & { database: string }> {
    const c = this.config(name);
    if (!sql?.trim()) throw new Error('The step needs data.sql (the statement to run)');
    if (opts.write && c.read_only !== false) throw new Error(`Database "${c.name}" is read-only: set read_only: false in its settings to change data`);
    if (!opts.write && !isReadOnlySql(sql)) throw new Error('Only one SELECT-like statement can run here: use db_execute (and read_only: false) to change data');
    let driver = this.open.get(c.name);
    if (!driver) {
      driver = openDriver(c);
      this.open.set(c.name, driver);
      driver.catch(() => this.open.delete(c.name));
    }
    const r = await (await driver).query(sql, params, !!opts.write);
    return { ...r, database: c.name };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.values()].map((d) => d.then((x) => x.close()).catch(() => undefined)));
    this.open.clear();
  }
}
