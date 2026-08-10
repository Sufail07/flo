import { adminGql } from './graphql';
import { executeStep, type StepRun } from './steps';
import { renderValue, type RunContext } from './templating';

export type RunStatus =
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed';

export type RunResult = {
  status: RunStatus;
  runId: string;
  pausedAtStepRunId?: string | null;
};

type WorkflowStepRow = {
  id: string;
  workflow_id: string;
  org_id: string;
  position: number;
  name: string;
  type: string;
  config: Record<string, any>;
  max_attempts: number;
  on_true_step_id: string | null;
  on_false_step_id: string | null;
};

type RunRow = {
  id: string;
  workflow_id: string;
  org_id: string;
  status: string;
  input: Record<string, unknown>;
};

type StepRunRow = {
  id: string;
  step_id: string | null;
  org_id: string;
  position: number;
  name: string;
  type: string;
  config: Record<string, any>;
  status: string;
  output: unknown;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- quota

/**
 * Atomically reserves one quota unit. Reads the org to learn the limit, then
 * performs a single conditional UPDATE — the WHERE is evaluated against the
 * current row inside one statement, so concurrent triggers cannot over-commit.
 */
export async function reserveQuota(orgId: string): Promise<boolean> {
  const org = await adminGql<{ organizations_by_pk: { quota_limit: number } | null }>(
    `query ($orgId: uuid!) {
       organizations_by_pk(id: $orgId) { quota_limit }
     }`,
    { orgId },
  );
  if (!org.organizations_by_pk) return false;

  const { quota_limit } = org.organizations_by_pk;
  const res = await adminGql<{ update_organizations: { affected_rows: number } }>(
    `mutation ($orgId: uuid!, $limit: Int!) {
       update_organizations(
         where: { id: { _eq: $orgId }, quota_used: { _lt: $limit } }
         _inc: { quota_used: 1 }
       ) { affected_rows }
     }`,
    { orgId, limit: quota_limit },
  );
  return res.update_organizations.affected_rows === 1;
}

/** Releases a reserved unit (failure path). Clamped so it can never go negative. */
export async function releaseQuota(orgId: string): Promise<void> {
  await adminGql(
    `mutation ($orgId: uuid!) {
       update_organizations(
         where: { id: { _eq: $orgId }, quota_used: { _gt: 0 } }
         _inc: { quota_used: -1 }
       ) { affected_rows }
     }`,
    { orgId },
  );
}

async function setRunStatus(runId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await adminGql(
    `mutation ($runId: uuid!, $set: workflow_runs_set_input!) {
       update_workflow_runs_by_pk(
         pk_columns: { id: $runId }
         _set: $set
       ) { id }
     }`,
    { runId, set: { status, ...extra } },
  );
}

// ------------------------------------------------------------- helpers

function insertStepRun(
  runId: string,
  step: WorkflowStepRow,
  status: string,
): Promise<{ insert_step_runs_one: { id: string } }> {
  return adminGql(
    `mutation ($obj: step_runs_insert_input!) {
       insert_step_runs_one(object: $obj) { id }
     }`,
    {
      obj: {
        workflow_run_id: runId,
        step_id: step.id,
        org_id: step.org_id,
        position: step.position,
        name: step.name,
        type: step.type,
        config: step.config,
        status,
        attempt: 1,
        max_attempts: step.max_attempts,
      },
    },
  );
}

function updateStepRun(id: string, patch: Record<string, unknown>): Promise<unknown> {
  return adminGql(
    `mutation ($id: uuid!, $patch: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: { id: $id }, _set: $patch) { id }
     }`,
    { id, patch },
  );
}

// ------------------------------------------------------------------ run

/**
 * Drives a workflow run: creates step_runs, executes them in order (following
 * conditional branches), pauses at approval gates, and updates run state so a
 * subscription reflects progress live.
 *
 * Safe to call with a fresh runId (manual/webhook/event starts) OR to resume a
 * paused run by passing resumeAfterPosition (the approved gate's position).
 */
export async function executeWorkflowRun(
  runId: string,
  opts: { resumeAfterPosition?: number } = {},
): Promise<RunResult> {
  const run = await adminGql<{ workflow_runs_by_pk: RunRow | null }>(
    `query ($runId: uuid!) {
       workflow_runs_by_pk(id: $runId) { id workflow_id org_id status input }
     }`,
    { runId },
  );
  const row = run.workflow_runs_by_pk;
  if (!row) return { status: 'failed', runId };
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
    return { status: row.status, runId };
  }

  const steps = await adminGql<{ workflow_steps: WorkflowStepRow[] }>(
    `query ($workflowId: uuid!) {
       workflow_steps(
         where: { workflow_id: { _eq: $workflowId } }
         order_by: { position: asc }
       ) {
         id workflow_id org_id position name type config max_attempts
         on_true_step_id on_false_step_id
       }
     }`,
    { workflowId: row.workflow_id },
  );

  const existing = await adminGql<{ step_runs: StepRunRow[] }>(
    `query ($runId: uuid!) {
       step_runs(where: { workflow_run_id: { _eq: $runId } }) {
         id step_id org_id position name type config status output
       }
     }`,
    { runId },
  );
  const existingByPosition = new Map<number, StepRunRow>(
    existing.step_runs.map((s) => [s.position, s]),
  );

  // Rebuild the templating context from already-succeeded step runs so a resume
  // can still reference earlier outputs without re-running them.
  const ctx: RunContext = { run: { id: runId, input: row.input }, steps: {}, previous: null };
  const succeeded = existing.step_runs
    .filter((s) => s.status === 'succeeded')
    .sort((a, b) => a.position - b.position);
  for (const s of succeeded) {
    ctx.steps[s.name] = { output: s.output, input: s.config };
    ctx.previous = ctx.steps[s.name];
  }

  // Start index: fresh run begins at 0; a resume continues after the gate.
  let index = 0;
  if (opts.resumeAfterPosition !== undefined) {
    index = steps.workflow_steps.findIndex((s) => s.position > opts.resumeAfterPosition!);
  }
  if (index < 0) index = steps.workflow_steps.length;

  for (; index < steps.workflow_steps.length; index++) {
    const stepDef = steps.workflow_steps[index];
    const existingRow = existingByPosition.get(stepDef.position);
    // Idempotency: an already-final step (e.g. from a retried event) is skipped.
    if (existingRow && existingRow.status !== 'awaiting_approval') {
      if (existingRow.status === 'succeeded') {
        ctx.steps[existingRow.name] = { output: existingRow.output, input: existingRow.config };
        ctx.previous = ctx.steps[existingRow.name];
      }
      continue;
    }

    if (stepDef.type === 'approval_gate') {
      let stepRunId = existingRow?.id;
      if (!stepRunId) {
        const created = await insertStepRun(runId, stepDef, 'awaiting_approval');
        stepRunId = created.insert_step_runs_one.id;
        existingByPosition.set(stepDef.position, {
          id: stepRunId,
          step_id: stepDef.id,
          org_id: stepDef.org_id,
          position: stepDef.position,
          name: stepDef.name,
          type: stepDef.type,
          config: stepDef.config,
          status: 'awaiting_approval',
          output: null,
        });
      }
      await setRunStatus(runId, 'paused');
      return { status: 'paused', runId, pausedAtStepRunId: stepRunId };
    }

    let stepRunId = existingRow?.id;
    if (!stepRunId) {
      const created = await insertStepRun(runId, stepDef, 'running');
      stepRunId = created.insert_step_runs_one.id;
      existingByPosition.set(stepDef.position, {
        id: stepRunId,
        step_id: stepDef.id,
        org_id: stepDef.org_id,
        position: stepDef.position,
        name: stepDef.name,
        type: stepDef.type,
        config: stepDef.config,
        status: 'running',
        output: null,
      });
    }

    const step: StepRun = {
      id: stepRunId,
      workflow_run_id: runId,
      org_id: stepDef.org_id,
      step_id: stepDef.id,
      position: stepDef.position,
      name: stepDef.name,
      type: stepDef.type,
      config: renderValue(stepDef.config, ctx),
      max_attempts: stepDef.max_attempts,
    };

    const branchTargets = {
      on_true_step_id: stepDef.on_true_step_id,
      on_false_step_id: stepDef.on_false_step_id,
    };

    try {
      const outcome = await executeStep(step, ctx, branchTargets);
      await updateStepRun(stepRunId, {
        status: 'succeeded',
        output: outcome.output,
        finished_at: new Date().toISOString(),
      });
      ctx.steps[step.name] = { output: outcome.output, input: step.config };
      ctx.previous = ctx.steps[step.name];

      if (outcome.nextStepId) {
        const target = steps.workflow_steps.findIndex((s) => s.id === outcome.nextStepId);
        if (target === -1) {
          throw new Error(`conditional branch pointed at unknown step ${outcome.nextStepId}`);
        }
        // -1: the for-loop re-increments index after this iteration, so jumping
        // to `target` would skip that step. Setting target - 1 lands on it.
        index = target - 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateStepRun(stepRunId, {
        status: 'failed',
        error: message,
        attempt: stepDef.max_attempts,
        finished_at: new Date().toISOString(),
      });
      await setRunStatus(runId, 'failed', { error: message, finished_at: new Date().toISOString() });
      await releaseQuota(row.org_id);
      return { status: 'failed', runId };
    }
  }

  await setRunStatus(runId, 'succeeded', { finished_at: new Date().toISOString() });
  return { status: 'succeeded', runId };
}

export type { RunContext };
