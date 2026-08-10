// Layer-2 verification: action + event handlers against the running stack.
// Asserts the runtime authorization + workflow engine behavior that Hasura
// permissions alone cannot (the handlers run with admin rights).
// Run with: node scripts/verify-actions.mjs
import fs from 'node:fs';

const GRAPHQL = 'https://local.hasura.local.nhost.run/v1/graphql';

const secrets = fs.readFileSync(new URL('../.secrets', import.meta.url), 'utf8');
const ADMIN = secrets
  .split('\n')
  .find((l) => l.startsWith('HASURA_GRAPHQL_ADMIN_SECRET'))
  .split('=')[1]
  .trim()
  .replace(/'/g, '');

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
const asUser = (id) => ({ ...ADMIN_HDRS, 'x-hasura-role': 'user', 'x-hasura-user-id': id });

// idempotent id resolution (survives DB churn)
const { body: { data: orgData } } = await gql(
  `query { organizations(where: { slug: { _eq: "acme" } }) { id quota_limit } }`,
  {},
  ADMIN_HDRS,
);
const ORG_A = orgData.organizations[0].id;

const { body: { data: userData } } = await gql(
  `query { users(where: { email: { _in: ["alice@acme.test","bob@acme.test","carol@acme.test","dave@globex.test"] } }) { id email } }`,
  {},
  ADMIN_HDRS,
);
const uid = (email) => userData.users.find((u) => u.email === email).id;
const ALICE = uid('alice@acme.test');
const BOB = uid('bob@acme.test');
const CAROL = uid('carol@acme.test');
const DAVE = uid('dave@globex.test');

const { body: { data: wfData } } = await gql(
  `query { workflows(where: { org_id: { _eq: $org } }) { id } }`.replace('$org', `"${ORG_A}"`),
  {},
  ADMIN_HDRS,
);
const WF_A = wfData.workflows[0].id;

// webhook token for the seeded webhook trigger (or seed a fresh one)
let webhookToken;
{
  const { body } = await gql(
    `query { workflow_triggers(where: { workflow_id: { _eq: $wf }, type: { _eq: webhook } }) { id webhook_token } }`.replace('$wf', `"${WF_A}"`),
    {},
    ADMIN_HDRS,
  );
  if (!body.data?.workflow_triggers) {
    console.error('webhook trigger query failed:', JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }
  const tr = body.data.workflow_triggers[0];
  if (tr?.webhook_token) {
    webhookToken = tr.webhook_token;
  } else if (tr) {
    await gql(
      `mutation ($id: uuid!) { update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { webhook_token: "verify-webhook-token" }) { id } }`,
      { id: tr.id },
      ADMIN_HDRS,
    );
    webhookToken = 'verify-webhook-token';
  }
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  ok ? pass++ : fail++;
};

const errors = (body) => body.errors?.map((e) => e.message).join('; ') ?? '';

// --- trigger ------------------------------------------------------------

// 1. owner triggers run -> pauses at the approval gate
const run1 = await gql(
  `mutation ($wf: uuid!) { triggerWorkflowRun(workflow_id: $wf) { run_id status paused_at_step_run_id } }`,
  { wf: WF_A },
  asUser(ALICE),
);
{
  const d = run1.body.data?.triggerWorkflowRun;
  check('owner trigger -> paused at gate', !!d && d.status === 'paused' && !!d.paused_at_step_run_id,
    d ? `status=${d.status}` : errors(run1.body));
}

// 2. viewer cannot trigger (Layer-2 role check)
const run2 = await gql(
  `mutation ($wf: uuid!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
  { wf: WF_A },
  asUser(CAROL),
);
{
  const denied = !!run2.body.errors?.some((e) => /forbidden|not permitted/i.test(e.message));
  check('viewer trigger -> forbidden', denied, errors(run2.body));
}

// 3. cross-org editor cannot trigger
const run3 = await gql(
  `mutation ($wf: uuid!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
  { wf: WF_A },
  asUser(DAVE),
);
{
  const denied = !!run3.body.errors?.some((e) => /forbidden|not permitted/i.test(e.message));
  check('cross-org editor trigger -> forbidden', denied, errors(run3.body));
}

// 4. unknown workflow -> 404
const run4 = await gql(
  `mutation { triggerWorkflowRun(workflow_id: "00000000-0000-0000-0000-000000000000") { run_id status } }`,
  {},
  asUser(ALICE),
);
{
  const notFound = !!run4.body.errors?.some((e) => /not found/i.test(e.message));
  check('trigger unknown workflow -> 404', notFound, errors(run4.body));
}

// --- approve ------------------------------------------------------------

const GATE = run1.body.data?.triggerWorkflowRun?.paused_at_step_run_id;

// 5. viewer cannot approve
if (GATE) {
  const a5 = await gql(
    `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_id } }`,
    { id: GATE },
    asUser(CAROL),
  );
  const denied = !!a5.body.errors?.some((e) => /forbidden|not permitted/i.test(e.message));
  check('viewer approve -> forbidden', denied, errors(a5.body));
}

// 6. cross-org editor cannot approve
if (GATE) {
  const a6 = await gql(
    `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_id } }`,
    { id: GATE },
    asUser(DAVE),
  );
  const denied = !!a6.body.errors?.some((e) => /forbidden|not permitted/i.test(e.message));
  check('cross-org editor approve -> forbidden', denied, errors(a6.body));
}

// 7. editor approves -> run resumes to succeeded (approval is Layer-2 and
//    the editor role is derived from org_members, not the claimed header)
let resumed = false;
if (GATE) {
  const a7 = await gql(
    `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_id status } }`,
    { id: GATE },
    asUser(BOB),
  );
  resumed = a7.body.data?.approveStep?.status === 'succeeded';
  check('editor approve -> run succeeds', resumed,
    a7.body.data?.approveStep?.status ?? errors(a7.body));
}

// 8. double-approve -> 409 (gate already final)
if (GATE) {
  const a8 = await gql(
    `mutation ($id: uuid!) { approveStep(step_run_id: $id) { run_id } }`,
    { id: GATE },
    asUser(ALICE),
  );
  const conflict = !!a8.body.errors?.some((e) => /not awaiting approval/i.test(e.message));
  check('double approve -> 409 conflict', conflict, errors(a8.body));
}

// --- webhook ------------------------------------------------------------

// 9. valid webhook token (public role) starts a run
if (webhookToken) {
  const w9 = await gql(
    `mutation ($token: String!) { webhookTriggerRun(token: $token, payload: { source: "verify" }) { run_id status } }`,
    { token: webhookToken },
    { ...ADMIN_HDRS, 'x-hasura-role': 'public' },
  );
  const ok = !!w9.body.data?.webhookTriggerRun?.run_id;
  check('webhook valid token -> run started', ok, errors(w9.body));
}

// 10. invalid webhook token -> 404
{
  const w10 = await gql(
    `mutation { webhookTriggerRun(token: "bogus-token", payload: {}) { run_id status } }`,
    {},
    { ...ADMIN_HDRS, 'x-hasura-role': 'public' },
  );
  const notFound = !!w10.body.errors?.some((e) => /not found/i.test(e.message));
  check('webhook invalid token -> 404', notFound, errors(w10.body));
}

// --- quota --------------------------------------------------------------

// 11. quota exhaustion -> 429 (quota-exhausted code), then restored
{
  await gql(
    `mutation ($org: uuid!) { update_organizations(where: { id: { _eq: $org } }, _set: { quota_used: 100 }) { affected_rows } }`,
    { org: ORG_A },
    ADMIN_HDRS,
  );
  const q11 = await gql(
    `mutation ($wf: uuid!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
    { wf: WF_A },
    asUser(ALICE),
  );
  const quotaExhausted = !!q11.body.errors?.some((e) => /quota exhausted/i.test(e.message));
  check('quota exhausted -> 429 quota-exhausted', quotaExhausted, errors(q11.body));
  await gql(
    `mutation ($org: uuid!) { update_organizations(where: { id: { _eq: $org } }, _set: { quota_used: 0 }) { affected_rows } }`,
    { org: ORG_A },
    ADMIN_HDRS,
  );
}

// --- event trigger ------------------------------------------------------

// 12. database_event trigger: insert a lead -> a run appears for that org
{
  const before = await gql(
    `query ($org: uuid!) { workflow_runs(where: { trigger_type: { _eq: database_event }, org_id: { _eq: $org } }, order_by: { created_at: desc }, limit: 1) { id } }`,
    { org: ORG_A },
    ADMIN_HDRS,
  );
  const beforeId = before.body.data.workflow_runs[0]?.id ?? null;
  const lead = await gql(
    `mutation ($org: uuid!) { insert_leads_one(object: { org_id: $org, email: "verify@acme.test", name: "Verify" }) { id } }`,
    { org: ORG_A },
    ADMIN_HDRS,
  );
  const okInsert = !!lead.body.data?.insert_leads_one?.id;

  // the event handler runs async; poll briefly
  let afterId = beforeId;
  for (let i = 0; i < 20 && afterId === beforeId; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const after = await gql(
      `query ($org: uuid!) { workflow_runs(where: { trigger_type: { _eq: database_event }, org_id: { _eq: $org } }, order_by: { created_at: desc }, limit: 1) { id } }`,
      { org: ORG_A },
      ADMIN_HDRS,
    );
    afterId = after.body.data.workflow_runs[0]?.id ?? null;
  }
  check('lead insert -> database_event run created', okInsert && afterId !== beforeId && afterId !== null,
    `before=${beforeId?.slice(0, 8)} after=${afterId?.slice(0, 8) ?? 'none'}`);
}

// --- notify delivery ----------------------------------------------------

// 13. notify step -> notifications row -> deliver-notification marks sent
{
  // build a throwaway workflow: llm_call -> notify (no gate, so it runs to completion)
  const wf13 = await gql(
    `mutation ($org: uuid!, $name: String!) { insert_workflows_one(object: { org_id: $org, name: $name }) { id } }`,
    { org: ORG_A, name: `verify-notify-${Date.now()}` },
    ADMIN_HDRS,
  );
  const wf13id = wf13.body.data?.insert_workflows_one?.id;
  if (wf13id) {
    await gql(
      `mutation ($wf: uuid!, $org: uuid!) {
         insert_workflow_steps(objects: [
           { workflow_id: $wf, org_id: $org, name: "announce", type: llm_call, position: 1, config: { prompt_template: "hi" } }
           { workflow_id: $wf, org_id: $org, name: "notify", type: notify, position: 2, config: { channel: "email", target: "ops@acme.test", subject_template: "Verify", body_template: "Run finished" } }
         ]) { affected_rows }
       }`,
      { wf: wf13id, org: ORG_A },
      ADMIN_HDRS,
    );
    const r13 = await gql(
      `mutation ($wf: uuid!) { triggerWorkflowRun(workflow_id: $wf) { run_id status } }`,
      { wf: wf13id },
      asUser(ALICE),
    );
    const run13 = r13.body.data?.triggerWorkflowRun?.run_id;
    if (run13) {
      let sent = false;
      for (let i = 0; i < 20 && !sent; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const n = await gql(
          `query ($run: uuid!) { notifications(where: { workflow_run_id: { _eq: $run } }) { status } }`,
          { run: run13 },
          ADMIN_HDRS,
        );
        sent = n.body.data.notifications.some((x) => x.status === 'sent');
      }
      check('notify step -> notification delivered (sent)', sent);
    } else {
      check('notify step -> notification delivered (sent)', false, errors(r13.body));
    }
    // cleanup
    await gql(
      `mutation ($id: uuid!) { delete_workflows(where: { id: { _eq: $id } }) { affected_rows } }`,
      { id: wf13id },
      ADMIN_HDRS,
    );
  } else {
    check('notify step -> notification delivered (sent)', false, errors(wf13.body));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
