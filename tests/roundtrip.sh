#!/usr/bin/env bash
# Checks that the C and Python implementations read and write the same vault format.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export JOBVAULT_PASSWORD='correct horse battery staple'
v="$tmp/jobs.vault"

./c/jobctl init "$v"
./c/jobctl add "$v" "Acme" "Backend Engineer" "https://acme.example/jobs/1" >/dev/null
./c/jobctl sql "$v" "UPDATE applications SET applied_on = date('now','-10 days') WHERE id = 1;" >/dev/null

python3 - "$v" <<'PY'
import sys; sys.path.insert(0, "python")
from store import Vault, VaultError
with Vault.open(sys.argv[1], "correct horse battery staple") as v:
    due = v.conn.execute("SELECT company, days_overdue FROM v_due_followups").fetchall()
    assert [tuple(r) for r in due] == [("Acme", 3)], [tuple(r) for r in due]
    v.conn.execute("INSERT INTO applications(company, position, status) VALUES ('Globex','SRE','interviewing')")
    v.conn.execute("UPDATE applications SET status='followed_up', last_contact_on=date('now') WHERE id=1")
    assert v.save()
try:
    Vault.open(sys.argv[1], "wrong password")
    raise SystemExit("wrong password accepted")
except VaultError:
    pass
print("python: ok")
PY

out=$(./c/jobctl sql "$v" "SELECT company || ':' || status FROM applications ORDER BY id;")
[ "$(echo "$out" | tail -n +2 | tr '\n' ' ')" = "Acme:followed_up Globex:interviewing " ] || { echo "$out"; exit 1; }
events=$(./c/jobctl sql "$v" "SELECT count(*) FROM events WHERE kind='status';" | tail -1)
[ "$events" = 1 ] || { echo "expected 1 status event, got $events"; exit 1; }
if JOBVAULT_PASSWORD=nope ./c/jobctl list "$v" 2>/dev/null; then echo "C accepted wrong password"; exit 1; fi
grep -q Acme "$v" && { echo "plaintext leaked into vault file"; exit 1; }
echo "c: ok"
echo "roundtrip: all passed"
