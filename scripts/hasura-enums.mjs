// Sets is_enum on the enum tables. pg_track_table cannot flip is_enum on an
// already-tracked table, so this untracks and re-tracks each one.
import fs from 'node:fs';

const ENDPOINT =
  process.env.HASURA_ENDPOINT ?? 'https://local.hasura.local.nhost.run/v1/metadata';

const secrets = fs.readFileSync(new URL('../.secrets', import.meta.url), 'utf8');
const ADMIN = secrets
  .split('\n')
  .find((l) => l.startsWith('HASURA_GRAPHQL_ADMIN_SECRET'))
  .split('=')[1]
  .trim()
  .replace(/'/g, '');

const SOURCE = 'default';
const t = (name) => ({ schema: 'public', name });

const ENUM_TABLES = [
  'org_roles',
  'step_types',
  'trigger_types',
  'run_statuses',
  'step_run_statuses',
];

async function send(payload, label, { allowFail = false } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    if (allowFail) {
      console.log(`~ ${label}: ${text.slice(0, 160)}`);
      return false;
    }
    console.error(`x ${label}: ${text.slice(0, 600)}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`+ ${label}`);
  return true;
}

for (const name of ENUM_TABLES) {
  // Untrack cascades away the relationships pointing at this table; they are
  // recreated by hasura-track.mjs on the next run.
  await send(
    { type: 'pg_untrack_table', args: { source: SOURCE, table: t(name), cascade: true } },
    `untrack ${name}`,
    { allowFail: true },
  );
  await send(
    { type: 'pg_track_table', args: { source: SOURCE, table: t(name), is_enum: true } },
    `track ${name} as enum`,
  );
}

console.log('\ndone');
