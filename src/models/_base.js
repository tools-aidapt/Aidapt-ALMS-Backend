'use strict';

const { query } = require('../config/db');

/**
 * Model helper for the pg (Supabase) data layer.
 *
 * Models keep returning the SAME record shape the services already consume:
 *   { id, fields: { <AirtableFieldName>: value, ... }, createdTime }
 * so the service/controller layer is unchanged by the Airtable -> Postgres swap.
 *
 * A model is defined by a column map:
 *   columns: { FieldName: { col: 'db_column', link?: true }, ... }
 *   createdColumn: 'created_at'  (optional; surfaced as record.createdTime)
 *
 * `link: true` marks a foreign-key column that the old Airtable code treated as
 * an array of ids. We preserve that: reads return `[id]` (or `[]`), writes
 * accept `[id]` (or a bare id) and store the scalar FK.
 */
function makeModel({ table, columns, createdColumn }) {
  const fieldNames = Object.keys(columns);

  function rowToRecord(row) {
    if (!row) return null;
    const fields = {};
    for (const fn of fieldNames) {
      const { col, link } = columns[fn];
      const v = row[col];
      if (link) fields[fn] = v ? [v] : [];
      else fields[fn] = v === undefined ? null : v;
    }
    return {
      id: row.id,
      fields,
      createdTime: createdColumn ? row[createdColumn] : null,
    };
  }

  function fieldsToColumns(fields) {
    const out = {};
    for (const fn of Object.keys(fields)) {
      const cfg = columns[fn];
      if (!cfg) continue;
      const val = fields[fn];
      if (cfg.link) {
        out[cfg.col] = Array.isArray(val) ? val[0] ?? null : val ?? null;
      } else {
        out[cfg.col] = val;
      }
    }
    return out;
  }

  const model = {
    table,
    columns,
    rowToRecord,
    fieldsToColumns,

    async get(id) {
      const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      return rowToRecord(rows[0]);
    },

    async create(fields, client) {
      const cols = fieldsToColumns(fields);
      const keys = Object.keys(cols);
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      const values = keys.map((k) => cols[k]);
      const sql = keys.length
        ? `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`
        : `INSERT INTO ${table} DEFAULT VALUES RETURNING *`;
      const runner = client || { query };
      const { rows } = await runner.query(sql, values);
      return rowToRecord(rows[0]);
    },

    async update(id, fields, client) {
      const cols = fieldsToColumns(fields);
      const keys = Object.keys(cols);
      if (!keys.length) return this.get(id);
      const set = keys.map((k, i) => `${k} = $${i + 1}`);
      const values = keys.map((k) => cols[k]);
      values.push(id);
      const sql = `UPDATE ${table} SET ${set.join(', ')} WHERE id = $${keys.length + 1} RETURNING *`;
      const runner = client || { query };
      const { rows } = await runner.query(sql, values);
      return rowToRecord(rows[0]);
    },

    async remove(id) {
      await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return { id, deleted: true };
    },

    /** Run an arbitrary SELECT (already scoped to this table) and map rows. */
    async selectWhere(whereSql = '', params = [], suffix = '') {
      const clause = whereSql ? `WHERE ${whereSql}` : '';
      const { rows } = await query(`SELECT * FROM ${table} ${clause} ${suffix}`.trim(), params);
      return rows.map(rowToRecord);
    },

    /**
     * List all rows, optional sort. `sort` uses Airtable-style field names
     * (e.g. [{ field: 'Name', direction: 'asc' }]) mapped to columns here.
     */
    async list({ sort } = {}) {
      let suffix = '';
      if (sort && sort.length) {
        const parts = sort
          .map((s) => {
            const cfg = columns[s.field];
            const col =
              (cfg && cfg.col) ||
              (s.field === 'CreatedAt' || s.field === 'Timestamp' ? createdColumn : null);
            return col ? `${col} ${s.direction === 'desc' ? 'DESC' : 'ASC'}` : null;
          })
          .filter(Boolean);
        if (parts.length) suffix = `ORDER BY ${parts.join(', ')}`;
      }
      return this.selectWhere('', [], suffix);
    },
  };

  return model;
}

module.exports = { makeModel };
