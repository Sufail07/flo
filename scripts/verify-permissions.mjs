// Layer-1 permission verification against the running stack.
// Simulates user sessions via x-hasura-role/x-hasura-user-id headers and
// asserts the isolation + role matrix from permission_architecture.md.
// Run with: node scripts/verify-permissions.mjs
import fs from 'node:fs';

const GRAPHQL = 'https://local.hasura.local.nhost.run/v1/graphql';

const secrets = fs.readFileSync(new URL('../.secrets', import.meta.url), 'utf8');
const ADMIN = secrets
  .split('\n')
  .find((l) => l.startsWith('HASURA_GRAPHQL_ADMIN_SECRET'))
  .split('=')[1]
  .trim()
  .replace(/'/g, '');

// idempotently read back the seeded ids so the check survives DB churn
async function gql(query, variables = {}, headers = {}) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

const ADMIN_HDRS = { 'x-hasura-admin-secret': ADMIN };
// Hasura only honours x-hasura-role/x-hasura-user-id when the request is
// already authenticated as admin — without the secret it falls back to the
// public role and every query errors instead of returning a scoped result.
const asUser = (id) => ({
  ...ADMIN_HDRS,
  'x-hasura-role': 'user',
  'x-hasura-user-id': id,
});

const {
  body: { data: orgData },
} = await gql(
  `query { organizations(where: { slug: { _in: ["acme", "globex"] } }) { id slug } }`,
  {},
  ADMIN_HDRS,
);
const orgA = orgData.organizations.find((o) => o.slug === 'acme').id;
const orgB = orgData.organizations.find((o) => o.slug === 'globex').id;

const {
  body: { data: memData },
} = await gql(
  `query { org_members(where: { org: { slug: { _in: ["acme", "globex"] } } }) { user_id org { slug } role } }`,
  {},
  ADMIN_HDRS,
);
const find = (emailLocal, slug, role) =>
  memData.org_members.find(
    (m) => m.org.slug === slug && m.role === role && m.user_id,
  );

// resolve user ids by email via auth
const {
  body: { data: userData },
} = await gql(
  `query { users(where: { email: { _in: ["alice@acme.test","bob@acme.test","carol@acme.test","dave@globex.test"] } }) { id email } }`,
  {},
  ADMIN_HDRS,
);
const uid = (email) => userData.users.find((u) => u.email === email).id;
const ALICE = uid('alice@acme.test'); // owner A
const BOB = uid('bob@acme.test'); // editor A
const CAROL = uid('carol@acme.test'); // viewer A
const DAVE = uid('dave@globex.test'); // editor B

const {
  body: { data: wfData },
} = await gql(
  `query { workflows(where: { org_id: { _eq: $orgA } }) { id } }`.replace('$orgA', `"${orgA}"`),
  {},
  ADMIN_HDRS,
);
const WF_A = wfData.workflows[0].id;

// A denial is either a permission error or — when the role has no permission
// for that op at all — the mutation field being absent from the schema entirely.
const isDenied = (body) =>
  !!body.errors?.some((e) =>
    /permission|not authorised|not authorized|not found in type/i.test(e.message),
  );

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  ok ? pass++ : fail++;
};

// 1. cross-org read: Org B editor queries Org A workflow by direct id -> empty
{
  const { body } = await gql(
    `query ($id: uuid!) { workflows(where: { id: { _eq: $id } }) { id name } }`,
    { id: WF_A },
    asUser(DAVE),
  );
  const empty = body.data.workflows.length === 0;
  check('Org B editor reads Org A workflow by ID -> empty', empty,
    `returned ${body.data.workflows.length} rows`);
}

// 2. cross-org read: Org B editor lists Org A workflows -> empty
{
  const { body } = await gql(
    `query { workflows(where: { org_id: { _eq: $org } }) { id } }`.replace('$org', `"${orgA}"`),
    {},
    asUser(DAVE),
  );
  check('Org B editor lists Org A workflows -> empty', body.data.workflows.length === 0);
}

// 3. cross-org read: Org B editor reads Org A org -> empty
{
  const { body } = await gql(
    `query { organizations(where: { id: { _eq: $org } }) { id } }`.replace('$org', `"${orgA}"`),
    {},
    asUser(DAVE),
  );
  check('Org B editor reads Org A org -> empty', body.data.organizations.length === 0);
}

// 4. editor can see own org's workflow + steps
{
  const { body } = await gql(
    `query ($org: uuid!) { workflows(where: { org_id: { _eq: $org } }) { id steps { id } triggers { id } } }`,
    { org: orgA },
    asUser(BOB),
  );
  const ok =
    body.data.workflows.length === 1 &&
    body.data.workflows[0].steps.length >= 3 &&
    body.data.workflows[0].triggers.length >= 1;
  check('Org A editor sees own workflow + steps + triggers', ok,
    `steps=${body.data.workflows[0]?.steps?.length ?? 0} triggers=${body.data.workflows[0]?.triggers?.length ?? 0}`);
}

// 5. editor cannot insert a db_write step (owner-only step type)
{
  const { body } = await gql(
    `mutation ($obj: workflow_steps_insert_input!) {
       insert_workflow_steps_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: WF_A, name: 'sneaky', type: 'db_write', position: 99, config: {} } },
    asUser(BOB),
  );
  const denied = isDenied(body);
  check('Org A editor inserts db_write step -> denied by Hasura', denied);
}

// 6. editor cannot insert a webhook trigger (owner-only trigger type)
{
  const { body } = await gql(
    `mutation ($obj: workflow_triggers_insert_input!) {
       insert_workflow_triggers_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: WF_A, type: 'webhook', config: {} } },
    asUser(BOB),
  );
  const denied = isDenied(body);
  check('Org A editor inserts webhook trigger -> denied by Hasura', denied);
}

// 7. viewer cannot write run state (no insert/update permission at all)
{
  const { body } = await gql(
    `mutation ($obj: workflow_runs_insert_input!) {
       insert_workflow_runs_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: WF_A, trigger_type: 'manual', status: 'running' } },
    asUser(CAROL),
  );
  const denied = isDenied(body);
  check('Viewer inserts workflow_run -> denied by Hasura', denied);
}

// 8. editor cannot directly update a step_run status (PATCH-your-own-run closed)
{
  const { body } = await gql(
    `mutation { update_step_runs(where: { workflow_run: { workflow_id: { _eq: $wf } } }, _set: { status: "succeeded" }) { affected_rows } }`.replace(
      '$wf',
      `"${WF_A}"`,
    ),
    {},
    asUser(BOB),
  );
  const denied = isDenied(body);
  check('Editor updates step_run status directly -> denied by Hasura', denied);
}

// 9. owner CAN insert a db_write step (positive control)
{
  const { body } = await gql(
    `mutation ($obj: workflow_steps_insert_input!) {
       insert_workflow_steps_one(object: $obj) { id }
     }`,
    { obj: { workflow_id: WF_A, name: 'owner-write', type: 'db_write', position: 99, config: {} } },
    asUser(ALICE),
  );
  const allowed = body.data?.insert_workflow_steps_one?.id;
  check('Org A owner inserts db_write step -> allowed', !!allowed);
  if (allowed) {
    await gql(
      `mutation { delete_workflow_steps(where: { id: { _eq: $id } }) { affected_rows } }`.replace(
        '$id',
        `"${allowed}"`,
      ),
      {},
      ADMIN_HDRS,
    );
  }
}

// 10. owner can view membership roster of their org (org_members select)
{
  const { body } = await gql(
    `query ($org: uuid!) { org_members(where: { org_id: { _eq: $org } }) { user_id role } }`,
    { org: orgA },
    asUser(ALICE),
  );
  check('Org A owner sees org roster', body.data.org_members.length === 3);
}

// 11. usage view scoped: Org A member can read own usage, Org B member cannot
{
  const { body } = await gql(
    `query ($org: uuid!) { org_usage_current_month(where: { org_id: { _eq: $org } }) { org_id quota_limit } }`,
    { org: orgA },
    asUser(BOB),
  );
  check('Org A editor reads own usage view', body.data.org_usage_current_month.length === 1);
  const { body: b2 } = await gql(
    `query ($org: uuid!) { org_usage_current_month(where: { org_id: { _eq: $org } }) { org_id } }`,
    { org: orgA },
    asUser(DAVE),
  );
  check('Org B editor reads Org A usage view -> empty', b2.data.org_usage_current_month.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
