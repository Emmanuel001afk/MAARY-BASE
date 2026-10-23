CREATE TABLE platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_sessions_user_idx ON platform_sessions(user_id);

CREATE TABLE platform_project_members (
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','developer','readonly')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, user_id)
);
CREATE INDEX platform_project_members_user_idx ON platform_project_members(user_id, project_id);

CREATE TABLE platform_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  secret_hash bytea NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','developer','readonly')),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX platform_api_keys_project_idx ON platform_api_keys(project_id) WHERE revoked_at IS NULL;

ALTER TABLE platform_environments ADD COLUMN database_schema text;
CREATE UNIQUE INDEX platform_environments_database_schema_idx ON platform_environments(database_schema) WHERE database_schema IS NOT NULL;

ALTER TABLE platform_audit_events ADD COLUMN actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL;
CREATE INDEX platform_audit_events_actor_idx ON platform_audit_events(actor_user_id, created_at DESC);
