// Idempotent seed for the remote Nhost cloud deployment.
// Mirrors scripts/seed-dev-data.mjs but targets the hosted backend:
//   - creates users via the nhost auth signup endpoint
//   - creates orgs, memberships, one sample workflow + steps + triggers
//     via the admin GraphQL endpoint
// Safe to re-run.
import fs from 'node:fs';

const SUBDOMAIN = 'nrsxprcicgejgesfiomt';
const REGION = 'ap-south-1';

const GRAPHQL = `https://${SUBDOMAIN}.graphql.${REGION}.nhost.run/v1`;
const AUTH = `https://${SUBDOMAIN}.auth.${REGION}.nhost.run/v1/signup/email-password`;

const secrets = fs.readFileSync(new URL('../.secrets', import.meta.url), 'utf8');
const ADMIN = secrets
  .split('\n')
  .find((l) => l.startsWith('HASURA_GRAPHQL_ADMIN_SECRET'))
  .split('=')[1]
  .trim()
  .replace(/'/g, '');

const PASSWORD = 'DevPass12345!';

const USERS = [
  { email: 'alice@acme.test', name: 'Alice' },
  { email: 'bob@acme.test', name: 'Bob' },
  { email: 'carol@acme.test', name: 'Carol' },
  { email: 'dave@globex.test', name: 'Dave' },
];

async function gql(query, variables = {}) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hasura-admin-secret': ADMIN,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (text.trim()) {
      const body = JSON.parse(text);
      if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
      return body.data;
    }
    if (attempt >= 3) throw new Error(`empty GraphQL response for: ${query.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function signupOrFetch(email, name) {
  const res = await fetch(AUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      options: { displayName: name },
    }),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* empty / non-JSON error body (e.g. rate-limited 429) */
  }
  const userId = body?.session?.user?.id ?? body?.user?.id;
  if (userId) return userId;
  const { users: auth_users } = await gql(
    `query ($email: citext!) { users(where: { email: { _eq: $email } }) { id } }`,
    { email },
  );
  if (auth_users[0]) return auth_users[0].id;
  throw new Error(`signup failed for ${email}: ${JSON.stringify(body)}`);
}

const users = {};
for (const u of USERS) {
  users[u.email] = await signupOrFetch(u.email, u.name);
  console.log(`+ user ${u.email} -> ${users[u.email]}`);
}

const orgs = {};
for (const o of [
  { slug: 'acme', name: 'Acme Corp' },
  { slug: 'globex', name: 'Globex' },
]) {
  const { organizations } = await gql(
    `query ($slug: String!) { organizations(where: { slug: { _eq: $slug } }) { id name quota_limit quota_used } }`,
    { slug: o.slug },
  );
  if (organizations[0]) {
    orgs[o.slug] = organizations[0].id;
    console.log(`~ org ${o.slug} exists (${orgs[o.slug]})`);
  } else {
    const { insert_organizations_one } = await gql(
      `mutation ($name: String!, $slug: String!) {
         insert_organizations_one(object: { name: $name, slug: $slug }) { id }
       }`,
      { name: o.name, slug: o.slug },
    );
    orgs[o.slug] = insert_organizations_one.id;
    console.log(`+ org ${o.slug} -> ${orgs[o.slug]}`);
  }
}

const MEMBERS = [
  ['alice@acme.test', 'acme', 'owner'],
  ['bob@acme.test', 'acme', 'editor'],
  ['carol@acme.test', 'acme', 'viewer'],
  ['dave@globex.test', 'globex', 'editor'],
];

for (const [email, slug, role] of MEMBERS) {
  const { org_members } = await gql(
    `query ($org_id: uuid!, $user_id: uuid!) {
       org_members(where: { org_id: { _eq: $org_id }, user_id: { _eq: $user_id } }) { id }
     }`,
    { org_id: orgs[slug], user_id: users[email] },
  );
  if (org_members[0]) {
    console.log(`~ member ${email} in ${slug} (${role}) exists`);
    continue;
  }
  await gql(
    `mutation ($org_id: uuid!, $user_id: uuid!, $role: org_roles_enum!) {
       insert_org_members_one(object: { org_id: $org_id, user_id: $user_id, role: $role }) { id }
     }`,
    { org_id: orgs[slug], user_id: users[email], role },
  );
  console.log(`+ member ${email} in ${slug} as ${role}`);
}

// Org-A sample workflow: llm_call -> conditional_branch -> approval_gate
let workflowId;
const { workflows } = await gql(
  `query ($org_id: uuid!) { workflows(where: { org_id: { _eq: $org_id } }) { id name } }`,
  { org_id: orgs.acme },
);
if (workflows[0]) {
  workflowId = workflows[0].id;
  console.log(`~ workflow exists (${workflowId})`);
} else {
  const { insert_workflows_one } = await gql(
    `mutation ($org_id: uuid!, $name: String!, $created_by: uuid!) {
       insert_workflows_one(object: { org_id: $org_id, name: $name, created_by: $created_by }) { id }
     }`,
    { org_id: orgs.acme, name: 'Lead qualification', created_by: users['alice@acme.test'] },
  );
  workflowId = insert_workflows_one.id;
  console.log(`+ workflow -> ${workflowId}`);
}

const steps = [
  {
    name: 'Classify lead',
    type: 'llm_call',
    position: 1,
    config: {
      prompt_template:
        'Classify this lead as "hot", "warm", or "cold": {{run.input.lead}}',
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    },
  },
  {
    name: 'Is it hot?',
    type: 'conditional_branch',
    position: 2,
    config: { source: 'steps.Classify lead.output.text', operator: 'contains', value: 'hot' },
  },
  {
    name: 'Human approval',
    type: 'approval_gate',
    position: 3,
    config: { note: 'Confirm the hot lead before outreach' },
  },
];

const { workflow_steps: existingSteps } = await gql(
  `query ($workflow_id: uuid!) { workflow_steps(where: { workflow_id: { _eq: $workflow_id } }) { position } }`,
  { workflow_id: workflowId },
);
const present = new Set(existingSteps.map((s) => s.position));
for (const s of steps) {
  if (present.has(s.position)) {
    console.log(`~ step ${s.position}: ${s.type} exists`);
    continue;
  }
  await gql(
    `mutation ($obj: workflow_steps_insert_input!) {
       insert_workflow_steps_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: workflowId, ...s } },
  );
  console.log(`+ step ${s.position}: ${s.type}`);
}
const { workflow_triggers } = await gql(
  `query ($workflow_id: uuid!) { workflow_triggers(where: { workflow_id: { _eq: $workflow_id } }) { id } }`,
  { workflow_id: workflowId },
);
if (workflow_triggers.length === 0) {
  await gql(
    `mutation ($obj: workflow_triggers_insert_input!) {
       insert_workflow_triggers_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: workflowId, type: 'manual', config: {} } },
  );
  console.log('+ trigger: manual');
} else {
  console.log('~ manual trigger exists');
}

// Also wire the webhook + database_event triggers the actions/events rely on.
const triggerTypes = ['webhook', 'database_event'];
for (const type of triggerTypes) {
  const { workflow_triggers: existing } = await gql(
    `query ($workflow_id: uuid!, $type: trigger_types_enum!) {
       workflow_triggers(where: { workflow_id: { _eq: $workflow_id }, type: { _eq: $type } }) { id }
     }`,
    { workflow_id: workflowId, type },
  );
  if (existing.length > 0) {
    console.log(`~ trigger: ${type} exists`);
    continue;
  }
  await gql(
    `mutation ($obj: workflow_triggers_insert_input!) {
       insert_workflow_triggers_one(object: $obj) { id }
     }`,
    {
      obj: {
        workflow_id: workflowId,
        type,
        config: {},
        ...(type === 'webhook'
          ? { webhook_token: `dev-webhook-${workflowId.slice(0, 8)}` }
          : {}),
      },
    },
  );
  console.log(`+ trigger: ${type}`);
}

console.log('\n--- remote seed ready ---');
console.log(`Org A (acme):     ${orgs.acme}`);
console.log(`Org B (globex):   ${orgs.globex}`);
console.log(`Workflow A:       ${workflowId}`);
for (const u of USERS) console.log(`  ${u.email.padEnd(24)} ${users[u.email]}`);
console.log(`\nAll dev users share password: ${PASSWORD}`);
