-- Private notes: text that must never leave this machine (opinions about people, HR matters,
-- unannounced plans, other teams' confidential details). Kept apart from the public body, which
-- may later be shared with the pod through steward. The one deliberate exception to the simple schema.
ALTER TABLE nodes ADD COLUMN private_notes text NOT NULL DEFAULT '';

-- Why a change was made, when the change must say so (every write to private notes does).
ALTER TABLE audit ADD COLUMN reason text;
