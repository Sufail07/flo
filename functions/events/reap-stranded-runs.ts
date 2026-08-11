import type { Request, Response } from 'express';
import { requireWebhookSecret } from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { releaseQuota } from '../_lib/runner';

/** A run still 'running' after this long is assumed dead, not slow. */
const STALE_AFTER_MINUTES = 15;

type StrandedRun = { id: string; org_id: string };

/**
 * Cron-trigger handler that closes out runs whose executor died mid-flight.
 *
 * If the execute-run invocation is killed (timeout, container recycle) the run
 * row stays 'running' forever and the quota unit reserved at trigger time is
 * never returned, so an org slowly loses capacity to crashes. This fails those
 * runs and hands the units back.
 *
 * Deliberately does not touch 'paused' runs — those are waiting on a human and
 * may legitimately sit for days.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000).toISOString();

    const stale = await adminGql<{ workflow_runs: StrandedRun[] }>(
      `query ($cutoff: timestamptz!) {
         workflow_runs(
           where: {
             status: { _in: ["pending", "running"] }
             created_at: { _lt: $cutoff }
           }
         ) { id org_id }
       }`,
      { cutoff },
    );

    const runs = stale.workflow_runs;
    if (runs.length === 0) {
      return res.json({ ok: true, reaped: 0 });
    }

    let reaped = 0;
    for (const run of runs) {
      // Status re-checked in the WHERE so a run that finished between the query
      // and now is left alone, and its quota is not released twice.
      const updated = await adminGql<{ update_workflow_runs: { affected_rows: number } }>(
        `mutation ($runId: uuid!) {
           update_workflow_runs(
             where: { id: { _eq: $runId }, status: { _in: ["pending", "running"] } }
             _set: {
               status: "failed"
               error: "run abandoned — executor did not finish"
               finished_at: "now()"
             }
           ) { affected_rows }
         }`,
        { runId: run.id },
      );
      if (updated.update_workflow_runs.affected_rows !== 1) continue;

      // Any step left mid-flight is failed too, so the UI does not show a
      // perpetual spinner on a step nothing is working on.
      await adminGql(
        `mutation ($runId: uuid!) {
           update_step_runs(
             where: {
               workflow_run_id: { _eq: $runId }
               status: { _in: ["pending", "running"] }
             }
             _set: {
               status: "failed"
               error: "run abandoned — executor did not finish"
               finished_at: "now()"
             }
           ) { affected_rows }
         }`,
        { runId: run.id },
      );

      await releaseQuota(run.org_id);
      reaped++;
    }

    console.log(`[reaper] failed ${reaped} stranded run(s)`);
    return res.json({ ok: true, reaped });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('reaper failed', message);
    return res.status(500).json({ ok: false, error: message });
  }
}
