-- 002_platform_complete.sql
-- Complete MAARY BASE platform schema: Auth helpers, RLS roles, Control Plane,
-- Project Auth, Storage, Realtime change capture, Functions, Jobs, Schedules, Backups.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maary_rls_user') THEN
    CREATE ROLE maary_rls_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maary_anon') THEN
    CREATE ROLE maary_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maary_authenticated') THEN
    CREATE ROLE maary_authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maary_service_role') THEN
    CREATE ROLE maary_service_role NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('request.jwt.claim.sub', true), '') IS NULL THEN NULL
    WHEN current_setting('request.jwt.claim.sub', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN current_setting('request.jwt.claim.sub', true)::uuid
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.email', true), '');
$$;

CREATE OR REPLACE FUNCTION auth.project_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.project_id', true), '');
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

GRANT USAGE ON SCHEMA auth TO maary_rls_user, maary_anon, maary_authenticated, maary_service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO maary_rls_user, maary_anon, maary_authenticated, maary_service_role;

-- Platform Operators / Administrators
CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL DEFAULT '',
  is_superadmin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip_address text,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sessions_user_idx ON platform_sessions(user_id);

-- Extend platform_projects from 001_initial.sql
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS schema_name text UNIQUE;
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS db_role_name text;
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES platform_users(id) ON DELETE SET NULL;
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS quotas jsonb NOT NULL DEFAULT '{"maxTables": 100, "maxRowsPerQuery": 1000, "maxStorageBytes": 104857600, "maxFunctions": 50, "maxRealtimeConnections": 100}'::jsonb;
ALTER TABLE platform_projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Extend platform_environments from 001_initial.sql
ALTER TABLE platform_environments ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT 'development';
ALTER TABLE platform_environments ADD COLUMN IF NOT EXISTS is_production boolean NOT NULL DEFAULT false;
ALTER TABLE platform_environments ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE platform_environments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Project RBAC Membership
CREATE TABLE IF NOT EXISTS platform_project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);
CREATE INDEX IF NOT EXISTS platform_project_members_user_idx ON platform_project_members(user_id);

-- Project & Environment API Keys
CREATE TABLE IF NOT EXISTS platform_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES platform_environments(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('anon', 'authenticated', 'service_role', 'custom')),
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  encrypted_key jsonb,
  scopes jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  rate_limit_per_min integer NOT NULL DEFAULT 600,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_api_keys_project_idx ON platform_api_keys(project_id);

-- Encrypted Secrets Store
CREATE TABLE IF NOT EXISTS platform_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  environment_id uuid REFERENCES platform_environments(id) ON DELETE CASCADE,
  name text NOT NULL,
  encrypted_value text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (project_id, environment_id, name)
);
CREATE INDEX IF NOT EXISTS platform_secrets_project_idx ON platform_secrets(project_id);

-- Project Database Migrations
CREATE TABLE IF NOT EXISTS platform_project_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  version text NOT NULL,
  name text NOT NULL,
  up_sql text NOT NULL,
  down_sql text NOT NULL DEFAULT '',
  checksum text NOT NULL,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rolled_back', 'failed')),
  applied_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS platform_project_migrations_project_idx ON platform_project_migrations(project_id, applied_at DESC);

-- Project Row-Level Security Policies Registry
CREATE TABLE IF NOT EXISTS platform_rls_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  policy_name text NOT NULL,
  command text NOT NULL DEFAULT 'ALL' CHECK (command IN ('ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  roles jsonb NOT NULL DEFAULT '["PUBLIC"]'::jsonb,
  using_expression text,
  check_expression text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, table_name, policy_name)
);

-- Project Authentication Configuration & End-Users
CREATE TABLE IF NOT EXISTS platform_auth_configs (
  project_id uuid PRIMARY KEY REFERENCES platform_projects(id) ON DELETE CASCADE,
  allow_public_signup boolean NOT NULL DEFAULT true,
  require_email_verification boolean NOT NULL DEFAULT false,
  password_min_length integer NOT NULL DEFAULT 8,
  access_token_ttl_seconds integer NOT NULL DEFAULT 3600,
  refresh_token_ttl_seconds integer NOT NULL DEFAULT 604800,
  jwt_secret_encrypted jsonb,
  oauth_providers jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  phone text,
  password_hash text,
  email_verified boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  role text NOT NULL DEFAULT 'authenticated',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'suspended', 'deleted')),
  user_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  app_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, email)
);
CREATE INDEX IF NOT EXISTS project_auth_users_project_idx ON project_auth_users(project_id);

CREATE TABLE IF NOT EXISTS project_auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_id text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, provider, provider_id)
);
CREATE INDEX IF NOT EXISTS project_auth_identities_user_idx ON project_auth_identities(user_id);

CREATE TABLE IF NOT EXISTS project_auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  token_family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_token_hash text,
  is_revoked boolean NOT NULL DEFAULT false,
  user_agent text,
  ip_address text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz
);
CREATE INDEX IF NOT EXISTS project_auth_sessions_user_idx ON project_auth_sessions(project_id, user_id);
CREATE INDEX IF NOT EXISTS project_auth_sessions_family_idx ON project_auth_sessions(token_family_id);

CREATE TABLE IF NOT EXISTS project_auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES project_auth_users(id) ON DELETE CASCADE,
  token_type text NOT NULL CHECK (token_type IN ('email_verification', 'password_recovery', 'magic_link', 'oauth_state')),
  token_hash text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Object Storage Service
CREATE TABLE IF NOT EXISTS platform_storage_buckets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit_bytes bigint NOT NULL DEFAULT 52428800,
  quota_bytes bigint NOT NULL DEFAULT 104857600,
  allowed_mime_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS platform_storage_buckets_project_idx ON platform_storage_buckets(project_id);

CREATE TABLE IF NOT EXISTS platform_storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES platform_storage_buckets(id) ON DELETE CASCADE,
  path text NOT NULL,
  size_bytes bigint NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  checksum_sha256 text NOT NULL,
  etag text NOT NULL,
  storage_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bucket_id, path)
);
CREATE INDEX IF NOT EXISTS platform_storage_objects_bucket_idx ON platform_storage_objects(bucket_id, path);

CREATE TABLE IF NOT EXISTS platform_storage_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES platform_storage_buckets(id) ON DELETE CASCADE,
  path text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  total_parts integer,
  uploaded_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'aborted', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_storage_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  bucket_id uuid NOT NULL REFERENCES platform_storage_buckets(id) ON DELETE CASCADE,
  name text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  roles jsonb NOT NULL DEFAULT '["authenticated"]'::jsonb,
  path_prefix text NOT NULL DEFAULT '',
  allow_owner_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bucket_id, name)
);

-- Realtime Channels & Change Event Log
CREATE TABLE IF NOT EXISTS platform_realtime_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  topic text NOT NULL,
  is_private boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, topic)
);

CREATE TABLE IF NOT EXISTS platform_realtime_events (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  channel_topic text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('postgres_changes', 'broadcast', 'presence')),
  schema_name text,
  table_name text,
  operation text,
  record jsonb,
  old_record jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_realtime_events_project_id_idx ON platform_realtime_events(project_id, id DESC);

-- Automatic Database Row-Change Trigger Function (SECURITY DEFINER so RLS-constrained roles can emit change logs safely)
CREATE OR REPLACE FUNCTION public.maary_capture_row_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_new jsonb := NULL;
  v_old jsonb := NULL;
BEGIN
  IF TG_NARGS > 0 AND TG_ARGV[0] IS NOT NULL AND TG_ARGV[0] <> '' THEN
    v_project_id := TG_ARGV[0]::uuid;
  ELSE
    SELECT id INTO v_project_id FROM public.platform_projects WHERE schema_name = TG_TABLE_SCHEMA LIMIT 1;
  END IF;

  IF v_project_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
  END IF;

  INSERT INTO public.platform_realtime_events (
    project_id, channel_topic, event_type, schema_name, table_name, operation, record, old_record, payload
  ) VALUES (
    v_project_id,
    'db:' || TG_TABLE_NAME,
    'postgres_changes',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    TG_OP,
    v_new,
    v_old,
    jsonb_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'eventType', TG_OP,
      'new', v_new,
      'old', v_old,
      'commit_timestamp', now()
    )
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Server Functions & Execution Logs
CREATE TABLE IF NOT EXISTS platform_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  code text NOT NULL,
  entrypoint text NOT NULL DEFAULT 'handler',
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  verify_jwt boolean NOT NULL DEFAULT true,
  timeout_ms integer NOT NULL DEFAULT 5000,
  env_vars jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, slug)
);
CREATE INDEX IF NOT EXISTS platform_functions_project_idx ON platform_functions(project_id);

CREATE TABLE IF NOT EXISTS platform_function_logs (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  function_id uuid NOT NULL REFERENCES platform_functions(id) ON DELETE CASCADE,
  invocation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status_code integer NOT NULL,
  duration_ms integer NOT NULL,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text,
  request_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_function_logs_fn_idx ON platform_function_logs(function_id, created_at DESC);

-- Background Queues, Jobs & Scheduled Tasks
CREATE TABLE IF NOT EXISTS platform_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  queue_name text NOT NULL DEFAULT 'default',
  job_type text NOT NULL CHECK (job_type IN ('function', 'sql_maintenance', 'webhook', 'storage_cleanup')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'dead_letter')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  timeout_ms integer NOT NULL DEFAULT 10000,
  last_error text,
  result jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (project_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS platform_jobs_poll_idx ON platform_jobs(status, run_at ASC, priority DESC);
CREATE INDEX IF NOT EXISTS platform_jobs_project_idx ON platform_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  cron_expression text NOT NULL DEFAULT '*/5 * * * *',
  interval_seconds integer NOT NULL DEFAULT 300,
  job_type text NOT NULL DEFAULT 'function' CHECK (job_type IN ('function', 'sql_maintenance', 'webhook', 'storage_cleanup')),
  target_slug text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

-- Backups & Metrics
CREATE TABLE IF NOT EXISTS platform_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES platform_projects(id) ON DELETE SET NULL,
  backup_type text NOT NULL CHECK (backup_type IN ('project', 'platform_full')),
  name text NOT NULL,
  file_path text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'restored')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz
);

CREATE TABLE IF NOT EXISTS platform_metrics_counters (
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  metric_name text NOT NULL,
  metric_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, metric_name)
);
