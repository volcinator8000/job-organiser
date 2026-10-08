"""Email a digest of follow-ups that are due.

Runs daily in GitHub Actions (see .github/workflows/remind.yml). Configuration
comes from the environment:

    JOBVAULT_PASSWORD   vault password (required)
    SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD REMIND_TO

Workflow logs of a public repo are public, so this script only ever prints
counts, never company names or other vault contents.
"""

from __future__ import annotations

import argparse
import os
import smtplib
import sys
from email.message import EmailMessage

from store import Vault, VaultError


def send_reminders(due) -> None:
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--vault", default="data/jobs.vault")
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
        due = vault.conn.execute("SELECT * FROM v_due_followups").fetchall()

    if not due:
        print("nothing due")
    elif not (os.environ.get("SMTP_HOST") and os.environ.get("SMTP_USER")):
        print(f"SMTP not configured, skipping ({len(due)} due)")
    else:
        send_reminders(due)
        print(f"emailed {len(due)} due follow-up(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
