import type { Request, Response } from 'express';
import { requireWebhookSecret } from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { executeWorkflowRun } from '../_lib/runner';

type EventPayload = {
  event: {
    session_variables: Record<string, string> | null;
    op: string;
    data: { new: Record<string, any> | null; old: Record<string, any> | null };
  };
  table: { schema: string; name: string };
  delivery_info: { current_retry: number; max_retries: number };
};

/**
 * Event-trigger handler that actually drives a workflow run.
 *
 * Execution lives here rather than in the triggering Action for two reasons:
 * the Action would otherwise hold an HTTP request open for the entire run (a
 * multi-step LLM chain exceeds the gateway timeout), and — because the client
 * awaits that Action before it knows the run id — the step_runs subscription
 * could not open until the run was already over, so "live" progress never
 * streamed.
 *
 * Fires on INSERT and on status UPDATE. A run is only picked up when it is
 * 'pending', which is also how an approved gate resumes: approve-step flips the
 * run back to 'pending' and this handler re-enters executeWorkflowRun, which
 * skips already-final step_runs and continues from the gate.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as EventPayload;
    const run = body.event?.data?.new;
    if (!run?.id) {
      return res.status(200).json({ ok: true, skipped: 'no row' });
    }
    if (run.status !== 'pending') {
      return res.status(200).json({ ok: true, skipped: `status ${run.status}` });
    }

    // Atomic lease: flip pending -> running and only proceed if THIS request won
    // the row. Flipping the status re-fires this trigger, and a retried delivery
    // can arrive while a run is already executing; without the claim both would
    // drive the same run concurrently and double-execute its steps.
    const claim = await adminGql<{ update_workflow_runs: { affected_rows: number } }>(
      `mutation ($runId: uuid!) {
         update_workflow_runs(
           where: { id: { _eq: $runId }, status: { _eq: "pending" } }
           _set: { status: "running", started_at: "now()" }
         ) { affected_rows }
       }`,
      { runId: run.id },
    );
    if (claim.update_workflow_runs.affected_rows !== 1) {
      return res.status(200).json({ ok: true, skipped: 'already claimed' });
    }

    const result = await executeWorkflowRun(run.id);
    return res.json({ ok: true, status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('run execution failed', message);

    // Mark the run failed and hand back its quota unit, otherwise a crash here
    // strands the row in 'running' forever and leaks the reservation.
    const runId = (req.body as EventPayload)?.event?.data?.new?.id;
    const orgId = (req.body as EventPayload)?.event?.data?.new?.org_id;
    if (runId) {
      try {
        const failed = await adminGql<{ update_workflow_runs: { affected_rows: number } }>(
          `mutation ($runId: uuid!, $error: String!) {
             update_workflow_runs(
               where: { id: { _eq: $runId }, status: { _in: ["pending", "running"] } }
               _set: { status: "failed", error: $error, finished_at: "now()" }
             ) { affected_rows }
           }`,
          { runId, error: message },
        );
        // Only refund the unit if THIS call transitioned the run to failed; a
        // run already failed by the runner has already had its quota released.
        if (orgId && failed.update_workflow_runs.affected_rows === 1) {
          const { releaseQuota } = await import('../_lib/runner');
          await releaseQuota(orgId);
        }
      } catch (cleanupErr) {
        console.error('run failure cleanup failed', cleanupErr);
      }
    }

    // 2xx so Hasura does not retry a run we have already marked failed.
    return res.status(200).json({ ok: false, error: message });
  }
}
