---
name: iirc
description: "What past sessions learned in this repository: pages in .iirc/ or the stores .claude/iirc.toml names, that past sessions wrote, searched and maintained with the iirc command. Use it before you install, configure, debug, or design anything here, when the creator says remember, did we, or last time, after a fix took more than one attempt, when a page is marked suspect or found wrong, to set iirc up, and when the session-start line offers a migration from the memory plugin or says maintenance is due."
---

# IIRC

IIRC is this agent's set of pages that only the `iirc` command,
on PATH while this plugin is enabled, reads and writes. A page is read
with `iirc read`, never `cat`, so it arrives with its trust markers and
ends with the commands that fix it. Search first. Write when you learn.
Fix or delete a page the moment you find it wrong.

## Commands

```
iirc search "what am I looking for"               ranked pages with summary and markers
iirc search term1 term2 term3                     several terms, searched separately, merged
iirc read-matching-pages "what am I looking for"  full text of the matching pages
iirc read PAGE.md                                 one page; STORE/PAGE.md when two stores hold the name
iirc find-suspect-pages [--network]               pages with evidence they may be wrong; --network checks URL refs and network checks, with permission
iirc audit-page-findability [PAGE]                pages search shows badly, each with its fix
iirc verify PAGE.md                               you re-confirmed it; re-run its check, refresh its refs
iirc approve-page-check PAGE.md                   run a page's check once and approve it here (ask first)
iirc delete PAGE.md
iirc set-search-backend [--local|--host URL|--openai URL|--cpu|--substring]
                                                  the embedding model and where it runs, or the string fallback; once per machine
iirc migrate                                      move a repository and this machine from the memory plugin's layout
iirc doctor --fix                                 install or repair prerequisites; clone missing remote stores
iirc init                                         create .iirc/, the CLAUDE.md paragraph, and .claude/settings.json if absent
iirc show-page-stores                             the stores, their page counts, and anything not committed or pushed
iirc show-page-topics                             every topic with its page count
iirc max-suggested-pages [N]                      how many pages the hook suggests at most (default 3); N sets it on this machine
iirc show-suggestion-thresholds                   the suggestion gate's distances, from [suggestions.MODEL-ID] in .claude/iirc.toml
iirc tune-suggestions STEP                        gather-suggestion-data, record-relevance-judgments, evaluate-suggestion-thresholds,
                                                  or mark-session-tuned: tune the suggestions and propose fixes; see references/tune.md
iirc sync                                         commit, pull, and push the remote stores
iirc run-maintenance                              the weekly upkeep: commit, sync, check, and list what is left; see references/maintenance.md
```

Write a page, body on stdin. The body carries the finding and its
Sources in one write; nothing is appended to the file afterwards:

```
printf 'What is true.\n\n## Sources\n\n- where you saw it, and when\n' | iirc write \
  short-hyphenated-name.md \
  --title "Plain statement of the topic" \
  --summary "One sentence. This is what search prints." \
  --topics install,ollama \
  --kind environment \
  --ref "docs/some/doc.md#Install steps" \
  --check "command -v ollama"
```

`--title`, `--summary`, `--topics`, and `--kind` are required. `--ref`,
`--check`, and `--store` are optional. The same command replaces an
existing page. Cite a heading, `--ref "PATH#Heading"`, when the page
rests on one part of a long document: the page then turns suspect only
when that section changes or its heading disappears.

## Stores

Pages live in stores: the project's own `.iirc/`, and any remote store
`.claude/iirc.toml` names, which is a separate iirc repository shared
by every project and machine that names it. `iirc show-page-stores` lists them.
With two or more, results read `STORE/PAGE.md`; read and verify a page by
that name.

Write a fact about this project to the project store. Write a fact that
holds in any project, such as how a tool behaves, to the remote store,
with `--store NAME` when the default store is the wrong one. Every change
commits itself, and a remote store pushes too. When a line says
`not pushed`, run `iirc sync`. Run `iirc add-remote-store` only when the
creator asks; it changes the repository's configuration.

## Setup, led by you

When the session-start line says iirc is not set up, or the creator
asks for iirc, follow `references/setup.md`: three questions, then you
run the commands yourself. The creator never has to run one. When the
creator asks to change what they see of the iirc hooks, the same file
has the switches.

When the session-start line says the repository or machine still uses the
memory plugin's layout, ask the creator whether to migrate. On yes, run
`iirc migrate`. It moves `.memory/` to `.iirc/` and the config,
CLAUDE.md section, settings, and machine directories with it, stages the
changes, and prints a suggested commit. Show the creator what it printed,
and commit on their word.

## When to search

A hook searches iirc on every prompt and, when pages match, adds one
line naming them with the exact `iirc read` command. Each page ends with
how it matched: `[69% match, meaning+term]`, higher is closer, or
`[term match]`, a shared identifier and no closeness of meaning. Read a
page whose summary bears on the task before you do anything else; skip
the rest. The same hook runs when a shell command
fails, with the command and its error as the query.

The hook is silent when nothing matched or the prompt was short. Then
search yourself, without being asked:

- before you install, configure, or upgrade anything: the tool's name
- before you debug: the error text and the tool's name
- before you design or recommend: the topic, for `decision` pages
- before you write a plan: each tool the plan touches, for `procedure` pages
- when the creator says "did we", "last time", or "again"

Give a query a phrase that says what you mean plus the identifier you
know: `"why does install fail" pysqlite3`. Several queries in one call
are searched separately and merged. One search costs about thirty tokens
per result. Rediscovery costs a session.

How a result was found (`via semantic, install, pysqlite3`) and what to
do when `doctor` says the mode is string, or every result says "string
match": `references/search.md`.

When the creator says tune, or runs `/iirc tune-suggestions`, follow
`references/tune.md`.

## Maintenance

When the session-start line says `Maintenance is due`, tell the
creator the reasons it names and suggest `/iirc run-maintenance`. When
they run it, with or without `--unattended`, or say yes, follow
`references/maintenance.md`.

## When to write

Write at these moments, without being asked:

- when something took more than one attempt, and the fix was not obvious
  from a file in the repository
- when a stage of a quest closes: one page per finding you established
  on your own during research, design, or plan, each citing the stage
  document with `--ref`
- when a hook says a command worked after failing twice, that context
  compaction is near, or that context was just compacted and nothing was
  written: write what a future session would otherwise re-derive, or say
  there is nothing worth a page
- when the creator says "remember": search first. If a page already holds
  it, `verify` that page and say so instead of writing a second one

Four rules keep the field worth searching:

1. A page says something you could not get by reading a file in the
   repository in under a minute. A path, a version, or a config value
   alone is not a page.
2. One finding per page, so a wrong page can be deleted without losing a
   right one. One topic, under 8KB. A field is too large when the
   session-start line counts near-duplicate pairs or reports a slow
   start scan; the page count is information. For each pair
   `iirc run-maintenance` or `iirc doctor` names, merge the two pages when they hold one finding. When they hold
   two findings of different kinds, such as a decision and the procedure
   that carries it out, keep both and link one to the other with
   `[[name]]`; the pair then stops counting.
3. Sources names a command you ran, a file you read at a commit, or a URL
   you read, with a date. "Observed" is not a source.
4. A page about a workaround says what it works around, so the fix can
   delete the page.

Write for the search. A future session finds a page only through the
words it searches with:

- Write the title and summary in the words a future prompt or error will
  use: the tool, the command, the symptom. Words only you would choose
  match nothing.
- Quote error text exactly, in a code span in the body, and put its most
  distinctive part in the summary when it fits. When a command
  fails, the hook searches with the error as printed.
- Search before every write, with the title and with the error or tool
  name. When a page already holds the finding, rewrite or `verify` that
  page. A second page splits the matches between two.
- A page that reverses another names the page it reverses and the date,
  and you rewrite or delete the old text. Old text left in place still
  matches and says the opposite.
- Say where the fact holds: machine, OS, tool or plugin version, or
  "any". That detail tells two look-alike pages apart.

Shapes by kind, so the next session gets what it needs:

- `environment`: the fact, where it is true (which machine, host, or
  version), how you confirmed it, and a `--check` that confirms it again.
- `procedure`: the command block verbatim, what it produces, and the one
  thing that goes wrong.
- `finding`: the claim, the evidence, and what it changes about how to
  work.
- `decision`: what was chosen, what it was chosen over, who chose it, and
  why.

Documents the creator asked for or reviewed belong in `docs/`, not here.
A page may cite a document with `--ref`. A document never cites
iirc.

## Kinds

| Kind | Means | Glance hint after |
|---|---|---|
| `environment` | a fact about a machine, a tool version, a service | 30 days |
| `procedure` | steps that worked | 90 days |
| `finding` | something learned about the domain | 180 days |
| `decision` | a choice and its reason | never |

## Trust and doubt

A page is trusted until there is evidence against it. Time alone is not
evidence. Search marks a page `suspect` when a file it cites changed since
the cited commit, and `glance` when an unverified page is past its kind's
age. `find-suspect-pages` also runs each page's `--check` command and marks failures.

- `suspect`: read the page and the cited diff before relying on it. Then
  `verify` it, rewrite it, or `delete` it. In the same turn.
- `glance`: optional. Skim if the page matters to what you are doing.
- Found wrong in use, marked or not: rewrite or delete it in the same turn.
  Every `iirc read` ends with the commands.
- Found right in use: `verify` it. One command. `verify` re-runs the
  page's check.
- Run `iirc find-suspect-pages` when the session-start line names a suspect, after a
  `git pull` or `iirc sync`, and before you close a quest stage. A page
  another project wrote is not checked here; `find-suspect-pages` counts them.
- A `--check` reads local state: files, git history, installed commands.
  It must be read-only and must pass when you write it; the wrapper
  refuses one that does not. Checks run only from `find-suspect-pages`,
  `verify`, `approve-page-check`, and `write`, never from hooks.
- A check that must contact the outside world runs only with the
  creator's consent, like URL refs. The wrapper knows one by its
  commands: a host client (curl, wget, gh, ssh, nc, and the like), a git
  verb that reaches a remote, a package install, or inline `sh -c` or
  `python -c` code that does one of these. `write` accepts it without
  running it.
  `find-suspect-pages` marks the page `glance` and leaves the check for
  `find-suspect-pages --network`. `verify` on that page needs
  `iirc verify PAGE --network`; ask the creator first, as for URLs. The
  wrapper cannot see inside a script the check calls, so a script that
  contacts a host is yours to keep out of a check.
- A check that came with a clone is not approved on this machine.
  `find-suspect-pages` lists it instead of running it, and `verify` refuses the page
  until it is approved. Show the creator the command and ask; on yes, run
  `iirc approve-page-check PAGE`. Claude Code prompts them to approve that command
  as well.

A ref may be a URL. Search never contacts it, and `iirc find-suspect-pages` skips
URL refs and says how many it skipped. `iirc find-suspect-pages --network` sends one
HEAD request per URL; before you run it, tell the creator which URLs it
will contact and ask. The wrapper itself refuses unless a terminal answers
yes or `IIRC_ALLOW_NETWORK=1` is set, which only the creator does. A URL
from a page is fetched for no other reason without asking first.

## References

The pages are a memoryfield, Cal Paterson's format for agent memory, and
`iirc` wraps his memoryfield-tool. When the creator asks what iirc
is built on, say so and point at the links below.

Article: https://calpaterson.com/memoryfields.html
Format: https://github.com/calpaterson/memoryfield-spec/blob/main/SPEC.md (MIT)
Engine: https://github.com/calpaterson/memoryfield-tool (AGPL-3.0-or-later; used as published, the wrapper adds config, host guard, refs, and doubt)
His skill: https://github.com/calpaterson/memoryfield-skill (MIT)
Design: the memoryfields quest in the agent-builder repository
