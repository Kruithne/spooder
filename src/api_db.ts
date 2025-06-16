import { Database } from 'bun:sqlite';
import { log_create_logger, log_list } from './api';
import path from 'node:path';
import fs from 'node:fs/promises';

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
						revisions.set(current_rev_id, current_rev);
						current_rev = '';
					}

					const rev_number = parseInt(line_identifier[1]);
					if (isNaN(rev_number) || rev_number < 1)
						throw new Error(rev_number + ' is not a valid revision number in ' + schema_file_lower);
					current_rev_id = rev_number;
				}
			} else {
				// Append to existing revision.
				current_rev += line + '\n';
			}
		}

		// There may be something left in current_chunk once we reach end of the file.
		if (current_rev_id > 0)
			revisions.set(current_rev_id, current_rev);

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
		db_log(`creating {${schema_table_name}}`);
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
			db_log(`applying revision {${rev_id}} to {${schema.name}}`);

			await db.query(revision);
			newest_schema_version = rev_id;
		}

		if (newest_schema_version > schema.current_version) {
			db_log(`updated table {${schema.name}} to revision {${newest_schema_version}}`);
			await update_schema_query.execute([newest_schema_version, schema.name]);
		}
	}

	await db.commit();
}

export async function db_mysql(db_info: mysql_types.ConnectionOptions, pool: boolean = false) {
	if (mysql === undefined)
		throw new Error('db_mysql cannot be called without optional dependency {mysql2} installed');

	// required for parsing multiple statements from schema files
	db_info.multipleStatements = true;

	const instance = pool ? mysql.createPool(db_info) : await mysql.createConnection(db_info);

	return {
		instance,
		is_pool: pool,

		update_schema: async (schema_dir: string, schema_table_name = 'db_schema') => {
			return db_update_schema_mysql(instance, schema_dir, schema_table_name);
		}
	};
}
// endregion

// region sqlite
export async function db_update_schema_sqlite(db: Database, schema_dir: string, schema_table_name = 'db_schema') {
	db_log(`updating database schema for {${db.filename}}`);

	const schema_versions = new Map();

	try {
		const query = db.query('SELECT db_schema_table_name, db_schema_version FROM ' + schema_table_name);
		for (const row of query.all() as Array<Row_DBSchema>)
			schema_versions.set(row.db_schema_table_name, row.db_schema_version);
	} catch (e) {
		db_log(`creating {${schema_table_name}}`);
		db.run(`CREATE TABLE ${schema_table_name} (db_schema_table_name TEXT PRIMARY KEY, db_schema_version INTEGER)`);
	}
	
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
				db_log(`applying revision {${rev_id}} to {${schema.name}}`);
				db.transaction(() => db.run(revision))();
				newest_schema_version = rev_id;
			}
	
			if (newest_schema_version > schema.current_version) {
				db_log(`updated table {${schema.name}} to revision {${newest_schema_version}}`);
				update_schema_query.run(newest_schema_version, schema.name);
			}
		}
	})();
}

export function db_sqlite(...args: ConstructorParameters<typeof Database>) {
	const instance = new Database(...args);

	return {
		instance,

		update_schema: async (schema_dir: string, schema_table_name: 'db_schema') => {
			return db_update_schema_sqlite(instance, schema_dir, schema_table_name);
		}
	}
}
// endregion