// Registers the three Hasura Actions (triggerWorkflowRun, approveStep,
// webhookTriggerRun) plus the two event triggers (notifications -> deliver,
// leads -> database_event start). Idempotent: existing objects are dropped
// first, then recreated. Run with the stack up.
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
const SECRET_HEADER = { name: 'nhost-webhook-secret', value_from_env: 'NHOST_WEBHOOK_SECRET' };

async function send(payload, label, { allowFail = false } = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    if (allowFail) {
      console.log(`~ ${label}: skipped (${text.slice(0, 160)})`);
      return false;
    }
    console.error(`x ${label}: ${text.slice(0, 600)}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`+ ${label}`);
  return true;
}

// ------------------------------------------------------------ custom types

const OUTPUT_TYPES = [
  {
    name: 'TriggerWorkflowRunOutput',
    fields: [
      { name: 'run_id', type: 'uuid!' },
      { name: 'status', type: 'String!' },
      { name: 'paused_at_step_run_id', type: 'uuid' },
    ],
  },
  {
    name: 'ApproveStepOutput',
    fields: [
      { name: 'run_id', type: 'uuid!' },
      { name: 'status', type: 'String!' },
      { name: 'approved_by', type: 'uuid!' },
    ],
  },
  {
    name: 'WebhookTriggerRunOutput',
    fields: [
      { name: 'run_id', type: 'uuid!' },
      { name: 'status', type: 'String!' },
      { name: 'paused_at_step_run_id', type: 'uuid' },
    ],
  },
];

await send(
  {
    type: 'set_custom_types',
    args: { enums: [], input_objects: [], objects: OUTPUT_TYPES, scalars: [] },
  },
  'set custom types',
);

// ----------------------------------------------------------------- actions

const ACTIONS = [
  {
    name: 'triggerWorkflowRun',
    definition: {
      kind: 'synchronous',
      type: 'mutation',
      arguments: [{ name: 'workflow_id', type: 'uuid!' }],
      output_type: 'TriggerWorkflowRunOutput',
      handler: '{{NHOST_FUNCTIONS_URL}}/actions/trigger-workflow-run',
      headers: [SECRET_HEADER],
    },
  },
  {
    name: 'approveStep',
    definition: {
      kind: 'synchronous',
      type: 'mutation',
      arguments: [{ name: 'step_run_id', type: 'uuid!' }],
      output_type: 'ApproveStepOutput',
      handler: '{{NHOST_FUNCTIONS_URL}}/actions/approve-step',
      headers: [SECRET_HEADER],
    },
  },
  {
    name: 'webhookTriggerRun',
    definition: {
      kind: 'synchronous',
      type: 'mutation',
      arguments: [
        { name: 'token', type: 'String!' },
        { name: 'payload', type: 'jsonb' },
      ],
      output_type: 'WebhookTriggerRunOutput',
      handler: '{{NHOST_FUNCTIONS_URL}}/actions/webhook-trigger',
      headers: [SECRET_HEADER],
    },
  },
];

for (const action of ACTIONS) {
  await send(
    { type: 'drop_action', args: { name: action.name } },
    `drop ${action.name}`,
    { allowFail: true },
  );
  await send(
    { type: 'create_action', args: action },
    `action ${action.name}`,
  );
}

// Action permissions are managed separately from the action definition.
// triggerWorkflowRun / approveStep require a session (user role); the webhook
// action is exposed to public so external systems can call it with a token.
const ACTION_PERMS = [
  { action: 'triggerWorkflowRun', role: 'user' },
  { action: 'approveStep', role: 'user' },
  { action: 'webhookTriggerRun', role: 'public' },
  { action: 'webhookTriggerRun', role: 'user' },
];

for (const { action, role } of ACTION_PERMS) {
  await send(
    { type: 'create_action_permission', args: { action, role } },
    `perm ${action} (${role})`,
    { allowFail: true },
  );
}

// -------------------------------------------------------- event triggers

await send(
  {
    type: 'pg_delete_event_trigger',
    args: { source: SOURCE, table: { schema: 'public', name: 'notifications' }, name: 'notify_delivery' },
  },
  'drop notify_delivery',
  { allowFail: true },
);
await send(
  {
    type: 'pg_create_event_trigger',
    args: {
      name: 'notify_delivery',
      source: SOURCE,
      table: { schema: 'public', name: 'notifications' },
      insert: { columns: '*' },
      webhook: '{{NHOST_FUNCTIONS_URL}}/events/deliver-notification',
      headers: [SECRET_HEADER],
      retry_conf: { interval_sec: 10, num_retries: 3, timeout_sec: 60 },
    },
  },
  'event trigger notify_delivery',
);

await send(
  {
    type: 'pg_delete_event_trigger',
    args: { source: SOURCE, table: { schema: 'public', name: 'leads' }, name: 'lead_created' },
  },
  'drop lead_created',
  { allowFail: true },
);
await send(
  {
    type: 'pg_create_event_trigger',
    args: {
      name: 'lead_created',
      source: SOURCE,
      table: { schema: 'public', name: 'leads' },
      insert: { columns: '*' },
      webhook: '{{NHOST_FUNCTIONS_URL}}/events/lead-created',
      headers: [SECRET_HEADER],
      retry_conf: { interval_sec: 10, num_retries: 3, timeout_sec: 60 },
    },
  },
  'event trigger lead_created',
);

console.log('\ndone');
