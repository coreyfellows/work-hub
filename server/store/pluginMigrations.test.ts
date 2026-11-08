import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './db.ts';
import { migratePlugin } from './pluginMigrations.ts';

function fresh(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  migrate(d);
  return d;
}
const hasTable = (d: DatabaseSync, name: string) =>
  d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;

test('core migrations reach version 16 and create plugin_migrations', () => {
  const d = fresh();
  assert.equal((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
  assert.ok(hasTable(d, 'plugin_migrations'));
});

test('migratePlugin runs steps once and only the new ones later', () => {
  const d = fresh();
  assert.equal(migratePlugin(d, 'x', ['CREATE TABLE x_a(i)']), 1);
  assert.ok(hasTable(d, 'x_a'));
  assert.equal(migratePlugin(d, 'x', ['CREATE TABLE x_a(i)', 'CREATE TABLE x_b(i)']), 2);
  assert.ok(hasTable(d, 'x_b'));
  assert.equal(migratePlugin(d, 'x', []), 2);
  assert.equal(migratePlugin(d, 'empty', []), 0);
});

test('a failing step rolls back, keeps the earlier version and names the plugin', () => {
  const d = fresh();
  migratePlugin(d, 'y', ['CREATE TABLE y_a(i)']);
  assert.throws(() => migratePlugin(d, 'y', ['CREATE TABLE y_a(i)', 'CREATE TABLE y_b(i); SELECT nope FROM missing']), /y.*step 2/);
  assert.equal(hasTable(d, 'y_b'), false);
  const row = d.prepare('SELECT version FROM plugin_migrations WHERE plugin = ?').get('y') as { version: number };
  assert.equal(row.version, 1);
});
