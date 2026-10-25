-- 005: Studio Enhancements — persistent Saved SQL Queries per project
-- Powers the Management Studio SQL Editor "Saved Queries" panel (Supabase-style
-- query library): named, reusable SQL snippets scoped to a single project and
-- visible to every operator with control-plane access to that project.

CREATE TABLE IF NOT EXISTS platform_saved_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sql text NOT NULL,
  favorite boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  run_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS platform_saved_queries_project_idx
  ON platform_saved_queries(project_id, favorite DESC, updated_at DESC);
