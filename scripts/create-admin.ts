import { createAdmin, passwordProblems, setAdminPassword } from '../src/admin/auth.js';
import { config } from '../src/config.js';
import { closeDatabase, get, openDatabase } from '../src/db/index.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run create-admin -- <username> <password>');
  process.exit(1);
}
const problem = passwordProblems(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
openDatabase(config.databasePath);
const existing = get<{ id: number }>('SELECT id FROM admins WHERE username = ?', username);
if (existing) {
  setAdminPassword(existing.id, password);
  console.log(`Password updated for admin "${username}".`);
} else {
  createAdmin(username, password);
  console.log(`Admin "${username}" created.`);
}
closeDatabase();
