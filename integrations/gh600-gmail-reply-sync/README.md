# GhoulHouse GH600 — Gmail → Master-CRM reply sync

**Status: deployable source / NOT activated.** Production campaign remains HOLD (0/30). This component **only reads Gmail** and records replies; it never sends marketing mail. It is unrelated to Putkikasvu PR #11 and does not use Resend or Instantly.

## Why Apps Script

This runs entirely under **hello@ghoulhouse.fi** with a Google time-driven trigger. No new paid service, OAuth refresh token export, service account, or parallel CRM is required. It edits the existing `MASTER_LEADS` sheet only after identity, company and reply-thread checks pass. The Apps Script project must be created and authorized in that account; the connected Gmail/Drive ChatGPT apps cannot install an Apps Script trigger.

## How it works

* `gh600Sync` lists up to 1,000 inbox messages from the previous 14 days. A hard limit error aborts the run instead of silently skipping overflow.
* It only considers **inbound replies** (`In-Reply-To` / `References` / `Re:` etc.) and ignores bulk/list/autoresponder/internal messages.
* It matches `From` to **exactly one** active email in `MASTER_LEADS!I`; DQ shadow leads are ignored. A second check confirms an earlier **SENT** message in the **same Gmail thread**, sent by `hello@ghoulhouse.fi` *to that same address*.
* It checks **`GH600_SUPPRESSION!A:A`** by lead ID and leaves all suppressed leads on HOLD. It also never overwrites `Hävitty`, `Voitettu`, or `DQ`.
* Exactly one **Gmail ID** is the durable key in `GH600_REPLY_EVENTS`. `LockService` excludes overlapping cron runs. A `PENDING` event can resume if interrupted. `DONE` events are ignored on subsequent runs.
* For an eligible match, it changes `Uusi` or `Ei soitettu` to `Kontaktoitu`, updates `Last Contact Date` only when the event is not older than the existing date, and writes `Next Action` only if the cell is blank. Other states and manual next actions are never silently overwritten.
* No customer email body is stored. Subjects and sender addresses stay only in the access-controlled CRM event log. Potential opt-outs and negative replies **must be reviewed by a human**; the bot does not classify sentiment or remove suppression holds. Invalid/unmatched/ambiguous replies are quarantined.

## Account authorization and configuration (required before LIVE)

1. In **hello@ghoulhouse.fi** Google Workspace, verify edit access to the existing GhoulHouse master spreadsheet. In that account open [script.google.com](https://script.google.com/) → New project.
2. Paste `Code.gs` into a new script. In Project settings enable **Show appsscript.json** and replace the manifest with the bundled `appsscript.json` (it enables the Gmail v1 advanced service). Ensure the Gmail advanced service is enabled; the automatically created Cloud project normally enables its API automatically.
3. In Project settings → **Script properties**, set:
   - `GH600_SPREADSHEET_ID`: the ID of the **existing** GhoulHouse Master-CRM, not a new sheet.
   - `GH600_E2E_SENDER`: `visualjambo@gmail.com` (controlled internal testing only).
   - `GH600_E2E_MESSAGE_ID`: a **new, not yet logged** Gmail message ID of an actual **reply** from that address received by `hello@ghoulhouse.fi` in a Gmail thread containing an earlier sent message from `hello@ghoulhouse.fi` addressed to `visualjambo@gmail.com`.
4. Run `gh600Install()` manually, accept scopes and confirm `INSTALLED — DRY_RUN`. It adds `GH600_REPLY_EVENTS`, not a campaign or scheduler. This clears the E2E PASS flag.
5. Run `gh600DryRun()`. Inspect its counts and any errors. This never writes CRM events or lead fields.
6. Run **`gh600RunAuthenticatedE2E()`** with a **new reply ID not already in `GH600_E2E_TEST_EVENTS`**. It fetches the real Gmail message and uses only **`GH600_E2E_TEST_LEADS`** and **`GH600_E2E_TEST_EVENTS`**, not production leads. It processes the same message twice and checks **1 event row, exact lead match, no change on replay**. Inspect the returned `PASS` object.
7. After the E2E PASS and a legal/operational review, manually run `gh600EnableSchedule()`. This changes `GH600_MODE` to LIVE and creates one clock trigger, every 5 minutes. It still does **not** unlock the 30-prospect sending queue. To immediately stop the job, run `gh600DisableSchedule()`.

> Do not grant additional Gmail mailbox access or paste passwords, OAuth tokens, or other secrets into this repository, the script source or ChatGPT. Apps Script uses its own user-consented OAuth. Keep the Google Sheet permission-limited. Never publish the event log or full prospect data.

## Engineering / acceptance

`node test.js` performs deterministic mocks of the Apps Script runtime. It checks sender parsing, message qualification, sent-thread ownership, duplicate replay, pending recovery, suppression holds, collision quarantine, immutable stages, formula injection safety and dry-run. **Mocks are not a real Gmail/Sheets E2E.** The authenticated E2E must run in Apps Script before scheduling.

Acceptance gates:

| Gate | Pass condition |
|---|---|
| Source / unit | `node test.js` PASS |
| Real Gmail read | Authenticated account fetches owned reply by real Gmail ID |
| Isolated Sheets write | E2E updates `GH600_E2E_TEST_LEADS`, not `MASTER_LEADS` |
| Idempotence | Two identical runs → one event row; the second run makes no change |
| Safety | Existing GH600 suppression and HOLD gates respected |
| Scheduled operation | One trigger installed under `hello@ghoulhouse.fi` only after E2E PASS |

### Limitations

This is **reply logging**, not campaign delivery, automatic approval, or a universal multi-mailbox CRM bridge. Only outbound messages from **hello@ghoulhouse.fi** in that account's Gmail threads can cause a production CRM update. Hanna's separate mailbox and prior WA/phone history are not automatically covered. Messages from another contact address are quarantined pending human reconciliation. One-time Gmail search looks back 14 days; monitor execution errors and extend lookback before recovering long outages. Google's Apps Script quotas and trigger timing apply.

The script is intended to be reviewed in a **draft PR**, not a deployed Apps Script project. Until the account owner installs and activates it, scheduled live Gmail→CRM automation remains **NOT RUNNING**.

**23 Oct integration trace:** ChatGPT's connected Gmail and Sheets tools manually processed an actual owned reply (`1a166fdf16797d06`) into `GH600_E2E_TEST_EVENTS`, then observed the same Gmail ID skipped on replay (1 logged event total). This is a real service connector test, **not** an execution of the Apps Script deployment. For the Apps Script E2E use a **fresh owned Gmail reply ID**.