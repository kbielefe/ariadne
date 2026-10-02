-- Events for you are claimed by Claude Code sessions now (the Timeline page is gone).
-- Open cards wait to be claimed; old FYIs were already seen in the Timeline.
UPDATE events SET delivery = 'pending'
WHERE kind = 'assign' AND state = 'open' AND delivery = 'none' AND recipient = '00000000-0000-4000-8000-000000000001';
