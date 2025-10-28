import { SQL } from 'bun';
import * as spooder from 'spooder';

type TestRow = {
	ID: number;
	test: string;
};

const db = new SQL('mysql://test:1141483652@localhost:3306/test');
await spooder.db_schema(db, './db/revisions');