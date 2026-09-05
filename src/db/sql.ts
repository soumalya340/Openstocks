/** Convert SQLite `?` placeholders to Postgres `$1, $2, ...`. */
export function toPgParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** Light SQLite → Postgres dialect tweaks for our schema/queries. */
export function toPgSql(sql: string): string {
  let out = sql;
  out = out.replace(
    /INSERT\s+OR\s+IGNORE\s+INTO/gi,
    "INSERT INTO"
  );
  // Append ON CONFLICT DO NOTHING when we rewrote INSERT OR IGNORE and none exists yet.
  if (/INSERT\s+OR\s+IGNORE/i.test(sql) && !/ON CONFLICT/i.test(out)) {
    // Handled below via explicit migrate SQL for postgres; for runtime use replace carefully.
  }
  out = out.replace(
    /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    (_m, table: string, cols: string, vals: string) => {
      const colList = cols.split(",").map((c) => c.trim());
      const pk = colList[0];
      const updates = colList
        .slice(1)
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${pk}) DO UPDATE SET ${updates}`;
    }
  );
  out = out.replace(/INSERT OR IGNORE INTO/gi, "INSERT INTO");
  return toPgParams(out);
}

export function rewriteInsertOrIgnore(sql: string, conflictTarget: string): string {
  const base = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  if (/ON CONFLICT/i.test(base)) return toPgParams(base);
  return toPgParams(`${base} ON CONFLICT (${conflictTarget}) DO NOTHING`);
}
