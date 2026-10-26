import { DatabaseSync } from 'node:sqlite';
import { STORYBANK_D1_SCHEMA_SQL } from '../../server/hosted-d1.mjs';
export function createD1Fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(STORYBANK_D1_SCHEMA_SQL);
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...values) {
      return {
        async first(column) { const found = statement.get(...values); const row = found ? { ...found } : null; return column && row ? row[column] : row; },
        async all() { return { success: true, results: statement.all(...values), meta: {} }; },
        async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      };
    } };
  } };
  return { db, sqlite, close() { sqlite.close(); } };
}
