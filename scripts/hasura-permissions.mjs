// Layer 1 — org + role scoping (per permission_architecture.md).
// Role stays coarse ('user'); every rule joins out to org_members and checks the
// role there, scoped to the row's own org. workflow_runs/step_runs get NO user
// insert/update/delete: they are written exclusively by the Action handlers via
// the admin secret. Idempotent: existing permissions are dropped then recreated.
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
const UID = 'X-Hasura-User-Id';

// ------------------------------------------------------------------ filters
// "the caller is a member of the row's org"
const memberOf = (table) => {
  switch (table) {
    case 'organizations':
      return { members: { user_id: { _eq: UID } } };
    case 'org_members':
    case 'workflows':
    case 'org_usage_events':
    case 'leads':
      return { org: { members: { user_id: { _eq: UID } } } };
    case 'workflow_steps':
    case 'workflow_triggers':
      return { workflow: { org: { members: { user_id: { _eq: UID } } } } };
    case 'workflow_runs':
      return { workflow: { org: { members: { user_id: { _eq: UID } } } } };
    case 'step_runs':
    case 'workflow_artifacts':
    case 'notifications':
      return {
        workflow_run: { workflow: { org: { members: { user_id: { _eq: UID } } } } },
      };
    case 'org_usage_current_month':
      return { org: { members: { user_id: { _eq: UID } } } };
    default:
      throw new Error(`no member filter for ${table}`);
  }
};

const inOrgWithRole = (table, roles) => {
  const roleFilter = { user_id: { _eq: UID }, role: { _in: roles } };
  switch (table) {
    case 'organizations':
      return { members: roleFilter };
    case 'org_members':
    case 'workflows':
    case 'leads':
      return { org: { members: roleFilter } };
    case 'workflow_steps':
    case 'workflow_triggers':
      return { workflow: { org: { members: roleFilter } } };
    default:
      throw new Error(`no role filter for ${table}`);
  }
};

const EDITOR = ['owner', 'editor'];

// workflow_steps: editor+owner may write, but db_write / notify are owner-only.
// workflow_triggers: editor+owner may write, but webhook is owner-only.
const STEP_GATE = {
  gated: ['db_write', 'notify'],
  rel: 'workflow',
};
const TRIGGER_GATE = { gated: ['webhook'], rel: 'workflow' };

function stepGate(table, gate) {
  const ownerFilter = { user_id: { _eq: UID }, role: { _eq: 'owner' } };
  return {
    _and: [
      { [gate.rel]: { org: { members: { user_id: { _eq: UID }, role: { _in: EDITOR } } } } },
      {
        _or: [
          { type: { _nin: gate.gated } },
          { [gate.rel]: { org: { members: ownerFilter } } },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------- sender
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
      const msg = JSON.stringify(JSON.parse(text));
      ignorable =
        msg.includes('does not exist') ||
        msg.includes('not found') ||
        msg.includes('already exists') ||
        msg.includes('already-exists');
    } catch {}
    if (ignorable) {
      console.log(`~ ${label}: skipped`);
      return;
    }
    console.error(`x ${label}: ${text.slice(0, 600)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`+ ${label}`);
}

// -------------------------------------------------------------- permission
const OPS = {
  insert: 'pg_create_insert_permission',
  select: 'pg_create_select_permission',
  update: 'pg_create_update_permission',
  delete: 'pg_create_delete_permission',
};

const PLAN = [
  // table, perms[]
  {
    table: 'org_members',
    perms: [
      ['select', { filter: memberOf('org_members') }],
      ['insert', { check: inOrgWithRole('org_members', ['owner']) }],
      ['update', { filter: inOrgWithRole('org_members', ['owner']), check: inOrgWithRole('org_members', ['owner']) }],
      ['delete', { filter: inOrgWithRole('org_members', ['owner']) }],
    ],
  },
  {
    table: 'organizations',
    perms: [['select', { filter: memberOf('organizations') }]],
  },
  {
    table: 'workflows',
    perms: [
      ['select', { filter: memberOf('workflows') }],
      ['insert', { check: inOrgWithRole('workflows', EDITOR) }],
      ['update', { filter: inOrgWithRole('workflows', EDITOR), check: inOrgWithRole('workflows', EDITOR) }],
      ['delete', { filter: inOrgWithRole('workflows', ['owner']) }],
    ],
  },
  {
    table: 'workflow_steps',
    perms: [
      ['select', { filter: memberOf('workflow_steps') }],
      ['insert', { check: stepGate('workflow_steps', STEP_GATE) }],
      ['update', { filter: stepGate('workflow_steps', STEP_GATE), check: stepGate('workflow_steps', STEP_GATE) }],
      ['delete', { filter: stepGate('workflow_steps', STEP_GATE) }],
    ],
  },
  {
    table: 'workflow_triggers',
    perms: [
      ['select', { filter: memberOf('workflow_triggers') }],
      ['insert', { check: stepGate('workflow_triggers', TRIGGER_GATE) }],
      ['update', { filter: stepGate('workflow_triggers', TRIGGER_GATE), check: stepGate('workflow_triggers', TRIGGER_GATE) }],
      ['delete', { filter: stepGate('workflow_triggers', TRIGGER_GATE) }],
    ],
  },
  {
    table: 'workflow_runs',
    perms: [['select', { filter: memberOf('workflow_runs') }]],
  },
  {
    table: 'step_runs',
    perms: [['select', { filter: memberOf('step_runs') }]],
  },
  {
    table: 'workflow_artifacts',
    perms: [['select', { filter: memberOf('workflow_artifacts') }]],
  },
  {
    table: 'notifications',
    perms: [['select', { filter: memberOf('notifications') }]],
  },
  {
    table: 'org_usage_events',
    perms: [['select', { filter: memberOf('org_usage_events') }]],
  },
  {
    table: 'org_usage_current_month',
    perms: [['select', { filter: memberOf('org_usage_current_month') }]],
  },
  {
    table: 'leads',
    perms: [
      ['select', { filter: memberOf('leads') }],
      ['insert', { check: inOrgWithRole('leads', EDITOR) }],
    ],
  },
];

// Drop first so re-runs after edits are clean; "does not exist" is skipped.
for (const { table, perms } of PLAN) {
  for (const [op] of perms) {
    await send(
      {
        type: `pg_drop_${op}_permission`,
        args: { source: SOURCE, table: t(table), role: 'user' },
      },
      `drop ${table}.${op}`,
    );
  }
}

for (const { table, perms } of PLAN) {
  for (const [op, permission] of perms) {
    if (op !== 'delete') permission.columns = '*';
    await send(
      { type: OPS[op], args: { source: SOURCE, table: t(table), role: 'user', permission } },
      `${table}.${op}`,
    );
  }
}

console.log('\ndone');
