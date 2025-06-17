import { Database } from 'bun:sqlite';
import { log_create_logger, log_list, caution, ERR_MODE, get_error_mode, set_error_mode } from './api';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

const db_log = log_create_logger('db', '#16b39e');

// region schema
interface DependencyTarget {
	file_name: string;
	deps: string[];
}

function order_schema_dep_tree<T extends DependencyTarget>(deps: T[]): T[] {
	const visited = new Set<string>();
	const temp = new Set<string>();
	const result: T[] = [];
	const map = new Map(deps.map(d => [d.file_name, d]));
 
	function visit(node: T): void {
		if (temp.has(node.file_name))
			throw new Error(`Cyclic dependency {${node.file_name}}`);
 
		if (visited.has(node.file_name))
			return;
 
		temp.add(node.file_name);
 
		for (const dep of node.deps) {
			const dep_node = map.get(dep);
			if (!dep_node)
				throw new Error(`Missing dependency {${dep}}`);
			
			visit(dep_node as T);
		}
 
		temp.delete(node.file_name);
		visited.add(node.file_name);
		result.push(node);
	}
 
	for (const dep of deps)
		if (!visited.has(dep.file_name))
			visit(dep);
 
	return result;
 }

type Row_DBSchema = { db_schema_table_name: string, db_schema_version: number };
type SchemaVersionMap = Map<string, number>;

async function db_load_schema(schema_dir: string, schema_versions: SchemaVersionMap) {
	const schema_out = [];
	const schema_files = await fs.readdir(schema_dir, { recursive: true, withFileTypes: true });

	for (const schema_file_ent of schema_files) {
		if (schema_file_ent.isDirectory())
			continue;

		const schema_file = schema_file_ent.name;
		const schema_file_lower = schema_file.toLowerCase();
		if (!schema_file_lower.endsWith('.sql'))
			continue;

		db_log(`parsing schema file {${schema_file_lower}}`);

		const schema_name = path.basename(schema_file_lower, '.sql');
		const schema_path = path.join(schema_file_ent.parentPath, schema_file);
		const schema = await fs.readFile(schema_path, 'utf8');

		const deps = new Array<string>();

		const revisions = new Map();
		let current_rev_id = 0;
		let current_rev = '';
		let current_rev_comment = '';

		for (const line of schema.split(/\r?\n/)) {
			const line_identifier = line.match(/^--\s*\[(\d+|deps)\]/);
			if (line_identifier !== null) {
				if (line_identifier[1] === 'deps') {
					// Line contains schema dependencies, example: -- [deps] schema_b.sql,schema_c.sql
					const deps_raw = line.substring(line.indexOf(']') + 1);
					deps.push(...deps_raw.split(',').map(e => e.trim().toLowerCase()));
				} else {
					// New chunk definition detected, store the current chunk and start a new one.
					if (current_rev_id > 0) {
						revisions.set(current_rev_id, { sql: current_rev, comment: current_rev_comment });
						current_rev = '';
						current_rev_comment = '';
					}

					const rev_number = parseInt(line_identifier[1]);
					if (isNaN(rev_number) || rev_number < 1)
						throw new Error(rev_number + ' is not a valid revision number in ' + schema_file_lower);
					current_rev_id = rev_number;
					
					// Extract comment from the header line (everything after the closing bracket)
					const comment_start = line.indexOf(']') + 1;
					current_rev_comment = line.substring(comment_start).trim();
				}
			} else {
				// Append to existing revision.
				current_rev += line + '\n';
			}
		}

		// There may be something left in current_chunk once we reach end of the file.
		if (current_rev_id > 0)
			revisions.set(current_rev_id, { sql: current_rev, comment: current_rev_comment });

		if (revisions.size === 0) {
			db_log(`{${schema_file}} contains no valid revisions`);
			continue;
		}

		if (deps.length > 0)
			db_log(`{${schema_file}} dependencies: ${log_list(deps)}`);

		const current_schema_version = schema_versions.get(schema_name) ?? 0;
		schema_out.push({
			revisions,
			file_name: schema_file_lower,
			name: schema_name,
			current_version: current_schema_version,
			deps,
			chunk_keys: Array.from(revisions.keys()).filter(chunk_id => chunk_id > current_schema_version).sort((a, b) => a - b)
		});
	}

	return order_schema_dep_tree(schema_out);
}
// endregion

// region mysql
import type * as mysql_types from 'mysql2/promise';
let mysql: typeof mysql_types | undefined;
try {
	mysql = await import('mysql2/promise') as typeof mysql_types;
} catch (e) {
	// mysql2 optional dependency not installed.
	// this dependency will be replaced once bun:sql supports mysql.
	// db_update_schema_mysql and db_init_schema_mysql will throw.
}

export async function db_update_schema_mysql(db: mysql_types.Connection, schema_dir: string, schema_table_name = 'db_schema') {
	if (mysql === undefined)
		throw new Error('{db_update_schema_mysql} cannot be called without optional dependency {mysql2} installed');

	db_log(`updating database schema for {${db.config.database}}`);

	const schema_versions = new Map();

	try {
		const [rows] = await db.query('SELECT db_schema_table_name, db_schema_version FROM ' + schema_table_name);
		for (const row of rows as Array<Row_DBSchema>)
			schema_versions.set(row.db_schema_table_name, row.db_schema_version);
	} catch (e) {
		db_log(`creating schema table {${schema_table_name}}`);
		await db.query(`CREATE TABLE ${schema_table_name} (db_schema_table_name VARCHAR(255) PRIMARY KEY, db_schema_version INT)`);
	}

	await db.beginTransaction();
	
	const update_schema_query = await db.prepare(`
		INSERT INTO ${schema_table_name} (db_schema_version, db_schema_table_name) VALUES (?, ?)
		ON DUPLICATE KEY UPDATE db_schema_version = VALUES(db_schema_version);
	`);

	const schemas = await db_load_schema(schema_dir, schema_versions);
	for (const schema of schemas) {
		let newest_schema_version = schema.current_version;
		for (const rev_id of schema.chunk_keys) {
			const revision = schema.revisions.get(rev_id);
			const comment_text = revision.comment ? ` "{${revision.comment}}"` : '';
			db_log(`applying revision [{${rev_id}}]${comment_text} to {${schema.name}}`);

			await db.query(revision.sql);
			newest_schema_version = rev_id;
		}

		if (newest_schema_version > schema.current_version) {
			db_log(`updated table {${schema.name}} to revision {${newest_schema_version}}`);
			await update_schema_query.execute([newest_schema_version, schema.name]);
		}
	}

	await db.commit();
}

type MySQLDatabaseInterface = ReturnType<typeof create_mysql_api>;

function create_mysql_api(instance: mysql_types.Connection | mysql_types.Pool, error_handler: (error: unknown, return_value: any, title: string) => any) {
	return {
		/**
		 * Executes a query and returns the LAST_INSERT_ID.
		 * Returns -1 if the query fails or no LAST_INSERT_ID is available.
		 */
		insert: async (sql: string, ...values: any) => {
			try {
				const [result] = await instance.query<ResultSetHeader>(sql, values);
				return result.insertId ?? -1;
			} catch (error) {
				return error_handler(error, -1, 'insert failed');
			}
		},

		/**
		 * Executes an insert query using object key/value mapping.
		 * Returns the LAST_INSERT_ID or -1 if the query fails.
		 */
		insert_object: async (table: string, obj: Record<string, any>) => {
			try {
				const values = Object.values(obj);
				let sql = 'INSERT INTO `' + table + '` (';
				sql += Object.keys(obj).map(e => '`' + e + '`').join(', ');
				sql += ') VALUES(' + values.map(() => '?').join(', ') + ')';

				const [result] = await instance.query<ResultSetHeader>(sql, values);
				return result.insertId ?? -1;
			} catch (error) {
				return error_handler(error, -1, 'insert_object failed');
			}
		},

		/**
		 * Executes a query and returns the number of affected rows.
		 * Returns -1 if the query fails.
		 */
		execute: async (sql: string, ...values: any) => {
			try {
				const [result] = await instance.query<ResultSetHeader>(sql, values);
				return result.affectedRows;
			} catch (error) {
				return error_handler(error, -1, 'execute failed');
			}
		},

		/**
		 * Returns the complete query result set as an array.
		 * Returns empty array if no rows found or if query fails.
		 */
		get_all: async <T = RowDataPacket>(sql: string, ...values: any): Promise<T[]> => {
			try {
				const [rows] = await instance.execute(sql, values);
				return rows as T[];
			} catch (error) {
				return error_handler(error, [], 'get_all failed');
			}
		},

		/**
		 * Returns the first row from a query result set.
		 * Returns null if no rows found or if query fails.
		 */
		get_single: async <T = RowDataPacket>(sql: string, ...values: any): Promise<T | null> => {
			try {
				const [rows] = await instance.execute(sql, values);
				const typed_rows = rows as T[];
				return typed_rows[0] ?? null;
			} catch (error) {
				return error_handler(error, null, 'get_single failed');
			}
		},

		/**
		 * Returns the query result as a single column array.
		 * Returns empty array if no rows found or if query fails.
		 */
		get_column: async <T = any>(sql: string, column: string, ...values: any): Promise<T[]> => {
			try {
				const [rows] = await instance.execute(sql, values) as RowDataPacket[][];
				return rows.map((e: any) => e[column]) as T[];
			} catch (error) {
				return error_handler(error, [], 'get_column failed');
			}
		},

		/**
		 * Calls a stored procedure and returns the result set as an array.
		 * Returns empty array if no rows found or if query fails.
		 */
		call: async <T = RowDataPacket>(func_name: string, ...args: any): Promise<T[]> => {
			try {
				const placeholders = args.map(() => '?').join(', ');
				const sql = `CALL ${func_name}(${placeholders})`;
				const result = await instance.execute<RowDataPacket[][]>(sql, args);
				return result[0][0] as T[];
			} catch (error) {
				return error_handler(error, [], 'call failed');
			}
		},

		/**
		 * Returns an async iterator that yields pages of database rows.
		 * Each page contains at most `page_size` rows (default 1000).
		 */
		get_paged: async function* <T = RowDataPacket>(sql: string, values: any[] = [], page_size: number = 1000): AsyncGenerator<T[]> {
			let current_offset = 0;
			
			while (true) {
				try {
					const paged_sql = `${sql} LIMIT ${page_size} OFFSET ${current_offset}`;
					
					const [rows] = await instance.execute(paged_sql, values);
					const page_rows = rows as T[];
					
					if (page_rows.length === 0)
						break;
					
					yield page_rows;
					
					current_offset += page_size;
					
					if (page_rows.length < page_size)
						break;
				} catch (error) {
					error_handler(error, undefined, 'get_paged failed');
					return;
				}
			}
		},

		/**
		 * Returns the value of `count` from a query.
		 * Returns 0 if query fails.
		 */
		count: async (sql: string, ...values: any): Promise<number> => {
			try {
				const [rows] = await instance.execute(sql, values);
				const typed_rows = rows as RowDataPacket[];
				return typed_rows[0]?.count ?? 0;
			} catch (error) {
				return error_handler(error, 0, 'count failed');
			}
		},

		/**
		 * Returns the total count of rows from a table.
		 * Returns 0 if query fails.
		 */
		count_table: async (table_name: string): Promise<number> => {
			try {
				const [rows] = await instance.execute('SELECT COUNT(*) AS `count` FROM `' + table_name + '`');
				const typed_rows = rows as RowDataPacket[];
				return typed_rows[0]?.count ?? 0;
			} catch (error) {
				return error_handler(error, 0, 'count_table failed');
			}
		},

		/**
		 * Returns true if the query returns any results.
		 * Returns false if no results found or if query fails.
		 */
		exists: async (sql: string, ...values: any): Promise<boolean> => {
			try {
				const [rows] = await instance.execute(sql, values);
				const typed_rows = rows as RowDataPacket[];
				return typed_rows.length > 0;
			} catch (error) {
				return error_handler(error, false, 'exists failed');
			}
		}
	};
}

export async function db_mysql(db_info: mysql_types.ConnectionOptions, pool: boolean = false) {
	if (mysql === undefined)
		throw new Error('db_mysql cannot be called without optional dependency {mysql2} installed');

	// required for parsing multiple statements from schema files
	db_info.multipleStatements = true;

	const instance = pool ? mysql.createPool(db_info) : await mysql.createConnection(db_info);

	function db_handle_error(error: unknown, return_value: any, title: string) {
		const error_mode = get_error_mode();
		if (error_mode === ERR_MODE.THROW_EXCEPTION)
			throw error;

		if (error_mode === ERR_MODE.CANARY_CAUTION)
			caution(`mysql: ${title}`, { error });

		return return_value;
	}

	return {
		instance,

		update_schema: async (schema_dir: string, schema_table_name: string = 'db_schema') => {
			await db_update_schema_mysql(instance, schema_dir, schema_table_name);
		},

		transaction: async (scope: (transaction: MySQLDatabaseInterface) => void | Promise<void>) => {
			let connection: mysql_types.Connection = instance;

			if (pool)
				connection = await (instance as mysql_types.Pool).getConnection();

			await connection.beginTransaction();

			try {
				const transaction_api = create_mysql_api(connection, db_handle_error);
				await scope(transaction_api);
				await connection.commit();
				return true;
			} catch (error) {
				await connection.rollback();
				return db_handle_error(error, false, 'transaction failed');
			} finally {
				if (pool)
					(connection as mysql_types.PoolConnection).release();
			}
		},

		...create_mysql_api(instance, db_handle_error)
	};
}
// endregion

// region sqlite
export async function db_update_schema_sqlite(db: Database, schema_dir: string, schema_table_name = 'db_schema'): Promise<void> {
	db_log(`updating database schema for {${db.filename}}`);

	const schema_versions = new Map();

	try {
		const query = db.query('SELECT db_schema_table_name, db_schema_version FROM ' + schema_table_name);
		for (const row of query.all() as Array<Row_DBSchema>)
			schema_versions.set(row.db_schema_table_name, row.db_schema_version);
	} catch (e) {
		db_log(`creating schema table {${schema_table_name}}`);
		db.run(`CREATE TABLE ${schema_table_name} (db_schema_table_name TEXT PRIMARY KEY, db_schema_version INTEGER)`);
	}
	
	return new Promise(resolve => {
		db.transaction(async () => {
			const update_schema_query = db.prepare(`
				INSERT INTO ${schema_table_name} (db_schema_version, db_schema_table_name) VALUES (?1, ?2)
				ON CONFLICT(db_schema_table_name) DO UPDATE SET db_schema_version = EXCLUDED.db_schema_version
			`);
	
			const schemas = await db_load_schema(schema_dir, schema_versions);
	
			for (const schema of schemas) {
				let newest_schema_version = schema.current_version;
				for (const rev_id of schema.chunk_keys) {
					const revision = schema.revisions.get(rev_id);
					const comment_text = revision.comment ? ` "{${revision.comment}}"` : '';
					db_log(`applying revision [{${rev_id}}]${comment_text} to {${schema.name}}`);
					db.transaction(() => db.run(revision.sql))();
					newest_schema_version = rev_id;
				}
		
				if (newest_schema_version > schema.current_version) {
					db_log(`updated table {${schema.name}} to revision {${newest_schema_version}}`);
					update_schema_query.run(newest_schema_version, schema.name);
				}
			}

			resolve();
		})();
	});
}

type SQLiteDatabaseInterface = ReturnType<typeof create_sqlite_api>;

function create_sqlite_api(instance: Database, error_handler: (error: unknown, return_value: any, title: string) => any) {
	return {
		/**
		 * Executes a query and returns the lastInsertRowid.
		 * Returns -1 if the query fails or no lastInsertRowid is available.
		 */
		insert: (sql: string, ...values: any) => {
			try {
				const result = instance.run(sql, ...values);
				return Number(result.lastInsertRowid) || -1;
			} catch (error) {
				return error_handler(error, -1, 'insert failed');
			}
		},

		/**
		 * Executes an insert query using object key/value mapping.
		 * Returns the lastInsertRowid or -1 if the query fails.
		 */
		insert_object: (table: string, obj: Record<string, any>) => {
			try {
				const values = Object.values(obj);
				let sql = 'INSERT INTO `' + table + '` (';
				sql += Object.keys(obj).map(e => '`' + e + '`').join(', ');
				sql += ') VALUES(' + values.map(() => '?').join(', ') + ')';

				const result = instance.run(sql, ...values);
				return Number(result.lastInsertRowid) || -1;
			} catch (error) {
				return error_handler(error, -1, 'insert_object failed');
			}
		},

		/**
		 * Executes a query and returns the number of affected rows.
		 * Returns -1 if the query fails.
		 */
		execute: (sql: string, ...values: any) => {
			try {
				const result = instance.run(sql, ...values);
				return result.changes || 0;
			} catch (error) {
				return error_handler(error, -1, 'execute failed');
			}
		},

		/**
		 * Returns the complete query result set as an array.
		 * Returns empty array if no rows found or if query fails.
		 */
		get_all: <T = any>(sql: string, ...values: any): T[] => {
			try {
				const rows = instance.query(sql).all(...values);
				return rows as T[];
			} catch (error) {
				return error_handler(error, [], 'get_all failed');
			}
		},

		/**
		 * Returns the first row from a query result set.
		 * Returns null if no rows found or if query fails.
		 */
		get_single: <T = any>(sql: string, ...values: any): T | null => {
			try {
				const row = instance.query(sql).get(...values);
				return (row as T) ?? null;
			} catch (error) {
				return error_handler(error, null, 'get_single failed');
			}
		},

		/**
		 * Returns the query result as a single column array.
		 * Returns empty array if no rows found or if query fails.
		 */
		get_column: <T = any>(sql: string, column: string, ...values: any): T[] => {
			try {
				const rows = instance.query(sql).all(...values) as any[];
				return rows.map((row: any) => row[column]) as T[];
			} catch (error) {
				return error_handler(error, [], 'get_column failed');
			}
		},

		/**
		 * Returns an async iterator that yields pages of database rows.
		 * Each page contains at most `page_size` rows (default 1000).
		 */
		get_paged: async function* <T = any>(sql: string, values: any[] = [], page_size: number = 1000): AsyncGenerator<T[]> {
			let current_offset = 0;
			
			while (true) {
				try {
					const paged_sql = `${sql} LIMIT ? OFFSET ?`;
					const paged_values = [...values, page_size, current_offset];
					
					const rows = instance.query(paged_sql).all(...paged_values) as T[];
					
					if (rows.length === 0)
						break;
					
					yield rows;
					
					current_offset += page_size;
					
					if (rows.length < page_size)
						break;
				} catch (error) {
					error_handler(error, undefined, 'get_paged failed');
					return;
				}
			}
		},

		/**
		 * Returns the value of `count` from a query.
		 * Returns 0 if query fails.
		 */
		count: (sql: string, ...values: any): number => {
			try {
				const row = instance.query(sql).get(...values) as any;
				return row?.count ?? 0;
			} catch (error) {
				return error_handler(error, 0, 'count failed');
			}
		},

		/**
		 * Returns the total count of rows from a table.
		 * Returns 0 if query fails.
		 */
		count_table: (table_name: string): number => {
			try {
				const row = instance.query('SELECT COUNT(*) AS `count` FROM `' + table_name + '`').get();
				return (row as any)?.count ?? 0;
			} catch (error) {
				return error_handler(error, 0, 'count_table failed');
			}
		},

		/**
		 * Returns true if the query returns any results.
		 * Returns false if no results found or if query fails.
		 */
		exists: (sql: string, ...values: any): boolean => {
			try {
				const row = instance.query(sql).get(...values);
				return row !== null;
			} catch (error) {
				return error_handler(error, false, 'exists failed');
			}
		}
	};
}

export function db_sqlite(...args: ConstructorParameters<typeof Database>) {
	const instance = new Database(...args);

	function db_handle_error(error: unknown, return_value: any, title: string) {
		const error_mode = get_error_mode();
		if (error_mode === ERR_MODE.THROW_EXCEPTION)
			throw error;

		if (error_mode === ERR_MODE.CANARY_CAUTION)
			caution(`sqlite: ${title}`, { error });

		return return_value;
	}

	return {
		instance,

		update_schema: async (schema_dir: string, schema_table_name: string = 'db_schema') => {
			await db_update_schema_sqlite(instance, schema_dir, schema_table_name);
		},

		transaction: (scope: (transaction: SQLiteDatabaseInterface) => void | Promise<void>) => {
			const transaction_fn = instance.transaction(async () => {
				const transaction_api = create_sqlite_api(instance, db_handle_error);
				await scope(transaction_api);
			});

			try {
				transaction_fn();
				return true;
			} catch (error) {
				return db_handle_error(error, false, 'transaction failed');
			}
		},

		...create_sqlite_api(instance, db_handle_error)
	};
}
// endregion