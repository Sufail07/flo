import { LLM_API_KEY, LLM_BASE_URL, LLM_DEFAULT_MODEL, LLM_STUBBED } from './env';
import { adminGql } from './graphql';
import { RetryableError, throwForStatus, withRetry } from './retry';
import { renderString, renderValue, resolvePath, type RunContext } from './templating';

export type StepRun = {
  id: string;
  workflow_run_id: string;
  org_id: string;
  step_id: string | null;
  position: number;
  name: string;
  type: string;
  config: Record<string, any>;
  max_attempts: number;
};

export type StepOutcome = {
  output: Record<string, unknown>;
  /** Explicit next step for conditional_branch; undefined means fall through. */
  nextStepId?: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- llm_call

async function runLlmCall(step: StepRun, ctx: RunContext): Promise<StepOutcome> {
  const cfg = renderValue(step.config, ctx);
  const model = cfg.model ?? LLM_DEFAULT_MODEL;
  const prompt = cfg.prompt_template ?? cfg.prompt ?? '';
  const system = cfg.system ?? 'You are a helpful assistant.';

  if (LLM_STUBBED) {
    // Disclosed artificial delay, as permitted when no API key is available.
    await sleep(800);
    const text = `[STUBBED LLM RESPONSE — no LLM_API_KEY configured] prompt was: ${String(
      prompt,
    ).slice(0, 200)}`;
    return { output: { text, model: 'stub', stubbed: true } };
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    max_tokens: cfg.max_tokens ?? 512,
    temperature: cfg.temperature ?? 0.2,
  };

  const result = await withRetry(
    async () => {
      const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      throwForStatus(res.status, text);
      return JSON.parse(text);
    },
    { attempts: step.max_attempts },
  );

  return {
    output: {
      text: result?.choices?.[0]?.message?.content ?? '',
      model: result?.model ?? model,
      usage: result?.usage ?? null,
      stubbed: false,
    },
  };
}

// ------------------------------------------------------------ http_request

async function runHttpRequest(step: StepRun, ctx: RunContext): Promise<StepOutcome> {
  const cfg = renderValue(step.config, ctx);
  const url = cfg.url;
  if (!url || typeof url !== 'string') {
    throw new Error('http_request step requires a url in config');
  }

  const method = (cfg.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(cfg.headers ?? {}),
  };

  let payload: string | undefined;
  if (cfg.body_template !== undefined && method !== 'GET' && method !== 'HEAD') {
    payload =
      typeof cfg.body_template === 'string'
        ? cfg.body_template
        : JSON.stringify(cfg.body_template);
    headers['content-type'] ??= 'application/json';
  }

  const result = await withRetry(
    async () => {
      const res = await fetch(url, { method, headers, body: payload });
      const text = await res.text();
      throwForStatus(res.status, text);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      return { status: res.status, body: parsed };
    },
    { attempts: step.max_attempts },
  );

  return { output: result as Record<string, unknown> };
}

// ---------------------------------------------------------------- db_write

async function runDbWrite(step: StepRun, ctx: RunContext): Promise<StepOutcome> {
  const cfg = renderValue(step.config, ctx);
  const key = cfg.key ?? step.name;
  const value =
    cfg.value_template !== undefined ? cfg.value_template : ctx.previous?.output ?? null;

  const data = await adminGql<{
    insert_workflow_artifacts_one: { id: string };
  }>(
    `mutation ($obj: workflow_artifacts_insert_input!) {
       insert_workflow_artifacts_one(object: $obj) { id }
     }`,
    {
      obj: {
        workflow_run_id: step.workflow_run_id,
        step_run_id: step.id,
        key: String(key),
        value: typeof value === 'string' ? { text: value } : value,
      },
    },
  );

  return {
    output: { artifact_id: data.insert_workflow_artifacts_one.id, key: String(key) },
  };
}

// ------------------------------------------------------------------ notify

async function runNotify(step: StepRun, ctx: RunContext): Promise<StepOutcome> {
  const cfg = renderValue(step.config, ctx);

  // The row insert is the step's work; an Event Trigger performs delivery.
  const data = await adminGql<{ insert_notifications_one: { id: string } }>(
    `mutation ($obj: notifications_insert_input!) {
       insert_notifications_one(object: $obj) { id }
     }`,
    {
      obj: {
        workflow_run_id: step.workflow_run_id,
        step_run_id: step.id,
        org_id: step.org_id,
        channel: cfg.channel ?? 'email',
        target: cfg.target ?? '',
        subject: cfg.subject_template ?? null,
        body: String(cfg.body_template ?? ''),
      },
    },
  );

  return { output: { notification_id: data.insert_notifications_one.id, queued: true } };
}

// ------------------------------------------------------- conditional_branch

function compare(left: unknown, operator: string, right: unknown): boolean {
  const ls = typeof left === 'string' ? left : JSON.stringify(left ?? null);
  const rs = typeof right === 'string' ? right : JSON.stringify(right ?? null);

  switch (operator) {
    case 'equals':
      return ls === rs;
    case 'not_equals':
      return ls !== rs;
    case 'contains':
      return ls.toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'not_contains':
      return !ls.toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'gt':
      return Number(left) > Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'is_truthy':
      return Boolean(left);
    default:
      throw new Error(`unsupported operator: ${operator}`);
  }
}

async function runConditionalBranch(
  step: StepRun,
  ctx: RunContext,
  branchTargets: { on_true_step_id: string | null; on_false_step_id: string | null },
): Promise<StepOutcome> {
  const cfg = step.config ?? {};
  const source = cfg.source ?? 'previous.output.text';
  const left = resolvePath(ctx, String(source));
  const right =
    typeof cfg.value === 'string' ? renderString(cfg.value, ctx) : cfg.value;

  const matched = compare(left, String(cfg.operator ?? 'is_truthy'), right);

  return {
    output: { matched, evaluated: left ?? null, operator: cfg.operator ?? 'is_truthy' },
    nextStepId: matched ? branchTargets.on_true_step_id : branchTargets.on_false_step_id,
  };
}

// ---------------------------------------------------------------- dispatch

export async function executeStep(
  step: StepRun,
  ctx: RunContext,
  branchTargets: { on_true_step_id: string | null; on_false_step_id: string | null },
): Promise<StepOutcome> {
  switch (step.type) {
    case 'llm_call':
      return runLlmCall(step, ctx);
    case 'http_request':
      return runHttpRequest(step, ctx);
    case 'db_write':
      return runDbWrite(step, ctx);
    case 'notify':
      return runNotify(step, ctx);
    case 'conditional_branch':
      return runConditionalBranch(step, ctx, branchTargets);
    default:
      throw new Error(`unsupported step type: ${step.type}`);
  }
}

export { RetryableError };
