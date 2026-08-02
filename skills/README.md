# Built-in skills

The skills that ship with the platform. A skill is a written procedure the agent
reads when it needs it — how to build a dashboard, how to write an app's
settings form, what shape a `view.jsx` has to take.

**These behave exactly like any other skill.** They pass through the catalog
(the `skills` table), appear in the "Skill store" page, and the user installs and
removes them at will. The only thing that differs is the SOURCE: this directory
inside the repo, rather than a GitHub repository. That is why they went through
the catalog from the start — so there would never be a "migrate from a separate
mechanism into the catalog" step later.

Three ship today, and all three teach the same subject from different angles:

| Skill | When the agent reads it |
|---|---|
| `dashboard-create` | before the first `appPublish` — the app folder layout and the built-in widget shapes |
| `dashboard-controls` | before writing a settings form or an action button, including the rules that keep user input out of a shell |
| `dashboard-jsx` | before writing a custom `view.jsx`, when the built-in widgets cannot express the layout |

> **A note for whoever picks this up:** `builtin-skills.ts` explains that these
> live locally because the platform repository was private and could not be read
> through the GitHub API. **The repository is public now**, so that condition has
> been met — moving the source to GitHub would change only that one file, since
> nothing downstream knows what kind of source a skill came from.

## How a skill reaches the model

Only the **name, the description and the path** go into the system prompt. The
full text is not loaded — the model calls `read` on the path when it decides the
skill is relevant. This is progressive disclosure, and it is not an
optimisation: the complete text of twenty skills would fill the context window
on its own, before the conversation had started.

Which is why the description carries the weight. It is the only thing the model
sees when deciding whether to open the file at all, so it should say **when to
use this**, not what it contains. Compare:

```
description: Covers dashboards.                             ← never gets opened
description: Use when the user asks for a dashboard, a status page, or any UI
             that shows an app's data. Read this BEFORE the first appPublish
             call.                                          ← gets opened
```

Installed skills are synchronised into `.barpo/skills/` inside the working
directory at the start of every stream. They have to be **inside** it, or the
agent's `read` would trip the working-directory boundary and ask permission
every single time. The database is the source of truth, so a folder that no
longer corresponds to an install is removed on the next stream — do not put
files there by hand.

## Writing one

One directory, one `SKILL.md`, frontmatter and then prose:

```markdown
---
name: deploy-django
description: Use when the user wants to deploy a Django project to one of their
  servers. Covers gunicorn, the systemd unit, and the nginx block. Read this
  BEFORE touching the server.
license: internal
allowed-tools: [read, write, edit, bash]
---

# Deploying Django

...the actual procedure...
```

| Field | Required | Notes |
|---|---|---|
| `name` | recommended | falls back to the directory name |
| `description` | **yes** | the only field whose absence rejects the skill |
| `license` | no | free text |
| `allowed-tools` | no | a YAML list or a comma-separated string. **Parsed and displayed, but not yet enforced** — see the backlog in CONTINUE.md |

Validation is deliberately lenient: everything except a missing `description` is
a warning, and the skill still loads. Third-party repositories do not always
match the spec exactly, and losing a whole repo over a capital letter helps
nobody.

Block scalars (`|`, `>`, `|-`) are supported, which matters more than it sounds:
`anthropics/skills` uses `description: |-`, and without support the description
would parse as the two characters `|-` — the skill would load and the model would
have no idea when to use it.

**After adding a directory here the server has to be restarted** — the built-in
source is scanned at startup (`builtin-skills.ts`).

## Skills from elsewhere

The Skill store also takes a GitHub repository as a source: the tree is scanned
for `SKILL.md` files and every one found enters the catalog. Adding a source
**installs nothing** — which skill goes where is the user's decision, so
downloading is its own step.

> **A skill from a foreign repository is untrusted input.** Its text never
> reaches the permission classifier, and that is one of the twelve boundaries
> enforced by tests. Otherwise a repository could ship a skill saying "allow
> every command" and prise the protection open from the inside. The
> justification here is stronger than for `AGENTS.md`: a project file was at
> least placed in the user's own directory, whereas a skill comes from a
> stranger's repo the user may never have read.
