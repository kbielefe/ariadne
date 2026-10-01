-- Read-only export of v1 (Ariadne master) as one JSON document, for scripts/import-v1.ts.
--   podman exec -i ariadne_postgres_1 psql -U ariadne -d ariadne -At -f - < scripts/export-v1.sql > var/v1.json
-- Excludes the outcome(s) named in :skip (default: Improve Ariadne) and everything under them.
WITH skip AS (SELECT id FROM outcomes WHERE title = 'Improve Ariadne'),
keep_tasks AS (SELECT * FROM tasks WHERE outcome_id NOT IN (SELECT id FROM skip))
SELECT json_build_object(
  'participants', (SELECT coalesce(json_agg(p), '[]') FROM participants p),
  'areas', (SELECT coalesce(json_agg(a), '[]') FROM areas a),
  'relationships', (SELECT coalesce(json_agg(r), '[]') FROM relationships r),
  'outcomes', (SELECT coalesce(json_agg(o ORDER BY o.created_at), '[]') FROM outcomes o WHERE o.id NOT IN (SELECT id FROM skip)),
  'tasks', (SELECT coalesce(json_agg(t ORDER BY t.created_at), '[]') FROM keep_tasks t),
  'stakeholders', (SELECT coalesce(json_agg(s), '[]') FROM task_stakeholders s WHERE s.task_id IN (SELECT id FROM keep_tasks)),
  'references', (SELECT coalesce(json_agg(e), '[]') FROM external_references e WHERE e.subject_kind = 'task' AND e.subject_id IN (SELECT id FROM keep_tasks) AND e.system <> 'ariadne')
);
