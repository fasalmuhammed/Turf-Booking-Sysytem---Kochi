import { config } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDemoData } from '../src/db/seed.js';

openDatabase(config.databasePath);
console.log(seedDemoData() ? 'Demo data loaded.' : 'Database already has locations — nothing to do.');
closeDatabase();
