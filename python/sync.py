"""Mirror the encrypted vault to Google Sheets and email follow-up reminders.

Runs in GitHub Actions (see .github/workflows/sync.yml). Configuration comes
from the environment:

    JOBVAULT_PASSWORD             vault password (required)
    GOOGLE_SERVICE_ACCOUNT_JSON   service-account key JSON   (for --sheets)
    SHEET_ID                      spreadsheet id from its URL (for --sheets)
    SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD REMIND_TO   (for --remind)

Workflow logs of a public repo are public, so this script only ever prints
counts, never company names or other vault contents.
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
from email.message import EmailMessage

from store import Vault, VaultError

APP_COLUMNS = [
    ("id", "ID"), ("company", "Company"), ("position", "Position"), ("status", "Status"),
    ("applied_on", "Applied"), ("last_contact_on", "Last contact"),
    ("next_follow_up", "Next follow-up"), ("follow_up_days", "Follow-up every (days)"),
    ("location", "Location"), ("url", "Link"), ("contact_name", "Contact"),
    ("contact_email", "Contact email"), ("notes", "Notes"), ("updated_at", "Updated (UTC)"),
]


def fetch(conn):
    apps = conn.execute(
        "SELECT * FROM v_applications ORDER BY COALESCE(applied_on, created_at) DESC").fetchall()
    due = conn.execute("SELECT * FROM v_due_followups").fetchall()
    events = conn.execute(
        """SELECT e.at, a.company, a.position, e.kind, e.detail
           FROM events e JOIN applications a ON a.id = e.application_id
           ORDER BY e.at DESC LIMIT 1000""").fetchall()
    stats = conn.execute(
        "SELECT status, COUNT(*) AS n FROM applications GROUP BY status ORDER BY n DESC").fetchall()
    return apps, due, events, stats


def cell(v):
    return "" if v is None else v


def sync_sheets(apps, due, events, stats) -> None:
    import gspread

    creds = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    sh = gspread.service_account_from_dict(creds).open_by_key(os.environ["SHEET_ID"])

    tabs = {
        "Applications": [[h for _, h in APP_COLUMNS]]
                        + [[cell(r[k]) for k, _ in APP_COLUMNS] for r in apps],
        "Follow-ups": [["Company", "Position", "Status", "Due", "Days overdue", "Contact email"]]
                      + [[r["company"], r["position"], r["status"], r["next_follow_up"],
                          r["days_overdue"], cell(r["contact_email"])] for r in due],
        "Activity": [["When (UTC)", "Company", "Position", "Event", "Detail"]]
                    + [[cell(v) for v in r] for r in events],
        "Stats": [["Status", "Count"]] + [[r["status"], r["n"]] for r in stats],
    }

    existing = {ws.title: ws for ws in sh.worksheets()}
    for title, values in tabs.items():
        ws = existing.get(title)
        if ws is None:
            ws = sh.add_worksheet(title=title, rows=max(len(values), 10), cols=len(values[0]))
        ws.clear()
        ws.update(values=values, range_name="A1", value_input_option="RAW")
        ws.freeze(rows=1)
        ws.format("1:1", {"textFormat": {"bold": True}})
    print(f"sheets: wrote {len(apps)} applications, {len(due)} due follow-ups, "
          f"{len(events)} events")


def send_reminders(due) -> None:
    if not due:
        print("remind: nothing due")
        return
    lines = [f"You have {len(due)} application(s) waiting for a follow-up:\n"]
    for r in due:
        late = f"{r['days_overdue']} day(s) overdue" if r["days_overdue"] else "due today"
        who = f" - contact: {r['contact_email']}" if r["contact_email"] else ""
        lines.append(f"* {r['company']} - {r['position']} ({r['status']}, {late}){who}")
    lines.append("\nOpen your Job Organiser to draft the messages and mark them as sent.")

    msg = EmailMessage()
    msg["Subject"] = f"[Job Organiser] {len(due)} follow-up(s) due"
    msg["From"] = os.environ["SMTP_USER"]
    msg["To"] = os.environ.get("REMIND_TO") or os.environ["SMTP_USER"]
    msg.set_content("\n".join(lines))

    port = int(os.environ.get("SMTP_PORT") or 465)
    host = os.environ["SMTP_HOST"]
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=30)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
        server.starttls()
    with server:
        server.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        server.send_message(msg)
    print(f"remind: emailed {len(due)} due follow-up(s)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--vault", default="data/jobs.vault")
    ap.add_argument("--sheets", action="store_true", help="mirror to Google Sheets")
    ap.add_argument("--remind", action="store_true", help="email due follow-ups")
    args = ap.parse_args()

    password = os.environ.get("JOBVAULT_PASSWORD")
    if not password:
        print("JOBVAULT_PASSWORD is not set", file=sys.stderr)
        return 2
    if not os.path.exists(args.vault):
        print("no vault yet, nothing to do")
        return 0
    try:
        vault = Vault.open(args.vault, password)
    except VaultError as exc:
        print(f"cannot open vault: {exc}", file=sys.stderr)
        return 1

    with vault:
        apps, due, events, stats = fetch(vault.conn)

    if args.sheets:
        if os.environ.get("SHEET_ID") and os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON"):
            sync_sheets(apps, due, events, stats)
        else:
            print("sheets: SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON not set, skipping")
    if args.remind:
        if os.environ.get("SMTP_HOST") and os.environ.get("SMTP_USER"):
            send_reminders(due)
        else:
            print(f"remind: SMTP not configured, skipping ({len(due)} due)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
