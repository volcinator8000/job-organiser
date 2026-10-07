-- Job Organiser schema. Shared by the web app (sql.js), jobctl (C) and the
-- Python sync. Every statement is idempotent: clients run it on every open.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS applications (
    id              INTEGER PRIMARY KEY,
    company         TEXT    NOT NULL,
    position        TEXT    NOT NULL,
    location        TEXT,
    url             TEXT,
    contact_name    TEXT,
    contact_email   TEXT,
    status          TEXT    NOT NULL DEFAULT 'applied'
                    CHECK (status IN ('wishlist', 'applied', 'followed_up', 'interviewing',
                                      'offer', 'accepted', 'rejected', 'ghosted', 'withdrawn')),
    applied_on      TEXT,                       -- YYYY-MM-DD
    last_contact_on TEXT,                       -- YYYY-MM-DD, last message sent/received
    follow_up_days  INTEGER NOT NULL DEFAULT 7 CHECK (follow_up_days >= 0),
    snooze_until    TEXT,                       -- YYYY-MM-DD, hides the reminder until then
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    at             TEXT    NOT NULL DEFAULT (datetime('now')),
    kind           TEXT    NOT NULL,            -- created | status | follow_up | note
    detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_app ON events(application_id, at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('schema_version', '1');

CREATE TRIGGER IF NOT EXISTS trg_app_created AFTER INSERT ON applications
BEGIN
    INSERT INTO events(application_id, kind, detail) VALUES (NEW.id, 'created', NEW.status);
END;

CREATE TRIGGER IF NOT EXISTS trg_app_status AFTER UPDATE OF status ON applications
WHEN OLD.status IS NOT NEW.status
BEGIN
    INSERT INTO events(application_id, kind, detail)
    VALUES (NEW.id, 'status', OLD.status || ' -> ' || NEW.status);
END;

CREATE TRIGGER IF NOT EXISTS trg_app_touch AFTER UPDATE ON applications
WHEN OLD.updated_at IS NEW.updated_at
BEGIN
    UPDATE applications SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- next_follow_up is only set for applications still waiting on an answer.
CREATE VIEW IF NOT EXISTS v_applications AS
SELECT a.*,
       CASE
         WHEN a.status IN ('applied', 'followed_up', 'interviewing') AND a.follow_up_days > 0 THEN
           CASE
             WHEN a.snooze_until IS NOT NULL
                  AND a.snooze_until > date(COALESCE(a.last_contact_on, a.applied_on, date(a.created_at)),
                                            '+' || a.follow_up_days || ' days')
               THEN a.snooze_until
             ELSE date(COALESCE(a.last_contact_on, a.applied_on, date(a.created_at)),
                       '+' || a.follow_up_days || ' days')
           END
       END AS next_follow_up
FROM applications a;

CREATE VIEW IF NOT EXISTS v_due_followups AS
SELECT *,
       CAST(julianday(date('now', 'localtime')) - julianday(next_follow_up) AS INTEGER) AS days_overdue
FROM v_applications
WHERE next_follow_up IS NOT NULL
  AND next_follow_up <= date('now', 'localtime')
ORDER BY next_follow_up;
