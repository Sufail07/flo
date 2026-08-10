// Exports Hasura metadata to nhost/metadata/ so schema, relationships and
// both permission layers are committed as reviewable deliverables.
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT =
  process.env.HASURA_ENDPOINT ?? 'https://local.hasura.local.nhost.run/v1/metadata';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const secrets = fs.readFileSync(path.join(root, '.secrets'), 'utf8');
const ADMIN = secrets
  .split('\n')
  .find((l) => l.startsWith('HASURA_GRAPHQL_ADMIN_SECRET'))
  .split('=')[1]
  .trim()
  .replace(/'/g, '');

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN },
  body: JSON.stringify({ type: 'export_metadata', args: {} }),
});

if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}

const metadata = await res.json();
const outDir = path.join(root, 'nhost', 'metadata');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'metadata.json');
fs.writeFileSync(outFile, JSON.stringify(metadata, null, 2) + '\n');

const source = metadata.sources.find((s) => s.name === 'default');
console.log(`exported ${source.tables.length} tracked tables -> nhost/metadata/metadata.json`);
