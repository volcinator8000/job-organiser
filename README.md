# job-organiser

A GitHub Pages site for tracking job applications. It reminds you when to send a follow-up and imports and exports spreadsheets. All data lives in one **encrypted SQLite database** (the "vault"). The browser, a C command-line tool and Python scripts can all read and write it.

```
 browser (GitHub Pages)                 repo                         GitHub Actions (Python)
 ┌──────────────────────┐   encrypted   ┌────────────────┐            ┌────────────────────────┐
 │ login = decrypt      │──── PUT ────▶│ data/jobs.vault │── daily ─▶│ decrypt → due          │
 │ SQLite (sql.js, C)   │◀─── GET ─────│ (ciphertext)    │           │ follow-ups → email     │
 │ CSV/XLSX/ODS import  │               └────────────────┘            └────────────────────────┘
 └──────────────────────┘
                                               ▲
                                  c/jobctl (C + SQLite + OpenSSL): SQL shell on the vault
```

## Features

- **Applications**: company, position, link, contact, status, dates, notes. You can change a status inline, and every change is written to a history log (SQL triggers).
- **Statuses**: wishlist, applied, followed up, interviewing, offer, accepted, rejected, ghosted, withdrawn.
- **Follow-up reminders**: each application gets a follow-up date (last contact + N days, default 7). Due items show up in the *Follow-ups* tab, as browser notifications and in a daily email. "Draft email" opens your mail app with a message from your template. "Mark as sent" resets the timer.
- **SQL console** in the browser, plus `jobctl shell` on the command line.
- **Login and encryption**: the password derives an AES-256-GCM key (PBKDF2-SHA256, 600k iterations). Data is only ever stored or uploaded encrypted. The page locks itself after a period of inactivity.
- **Spreadsheet import**: CSV, TSV, Excel (.xlsx, .xls), OpenDocument (.ods) and Numbers files. Columns are matched automatically from their headers (you can change them), and a preview shows the result before anything is saved.
  - Day-first and month-first dates are detected.
  - Free-text statuses like "Interview scheduled" or "Declined" are mapped to the tracker's statuses.
  - Rows already in the tracker are skipped.
  - Anything that can't be understood is kept in the notes, not lost.
  - Files are parsed in the browser and never uploaded.
- **Spreadsheet export**: .xlsx, .ods (applications plus activity history) or CSV.

## Layout

| Path | What |
|---|---|
| `schema.sql` | Tables, triggers and views shared by all three languages |
| `web/` | The static site: `app.js` (UI), `vault.js` (crypto), `importer.js` (spreadsheet import/export), `vendor/` (sql.js = SQLite compiled from C to WebAssembly; SheetJS) |
| `c/jobctl.c` | CLI: `init`, `list`, `due`, `add`, `status`, `sql`, `shell`, `passwd`, `decrypt`, `encrypt` |
| `python/store.py` | Vault library (`Vault.open(path, password)`) |
| `python/remind.py` | Daily reminder email (GitHub Action) |
| `tests/roundtrip.sh` | Checks that C and Python read and write each other's vaults |

## Setup

1. **Pages**: Settings → Pages → Source: **GitHub Actions**. Pushing to `main` deploys `web/` to `https://<you>.github.io/job-organiser/`.
2. **First login**: open the site and choose a strong password. It **cannot be recovered**.
3. **Sync from the browser to the repo**: create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for **this repository only** with **Contents: Read and write**. Paste it in the app under Settings → GitHub token. The token is stored inside the encrypted vault. Without it, data stays in that browser only.
4. **Reminder emails** (optional). Add these repo secrets: `JOBVAULT_PASSWORD` (the vault password). For reminder email, also add `SMTP_HOST`, `SMTP_PORT` (465 or 587), `SMTP_USER`, `SMTP_PASSWORD` and optionally `REMIND_TO`. For Gmail, use `smtp.gmail.com` and an [app password](https://myaccount.google.com/apppasswords). Optional repo *variable*: `TZ` (for example `Europe/Paris`) so "due today" matches your day.

## Command line

```sh
make                      # builds c/jobctl (needs libsqlite3 + libssl headers)
git pull                  # get the latest vault
./c/jobctl due  data/jobs.vault
./c/jobctl add  data/jobs.vault "Acme" "Backend Engineer" https://acme.example/job/1
./c/jobctl shell data/jobs.vault
jobs> SELECT company, status, next_follow_up FROM v_applications;
make test                 # C <-> Python round-trip test
make serve                # run the site on http://localhost:8000
```

If you edit the vault from the CLI, commit and push it so the browser picks it up.

## Security notes

- The repo, and so the vault file, can be public: without the password it is just random bytes. Its strength is your password's strength, so use a long passphrase.
- To send reminder emails, GitHub Actions has the password (as a secret). Anyone with admin access to the repo could use it. If you don't want that, skip the secrets: you still get reminders inside the app.
- Spreadsheet exports are **not** encrypted. Delete them when you're done.
- Workflow logs of public repos are public. `remind.py` only prints counts.
- Browser notifications only show a count, never company names.
- The "login" is the decryption itself; there is no server. Several devices can be used, but saving from two of them at the same time causes a conflict, which the app reports. You then choose which copy to keep.
