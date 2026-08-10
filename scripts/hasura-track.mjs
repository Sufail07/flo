// Tracks application tables + the usage view, marks enum tables, and wires
// every relationship. Idempotent: already-tracked/exists errors are ignored.
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

const DATA_TABLES = [
  'organizations',
  'org_members',
  'workflows',
  'workflow_steps',
  'workflow_triggers',
  'workflow_runs',
  'step_runs',
  'workflow_artifacts',
  'notifications',
  'org_usage_events',
  'leads',
];

const VIEWS = ['org_usage_current_month'];

async function send(payload, label) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    let ignorable = false;
    try {
      const err = JSON.parse(text);
      const msg = JSON.stringify(err);
      ignorable =
        msg.includes('already tracked') ||
        msg.includes('already exists') ||
        msg.includes('already-tracked') ||
        msg.includes('already-exists');
    } catch {}
    if (ignorable) {
      console.log(`~ ${label}: already applied`);
      return;
    }
    console.error(`x ${label}: ${text.slice(0, 600)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`+ ${label}`);
}

// ------------------------------------------------------------------ track
const trackArgs = [...ENUM_TABLES, ...DATA_TABLES, ...VIEWS].map((name) => ({
  type: 'pg_track_table',
  args: { source: SOURCE, table: t(name) },
}));
await send({ type: 'bulk', args: trackArgs }, 'track tables');

// Enum tables must be flagged so Hasura emits real GraphQL enums.
for (const name of ENUM_TABLES) {
  await send(
    {
      type: 'pg_set_table_customization',
      args: {
        source: SOURCE,
        table: t(name),
        configuration: { custom_name: name },
      },
    },
    `customize ${name}`,
  );
  await send(
    { type: 'pg_track_table', args: { source: SOURCE, table: t(name), is_enum: true } },
    `enum ${name}`,
  );
}

// ---------------------------------------------------------- relationships
const objectRels = [
  // child -> parent
  ['org_members', 'org', 'org_id', 'organizations'],
  ['workflows', 'org', 'org_id', 'organizations'],
  ['workflow_steps', 'workflow', 'workflow_id', 'workflows'],
  ['workflow_steps', 'org', 'org_id', 'organizations'],
  ['workflow_triggers', 'workflow', 'workflow_id', 'workflows'],
  ['workflow_triggers', 'org', 'org_id', 'organizations'],
  ['workflow_runs', 'workflow', 'workflow_id', 'workflows'],
  ['workflow_runs', 'org', 'org_id', 'organizations'],
  ['workflow_runs', 'trigger', 'trigger_id', 'workflow_triggers'],
  ['step_runs', 'workflow_run', 'workflow_run_id', 'workflow_runs'],
  ['step_runs', 'step', 'step_id', 'workflow_steps'],
  ['step_runs', 'org', 'org_id', 'organizations'],
  ['workflow_artifacts', 'workflow_run', 'workflow_run_id', 'workflow_runs'],
  ['workflow_artifacts', 'org', 'org_id', 'organizations'],
  ['notifications', 'workflow_run', 'workflow_run_id', 'workflow_runs'],
  ['notifications', 'org', 'org_id', 'organizations'],
  ['org_usage_events', 'org', 'org_id', 'organizations'],
  ['leads', 'org', 'org_id', 'organizations'],
];

for (const [table, name, column] of objectRels) {
  await send(
    {
      type: 'pg_create_object_relationship',
      args: { source: SOURCE, table: t(table), name, using: { foreign_key_constraint_on: column } },
    },
    `obj ${table}.${name}`,
  );
}

const arrayRels = [
  // parent, relname, child table, child fk column
  ['organizations', 'members', 'org_members', 'org_id'],
  ['organizations', 'workflows', 'workflows', 'org_id'],
  ['organizations', 'runs', 'workflow_runs', 'org_id'],
  ['organizations', 'usage_events', 'org_usage_events', 'org_id'],
  ['organizations', 'leads', 'leads', 'org_id'],
  ['workflows', 'steps', 'workflow_steps', 'workflow_id'],
  ['workflows', 'triggers', 'workflow_triggers', 'workflow_id'],
  ['workflows', 'runs', 'workflow_runs', 'workflow_id'],
  ['workflow_runs', 'step_runs', 'step_runs', 'workflow_run_id'],
  ['workflow_runs', 'artifacts', 'workflow_artifacts', 'workflow_run_id'],
  ['workflow_runs', 'notifications', 'notifications', 'workflow_run_id'],
];

for (const [table, name, childTable, childColumn] of arrayRels) {
  await send(
    {
      type: 'pg_create_array_relationship',
      args: {
        source: SOURCE,
        table: t(table),
        name,
        using: { foreign_key_constraint_on: { table: t(childTable), column: childColumn } },
      },
    },
    `arr ${table}.${name}`,
  );
}

// The usage view has no FK, so its relationship is manual.
await send(
  {
    type: 'pg_create_object_relationship',
    args: {
      source: SOURCE,
      table: t('organizations'),
      name: 'usage',
      using: {
        manual_configuration: {
          remote_table: t('org_usage_current_month'),
          column_mapping: { id: 'org_id' },
        },
      },
    },
  },
  'obj organizations.usage',
);

await send(
  {
    type: 'pg_create_object_relationship',
    args: {
      source: SOURCE,
      table: t('org_usage_current_month'),
      name: 'org',
      using: {
        manual_configuration: {
          remote_table: t('organizations'),
          column_mapping: { org_id: 'id' },
        },
      },
    },
  },
  'obj org_usage_current_month.org',
);

console.log('\ndone');
