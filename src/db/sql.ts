/** Convert `?` placeholders to Postgres `$1, $2, ...`. */
export function toPgParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
