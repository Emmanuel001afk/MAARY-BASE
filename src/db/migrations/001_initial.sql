CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS platform_projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_environments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
 name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,name)
);
CREATE TABLE IF NOT EXISTS platform_audit_events (
 id bigserial PRIMARY KEY, project_id uuid REFERENCES platform_projects(id) ON DELETE SET NULL,
 actor_type text NOT NULL CHECK (actor_type IN ('system','user','service')), actor_id text,
 action text NOT NULL, resource_type text NOT NULL, resource_id text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_events_project_created_idx ON platform_audit_events(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS platform_environments_project_idx ON platform_environments(project_id);
