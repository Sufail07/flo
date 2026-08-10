-- Enum tables. Using tables (not native PG enums) so Hasura generates real
-- GraphQL enum types and enforces FK integrity, while new values stay a plain INSERT.

CREATE TABLE public.org_roles (
  value   text PRIMARY KEY,
  comment text NOT NULL DEFAULT ''
);
INSERT INTO public.org_roles (value, comment) VALUES
  ('owner',  'Full control over workflows, steps, triggers and membership'),
  ('editor', 'Create/edit workflows and steps, trigger runs; cannot manage members'),
  ('viewer', 'Read-only; cannot trigger runs');

CREATE TABLE public.step_types (
  value   text PRIMARY KEY,
  comment text NOT NULL DEFAULT ''
);
INSERT INTO public.step_types (value, comment) VALUES
  ('llm_call',           'Calls an external LLM API'),
  ('http_request',       'Generic call to any external API'),
  ('db_write',           'Persists a result into workflow_artifacts'),
  ('notify',             'Slack/email alert, delivered via Event Trigger'),
  ('conditional_branch', 'if/else based on a previous step output'),
  ('approval_gate',      'Pauses the run until an authorised user approves');

CREATE TABLE public.trigger_types (
  value   text PRIMARY KEY,
  comment text NOT NULL DEFAULT ''
);
INSERT INTO public.trigger_types (value, comment) VALUES
  ('manual',         'User clicks Run'),
  ('webhook',        'Inbound Hasura Action endpoint'),
  ('scheduled',      'Cron-based via scheduled function'),
  ('database_event', 'Row change in a watched table');

CREATE TABLE public.run_statuses (
  value   text PRIMARY KEY,
  comment text NOT NULL DEFAULT ''
);
INSERT INTO public.run_statuses (value, comment) VALUES
  ('pending',   'Created, not yet started'),
  ('running',   'Executing steps'),
  ('paused',    'Halted at an approval gate'),
  ('succeeded', 'All steps completed'),
  ('failed',    'A step exhausted its retries'),
  ('cancelled', 'Cancelled by a user');

CREATE TABLE public.step_run_statuses (
  value   text PRIMARY KEY,
  comment text NOT NULL DEFAULT ''
);
INSERT INTO public.step_run_statuses (value, comment) VALUES
  ('pending',           'Queued, awaiting executor'),
  ('running',           'Executor claimed this step'),
  ('awaiting_approval', 'Approval gate blocking the run'),
  ('succeeded',         'Completed successfully'),
  ('failed',            'Exhausted max_attempts'),
  ('skipped',           'Bypassed by a conditional branch');
