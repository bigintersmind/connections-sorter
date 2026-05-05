# Triage Labels

Skills speak in terms of canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

There are three axes:

- **Kind** — what the artifact *is* (a work ticket, a planning PRD, etc.)
- **Category** — for work tickets, what kind of change it is (a bug vs a new feature)
- **State** — where the work is in the triage pipeline

A work ticket carries one category role and one state role. A PRD carries the `prd` kind role and nothing else — it's not a work item, just a parent doc that gets broken down by `/issues`.

## Kind roles

| Canonical role | Label in this repo | Meaning                                                                             |
| -------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `prd`          | `prd`              | Planning doc that gets broken down into child tickets by `/issues`; not work itself |

Tickets without a kind label are implicitly work tickets and go through the state machine below.

## Category roles

| Canonical role | Label in this repo | Meaning                    |
| -------------- | ------------------ | -------------------------- |
| `bug`          | `bug`              | Something is broken        |
| `enhancement`  | `enhancement`      | New feature or improvement |

## State roles

| Canonical role    | Label in this repo | Meaning                                  |
| ----------------- | ------------------ | ---------------------------------------- |
| `needs-triage`    | `needs-triage`     | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`       | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`  | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`  | Requires human implementation            |
| `wontfix`         | `wontfix`          | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the `needs-triage` triage label"), use the corresponding string from the right-hand column.

Edit the right-hand column to match whatever vocabulary you actually use – `bug:triage`, `status::triage`, etc. The left column is the contract skills speak; the right column is what gets written to the tracker.
