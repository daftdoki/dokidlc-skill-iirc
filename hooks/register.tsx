import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, ResolveInput } from 'claude-code'

import type { Cursor, IircHealth, IircStatus, MatchAverages, Reader, RecalledPage, SessionCounts, SessionPages, SessionView, ShownPage, ToolNote } from '../types'

// The command hooks in hooks.json put lines into the model's context. This module
// catches each line as its row is stored and draws it for the person: recalled
// pages as a folding list under the prompt or the failed command, a pencil row
// under a command that failed and then worked, the session brief and the count
// of pages read this session in the hint row under the prompt, and warnings as
// toasts.
// `ui = false` in .claude/iirc.toml turns it off.

const NO_MATCH: MatchAverages = { all: null, read: null, unread: null }
const byPrompt = atom({ plugin: 'iirc', key: 'byPrompt' } as const, {})
const byTool = atom({ plugin: 'iirc', key: 'byTool' } as const, {})
const open = atom({ plugin: 'iirc', key: 'open' } as const, {})
const lastPrompt = atom({ plugin: 'iirc', key: 'lastPrompt' } as const, null)
const lastTool = atom({ plugin: 'iirc', key: 'lastTool' } as const, null)
const briefShown = atom({ plugin: 'iirc', key: 'briefShown' } as const, null)
const status = atom({ plugin: 'iirc', key: 'status' } as const, null)
const counts = atom({ plugin: 'iirc', key: 'counts' } as const, { reads: 0, writes: 0, suggested: 0, used: 0, missed: [], match: NO_MATCH, timeouts: 0 })
const health = atom({ plugin: 'iirc', key: 'health' } as const, null)
const reader = atom({ plugin: 'iirc', key: 'reader' } as const, { page: null, history: [], error: null, loading: null, tab: 'session' } as Reader)
// pages `/iirc show` read, by name, for the transcript card that draws each
const shownPages = atom({ plugin: 'iirc', key: 'shownPages' } as const, {})
const SHOW_ARGS_RE = /^\s*show\s+(\S+)\s*$/
const READER_ARGS_RE = /^\s*reader(?:\s+(\S+))?\s*$/
const cursor = atom({ plugin: 'iirc', key: 'cursor' } as const, { session: 0, page: 0, sessionTop: 0, pageTop: 0 } as Cursor)
// The pane scrolls its own content under a fixed header (the tab row, the keys, a row for "↑ N above"),
// so the hook remembers what the last drawing measured: the rows under the header, and each item's height
const HEADER_ROWS = 4
let paneRows = 20
let sessionRowStops: (string | null)[] = []
let pageHeights: number[] = []
let scrollRest = 0
const sessionPages = atom({ plugin: 'iirc', key: 'sessionPages' } as const, { read: [], written: [], suggested: [], used: [], gone: [] } as SessionPages)
// `/iirc reader demo`'s sample session: the pane draws it in place of the real one until the pane closes or a
// plain `/iirc reader` opens. It never goes into sessionPages, counts, or health, which the summary line and the cards draw
const demoSession = atom({ plugin: 'iirc', key: 'demoSession' } as const, null as SessionView | null)
// one pane with two tabs of its own: this session's pages, and a reader the page names open.
// Not two panes: an open from a click counts as unasked, and an unasked pane waits undrawn below
// 144 columns; tabs inside one pane switch with no open at all
const PANE = 'iirc'
// a tab label past this many characters is cut
const TAB_TITLE_MAX = 32
const isStatusShown = atom({ plugin: 'iirc', key: 'isStatusShown' } as const, true)
// Before compaction: past this share of the auto-compact threshold (of the window when auto-compaction
// is off), ask `iirc remind-to-write --at compaction` once for its line, and hand it to the model with the next tool
// result or prompt, whichever comes first. A tenth short leaves the writing turn about 17k tokens on a
// 200k window and about 97k on a 1M one; a turn that grows more than that compacts first.
const COMPACT_NEAR = 0.9
const compactAsked = atom({ plugin: 'iirc', key: 'compactAsked' } as const, false)
const compactNudge = atom({ plugin: 'iirc', key: 'compactNudge' } as const, null)
const maxSuggested = atom({ plugin: 'iirc', key: 'maxSuggested' } as const, null)

const RECALL_RE = /iirc: \d+ pages? may apply\. Read a page whose summary bears on this task; skip the rest: (.*)/
const RECOVERED_RE = /`([^`]+)` failed (\d+) times this session before it worked/g
const STOP_RE = /iirc: before you stop, note that (.*?) failed and then worked/
const MIGRATE_RE = /^iirc: this repository or machine still uses the memory plugin's layout/
const BRIEF_RE = /iirc: (\d+) pages?, (semantic via \S*[^\s.]|string only \([^)]*\)|string search)[^.]*\.\s*(.*)/s
// the command that clears each kind of warning, in the order the line under the prompt names one:
// setup errors first, then the one upkeep command, which covers suspect pages, loose and unpushed commits, timeouts, and near-duplicates
const MAINTAIN = '/iirc run-maintenance'
const WARNING_FIX: [RegExp, string][] = [
  [/memoryfield-tool is not at the pin/, 'iirc doctor --fix'],
  [/Persistence:/, 'iirc doctor --fix'],
  [/Maintenance is due/, MAINTAIN],
  [/not committed/, MAINTAIN],
]
// sentences of the brief that are instructions to the model, not news for the person
const BRIEF_QUIET = /^(Topics:|Stores:|A hook names|Context was just compacted)/
// commands that change the page count or the setup the brief reports, and commands that read pages (read also matches read-matching-pages)
const CHANGES_BRIEF_RE = /\biirc\s+(write|delete|sync|migrate|set-search-backend|init|doctor|run-maintenance)\b/
const COUNTS_RE = /\biirc\s+(read|write)\b/
// fixed red, yellow, green rather than the theme's, whose success color may be blue
const LEVEL_COLOR = { ok: '#57ab5a', warn: '#d4a72c', error: '#e5534b' } as const
const SUMMARY_LINE_ARGS_RE = /^\s*summary-line-visibility(?:\s+(on|off))?\s*$/
// iirc commands a person may run straight from /iirc; the rest go to the skill, which asks first
const DIRECT_RE = /^(doctor(?:\s+--fix)?|find-suspect-pages(?:\s+--all)?|show-page-stores|sync|summarize-page-usage(?:\s+--days\s+\d+)?|rebuild-search-index|estimate-context-tokens|show-page-topics|show-suggestion-thresholds|search\s+\S.*|read(?:\s+\S+)+)$/s
const MAX_SUGGESTED_ARGS_RE = /^\s*max-suggested-pages(?:\s+(\S+))?\s*$/
// columns left of a page's text: the fold's indent (3), the list's (2), and the branch (3), plus one spare
const PAGE_INDENT = 9
// red, amber, green: the hit-rate gauge, stepped by position along the bar
const GAUGE = ['#e5534b', '#d4a72c', '#57ab5a'] as const
// sample numbers for `/iirc demo`
const DEMO_STATUS: IircStatus = { level: 'ok', pages: 142, mode: 'semantic+keyword', note: null }
const DEMO_COUNTS: SessionCounts = {
  reads: 58, writes: 9, suggested: 42, used: 31,
  match: { all: 68, read: 74, unread: 55 },
  timeouts: 0,
  missed: [['ollama-keep-alive-for-the-embed-model.md', 4], ['plugin-cache-keeps-old-versions.md', 3], ['gh-auth-on-a-new-machine.md', 2]],
}
const DEMO_HEALTH: IircHealth = {
  suspect: [],
  due: [],
  stores: [{ name: 'project', kind: 'project', pages: 97, uncommitted: 0, unpushed: 0 }, { name: 'shared', kind: 'remote', pages: 45, uncommitted: 0, unpushed: 0 }],
}
// `/iirc demo doctor`: doctor's own lines for a sample machine, 13 checks with one failure and one note,
// so a screenshot shows every part of the card and none of the capturing machine's own failures
const DEMO_DOCTOR_RE = /^demo\s+doctor$/
const DEMO_DOCTOR = [
  'ok  .claude/iirc.toml loads, so the hooks run',
  'ok  suggest-pages finished inside the hook\'s 5 s limit in the last 7 days',
  'ok  uv on PATH',
  'FAIL memoryfield-tool at 3e447e1  (iirc doctor --fix)',
  'ok  embedding endpoint http://127.0.0.1:11434 answers within 2 s (serving nomic-embed-text, 768 wide)',
  'ok  store project at .iirc',
  'ok  store project has no uncommitted changes',
  'ok  store shared at ~/.local/share/dokidlc-iirc/stores/shared-3021cfb6',
  'ok  store shared tracks git@example.com:team/iirc-shared.git',
  'ok  store shared has nothing unpushed',
  'ok  store shared holds only pages and index.md',
  'ok  CLAUDE.md has the iirc paragraph',
  'ok  field validates',
  'note near-duplicate pages (distance 0.060): ollama-keep-alive.md | ollama-unloads-the-embed-model.md',
  '     index cache: ~/Library/Caches/dokidlc-iirc/vectors (derived, never committed; rebuilt by `iirc rebuild-search-index`)',
].join('\n')
// pages the card names under SUGGESTED, NOT READ, and under TRUST
const LIST_MAX = 3
// the commands /iirc lists, as the card and the text help list them
// run-maintenance, tune-suggestions, and audit-page-findability go to the skill, which runs them and asks for each fix; the rest run directly
const COMMANDS: [string, string, 'MAINTENANCE' | 'LOOK UP'][] = [
  ['run-maintenance', 'the only thing you need to run, weekly', 'MAINTENANCE'],
  ['doctor', 'check the setup and the pages', 'MAINTENANCE'],
  ['doctor --fix', 'install or repair, rebuild the index', 'MAINTENANCE'],
  ['find-suspect-pages', 'pages that may be wrong', 'MAINTENANCE'],
  ['audit-page-findability', 'pages search shows badly, with fixes', 'MAINTENANCE'],
  ['sync', 'commit, pull, and push remote stores', 'MAINTENANCE'],
  ['show-page-stores', 'the stores, and anything not pushed', 'MAINTENANCE'],
  ['summarize-page-usage', 'how the pages are being used', 'MAINTENANCE'],
  ['rebuild-search-index', 'rebuild the search index', 'MAINTENANCE'],
  ['show-suggestion-thresholds', "the gate's distances and their ranges", 'MAINTENANCE'],
  ['tune-suggestions', 'judge suggestions, evaluate thresholds', 'MAINTENANCE'],
  ['estimate-context-tokens', 'tokens of index.md and of a search', 'MAINTENANCE'],
  ['search QUERY', 'ranked pages for a query', 'LOOK UP'],
  ['show-page-topics', 'every topic with its page count', 'LOOK UP'],
  ['read PAGE', 'one page, with its trust markers', 'LOOK UP'],
  ['unfold-suggested-pages', 'unfold the latest suggested pages', 'LOOK UP'],
  ['reader [PAGE]', 'session pages, or one page, in a pane', 'LOOK UP'],
  ['show PAGE', 'one page as a card, your read', 'LOOK UP'],
]
// the card's title: the expansion's letters bright, the tagline a gradient from the accent orange to violet
const TITLE = '#e6edf3'
const TAGLINE = 'what past sessions learned, recalled by meaning'
const TAGLINE_FROM = '#e8875f'
const TAGLINE_TO = '#a78bfa'
// the card's frame is the gradient's violet end; the STATUS chip carries the health color
const FRAME = '#a78bfa'
const EXAMPLES = ['what do we know about ollama hangs?', 'remember that the NAS keeps its firmware in /etc', "what's out of date?"]
const MORE_HINT = 'settings, maintenance, and look-up'
const STATUS_HINT = 'trust, stores, session counts, and suggestion noise'
const REQUEST_HINT = 'ask in words; goes to the skill'
// section titles: brighter than the tagline's end, so they read before the rows under them
const HEADING = '#c4b5fd'
// the settings' commands, as the card and the text help list them
const SET_LINE = '/iirc summary-line-visibility'
const SET_MAX = '/iirc max-suggested-pages N'
const SET_SEARCH = '/iirc set-search-backend'
const REQUEST_CMD = '/iirc <request>'
// the help card's command column: the longest command, plus a gap. A row is 2 + CMD_COL + its text, so a
// text of up to 40 characters keeps every row inside an 80-column terminal's 76 inner columns
const CMD_COL = 2 + Math.max(...[SET_LINE, SET_MAX, SET_SEARCH, REQUEST_CMD, ...COMMANDS.map(([cmd]) => `/iirc ${cmd}`)].map(c => c.length))
// the hit-rate gauge: its cells, and its title row, the title then a percentage of up to four characters
const BAR = 36
const GAUGE_TITLE = 'SUGGESTION HIT RATE · THIS SESSION'
const GAUGE_W = Math.max(BAR + 2, 2 + GAUGE_TITLE.length + 5)
// one row of the text help: the command in the card's column, then what it does
const row = (cmd: string, what: string) => `${cmd.padEnd(CMD_COL)}${what}`
const KEEP = 200

/**
 * A prompt's key: its uuid's first four groups. The UserMessage row's requestId
 * can carry the prompt's uuid with the last group zeroed
 * (40d603b1-96c7-41d7-9dc0-000000000000 for …-00885dcac635, Claude Code 2.1.295),
 * so the two meet on the part they share.
 */
export function promptKey(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.slice(0, 23) : id
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('\n')
}

export function parseRecall(text: string): RecalledPage[] {
  const m = RECALL_RE.exec(text)
  if (!m) return []
  const pages: RecalledPage[] = []
  for (const entry of m[1].split(' · ')) {
    const name = /`iirc read ([^`]+)`/.exec(entry)?.[1]
    if (!name) continue
    const isSuspect = entry.includes('`iirc verify ')
    let rest = entry.slice(entry.indexOf('`', entry.indexOf(name)) + 1).trim()
    if (rest.startsWith('(')) rest = rest.slice(1)
    // (summary) [how it matched] (suspect: ...), the last two optional
    const match = /\) \[([^\]]+)\]/.exec(rest)
    const cut = match ? match.index : isSuspect ? rest.lastIndexOf(') (') : rest.lastIndexOf(')')
    pages.push({ name, summary: (cut >= 0 ? rest.slice(0, cut) : rest).trim(), isSuspect, ...(match ? { match: match[1] } : {}) })
  }
  return pages
}

export function parseRecovered(text: string): ToolNote['recovered'] {
  return [...text.matchAll(RECOVERED_RE)].map(m => ({ command: m[1], failures: Number(m[2]) }))
}

/** What the hint row shows and the warnings worth a toast, from the SessionStart line. */
export function parseBrief(text: string): { status: IircStatus; warnings: string[] } | null {
  const at = text.indexOf('iirc: ')
  if (at < 0) return null
  const line = text.slice(at)
  const m = BRIEF_RE.exec(line)
  if (!m) {
    // each of these lines names the command that fixes it, in backticks
    const fix = /`(iirc [^`]+)`/.exec(line)?.[1] ?? (/newer iirc plugin/.test(line) ? 'update the plugin' : undefined)
    const note = MIGRATE_RE.test(line)
      ? 'needs migration'
      : /not set up/.test(line)
        ? 'needs setup'
        : /no \.iirc\//.test(line)
          ? 'needs init'
          : /^iirc: hooks off/.test(line)
            ? 'hooks off'
          : /no store/.test(line)
            ? 'needs a store'
            : /newer iirc plugin/.test(line)
              ? 'needs a plugin update'
              : 'needs setup'
    const warnings = MIGRATE_RE.test(line) ? [] : [line.split('. ')[0].replace(/^iirc: /, '')]
    return { status: { level: 'error', pages: null, mode: null, note, ...(fix ? { fix } : {}) }, warnings }
  }
  // semantic search also matches terms; without an embedding host it matches terms alone
  const isHostDown = m[2].startsWith('string only')
  const mode = m[2].startsWith('semantic') ? 'semantic+keyword' : 'keyword'
  const warnings = m[3]
    .split(/(?<=\.)\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(s => s && !BRIEF_QUIET.test(s))
  const fix = isHostDown ? 'iirc set-search-backend' : WARNING_FIX.find(([re]) => warnings.some(w => re.test(w)))?.[1]
  const level = isHostDown || warnings.length > 0 ? 'warn' : 'ok'
  return { status: { level, pages: Number(m[1]), mode, note: null, ...(fix ? { fix } : {}) }, warnings }
}

/** The hint row's text after the circle. */
/** The brief's status, turned yellow when a recall this session ran past the hook's time limit. */
export function liveStatus(s: IircStatus, c: SessionCounts): IircStatus {
  return s.level === 'ok' && c.timeouts > 0 ? { ...s, level: 'warn', fix: MAINTAIN } : s
}

export function statusText(s: IircStatus, c: SessionCounts): string {
  s = liveStatus(s, c)
  const fix = s.level !== 'ok' && s.fix ? ` · run ${s.fix}` : ''
  if (s.pages === null) return `iirc: ${s.note}${fix}`
  // the mode shows only when it is not the default, so a weaker search stands out
  const mode = s.mode === 'semantic+keyword' ? '' : ` · [${s.mode}] mode`
  const timedOut = c.timeouts > 0 ? ` · [${c.timeouts}] timed out` : ''
  return `iirc: [${s.pages}] ${s.pages === 1 ? 'page' : 'pages'} · [${c.used}/${c.suggested}] used · [${c.reads}] reads · [${c.writes}] writes${timedOut}${mode}${fix}`
}

function keepLast<T>(map: Record<string, T>, key: string, value: T): Record<string, T> {
  const next = { ...map, [key]: value }
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[k]
  return next
}

async function uiEnabled($: EngineInterface): Promise<boolean> {
  try {
    const toml = await $.fs.read(`${await $.session.root()}/.claude/iirc.toml`)
    return !/^\s*ui\s*=\s*false\b/m.test(toml)
  } catch {
    return true
  }
}

/** The brief in the hint row, and its warnings as a toast once per distinct brief. */
async function showBrief($: EngineInterface, text: string) {
  const brief = parseBrief(text)
  if (!brief) return
  await update($, status, () => brief.status)
  const warned = brief.warnings.join(' ')
  if (warned && (await read($, briefShown)) !== warned) {
    await update($, briefShown, () => warned)
    $.ui.toast(`iirc: ${brief.warnings.join(' ')}`)
  }
}

/** Run one iirc command for the person and return what it printed. A search keeps its words as one query. */
async function runDirect($: EngineInterface, args: string): Promise<string> {
  const [verb, ...rest] = args.split(/\s+/)
  const argv = verb === 'search' ? [verb, rest.join(' ')] : [verb, ...rest]
  // these may embed or fetch: up to ten minutes
  const slow = args === 'doctor --fix' || verb === 'sync' || verb === 'rebuild-search-index'
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, ...argv], { cwd: await $.session.root(), timeoutMs: slow ? 600000 : 60000 })
    if (['doctor', 'sync', 'rebuild-search-index'].includes(verb)) refreshBrief($)
    const out = `${ran.stdout}${ran.stderr}`.trim() || '(no output)'
    return ran.exitCode === 0 ? out : `iirc ${args} exited ${ran.exitCode}:\n${out}`
  } catch (err) {
    return `iirc ${args} did not finish: ${String(err)}`
  }
}

/** A plain /iirc is home, the short card; status is every number; help is the settings and commands. */
type CardView = 'home' | 'status' | 'help'

/** The text a plain /iirc, /iirc status, or /iirc help returns; the cards draw over it, and it stands where they cannot. */
async function helpText($: EngineInterface, view: CardView): Promise<string> {
  const s = await read($, status)
  let max = '?'
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'max-suggested-pages'], { cwd: await $.session.root(), timeoutMs: 15000 })
    max = /up to (\d+)/.exec(ran.stdout)?.[1] ?? '?'
  } catch {}
  if (max !== '?') await update($, maxSuggested, () => Number(max))
  // the engine puts the plugin's name in front of a command's text
  const head = s === null ? 'no session brief yet' : statusText(s, await read($, counts)).replace(/^iirc: /, '')
  const shown = (await read($, isStatusShown)) ? 'on' : 'off'
  if (view === 'home') return `${head}\n/iirc <request> asks iirc in words; /iirc help lists the settings and commands; /iirc status shows ${STATUS_HINT}`
  if (view === 'status') {
    await refreshHealth($)
    return [head, ...healthLines(await read($, health), await read($, counts))].join('\n')
  }
  return [
    `summary line ${shown} · max-suggested-pages ${max} · search ${s?.mode ?? '?'}`,
    row(SET_LINE, 'on|off: show or hide the summary line'),
    row(SET_MAX, 'pages per suggestion line (1-10)'),
    row(SET_SEARCH, 'the embedding model, or substring search'),
    ...COMMANDS.map(([cmd, what]) => row(`/iirc ${cmd}`, what)),
    row(REQUEST_CMD, REQUEST_HINT),
  ].join('\n')
}

/** A text cut to a width with an ellipsis, for a row of one-character Texts that would otherwise shrink some to nothing. */
export function fitTo(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

/** A page name as a tab label: no `.md`, cut to TAB_TITLE_MAX. */
export function tabTitle(name: string, max = TAB_TITLE_MAX): string {
  const bare = name.replace(/\.md$/, '')
  const room = Math.min(max, TAB_TITLE_MAX)
  return bare.length > room ? bare.slice(0, room - 1) + '…' : bare
}

/** `iirc show PAGE` for a transcript card: the page, kept by name for the card's drawing, or why not. */
async function showPage($: EngineInterface, ref: string): Promise<{ page: ShownPage | null; error: string | null }> {
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'show', ref], {
      cwd: await $.session.root(),
      timeoutMs: 15000,
      env: { CLAUDE_CODE_SESSION_ID: await $.session.id() },
    })
    if (ran.exitCode !== 0) return { page: null, error: (ran.stderr || ran.stdout).trim().replace(/^iirc: /, '') || `iirc show exited ${ran.exitCode}` }
    const page = JSON.parse(ran.stdout) as ShownPage
    await update($, shownPages, map => keepLast(map, page.name, page))
    return { page, error: null }
  } catch (err) {
    return { page: null, error: `iirc show ${ref} did not finish: ${String(err)}` }
  }
}

/** Read one page with `iirc show`, the person's read, and show it in the reader tab. Back passes isBack, which keeps the history. */
async function openPage($: EngineInterface, ref: string, isBack = false) {
  await update($, reader, r => ({ ...r, loading: ref, tab: 'page' as const }))
  await update($, cursor, x => ({ ...x, page: 0, pageTop: 0 }))
  // a name in the tree or a card opens the pane; inside the pane this only retitles it
  const opened = await $.ui.open({ id: PANE, title: 'iirc reader', focus: true })
  if (!opened.isPlaced) $.ui.toast(`iirc: the reader is waiting: ${opened.reason}; /iirc reader opens it`)
  // while the page loads, the ring stays off the keys row too, where Enter would close the tab or the reader
  await $.ui.focus({ requestId: PANE, key: 'tab-page' }).catch(() => undefined)
  let page: ShownPage | null = null
  let error: string | null = null
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'show', ref], {
      cwd: await $.session.root(),
      timeoutMs: 15000,
      env: { CLAUDE_CODE_SESSION_ID: await $.session.id() },   // the person's read lands in this session's log
    })
    if (ran.exitCode === 0) page = JSON.parse(ran.stdout) as ShownPage
    else error = `could not open ${ref}: ${(ran.stderr || ran.stdout).trim().replace(/^iirc: /, '') || `iirc show exited ${ran.exitCode}`}`
  } catch (err) {
    error = `iirc show ${ref} did not finish: ${String(err)}`
  }
  await update($, reader, r => ({
    ...r,
    page: page ?? r.page,
    error,
    loading: null,
    history: isBack || !page || !r.page || r.page.label === page.label ? r.history : [...r.history, r.page.label].slice(-20),
  }))
  // the name that held the focus ring is gone with the session tab, and the ring would fall on the next button, `x`,
  // so a second Enter would close the page; the page's own tab chip takes it, where Enter changes nothing
  if (page) await $.ui.focus({ requestId: PANE, key: 'tab-page' }).catch(() => undefined)
}

/** The page before this one, if the reader has one. */
async function goBack($: EngineInterface) {
  const r = await read($, reader)
  const prev = r.history[r.history.length - 1]
  if (!prev) return
  await update($, reader, x => ({ ...x, history: x.history.slice(0, -1) }))
  await openPage($, prev, true)
}

/** A page body split at blank lines, a fenced block kept whole: the stops `j` and `k` move between. */
export function paragraphs(body: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let isFence = false
  for (const line of body.trim().split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) isFence = !isFence
    if (!isFence && line.trim() === '') {
      if (cur.length > 0) out.push(cur.join('\n'))
      cur = []
      continue
    }
    cur.push(line)
  }
  if (cur.length > 0) out.push(cur.join('\n'))
  return out
}

/** The suggested pages in drawing order: read first, then the unread most often suggested. */
function sortSuggested(sp: SessionPages, c: SessionCounts): string[] {
  const times = new Map(c.missed)
  const used = new Set(sp.used)
  return [...sp.suggested].sort((a, b) => Number(used.has(b)) - Number(used.has(a)) || (times.get(b) ?? 0) - (times.get(a) ?? 0))
}

/** The keys `j` and `k` step through in the Session tab: every page link, in drawing order. */
function sessionStops(sp: SessionPages, c: SessionCounts, checkup: IircHealth | null): string[] {
  const gone = new Set(sp.gone)
  return [
    ...sortSuggested(sp, c).filter(n => !gone.has(n)).map(n => `open-s-${n}`),
    ...sp.written.filter(n => !gone.has(n)).map(n => `open-w-${n}`),
    ...(checkup?.suspect ?? []).map(n => `open-x-${n}`),
  ]
}

/** The page tab's stops: each paragraph of the body, then each linked page. */
function pageStops(page: ShownPage): string[] {
  return [...paragraphs(page.body).map((_, i) => `para-${i}`), ...page.links.map(n => `link-${n}`)]
}

/** Move the cursor of the shown tab: a step for `j` and `k`, or to an end for `g` and `e`; the content scrolls to keep it in view. */
async function moveCursor($: EngineInterface, step: number | 'start' | 'end') {
  const r = await read($, reader)
  const isPage = r.tab === 'page' && r.page !== null
  const v = await sessionView($)
  const stops = isPage && r.page ? pageStops(r.page) : sessionStops(v.pages, v.counts, v.health)
  if (stops.length === 0) return
  const c = await read($, cursor)
  const at = isPage ? c.page : c.session
  // a cursor scrolled out of view comes back first: the first j after the pane opens lands on the first page name
  const atRow = sessionRowStops.indexOf(stops[at] ?? '')
  const isHidden = !isPage && atRow >= 0 && (atRow < c.sessionTop || atRow >= c.sessionTop + paneRows)
  const next = step === 'start' ? 0 : step === 'end' ? stops.length - 1 : isHidden ? at : Math.max(0, Math.min(stops.length - 1, at + step))
  const key = stops[next]
  if (key === undefined) return
  if (isPage) {
    // a paragraph comes to the top; the linked pages are the last item; item 0 is the page's heading
    const paras = r.page ? paragraphs(r.page.body).length : 0
    // `k` on the first paragraph scrolls up to the page's heading, as `g` does
    const top = step === 'start' || (step === -1 && c.page === 0) ? 0 : key.startsWith('para-') ? 1 + Number(key.slice(5)) : 1 + paras
    await update($, cursor, x => ({ ...x, page: next, pageTop: top }))
  } else {
    const row = Math.max(0, sessionRowStops.indexOf(key))
    await update($, cursor, x => {
      // `g` shows the very top, and `k` on the first page name scrolls up to it: the counts sit above the names
      if (step === 'start' || (step === -1 && x.session === 0)) return { ...x, session: next, sessionTop: 0 }
      const top = row < x.sessionTop ? row : row >= x.sessionTop + paneRows ? row - paneRows + 1 : x.sessionTop
      return { ...x, session: next, sessionTop: top }
    })
  }
  scrollRest = 0
  // a link takes the focus ring, so Enter opens it; on a paragraph the page's tab chip holds it, where Enter changes nothing
  await $.ui.focus({ requestId: PANE, key: key.startsWith('para-') ? 'tab-page' : key }).catch(() => undefined)
}

/** The Session tab, with its numbers fresh. */
async function openSession($: EngineInterface, isDemo = false) {
  if (isDemo) await loadDemoSession($)
  else {
    await update($, demoSession, () => null)
    refreshCounts($)
    await refreshHealth($)
  }
  // `/iirc reader` starts fresh: the session tab, and no page tab left from before
  await update($, reader, () => ({ page: null, history: [], error: null, loading: null, tab: 'session' as const }))
  // the pane opens at its top, the counts first; j brings the first page name into view
  await update($, cursor, x => ({ ...x, session: 0, sessionTop: 0 }))
  const opened = await $.ui.open({ id: PANE, title: 'iirc reader', focus: true })
  // an unplaced pane never closes, so nothing else would drop the demo
  if (!opened.isPlaced) await update($, demoSession, () => null)
  // put the ring on the first page name when it shows, so Enter works at once; a short pane shows it after j
  const v = await sessionView($)
  const first = sessionStops(v.pages, v.counts, v.health)[0]
  if (first && sessionRowStops.indexOf(first) < paneRows) await $.ui.focus({ requestId: PANE, key: first }).catch(() => undefined)
}

/** Sample session numbers over this repository's real pages, for a screenshot: the names open as they would in a session. */
async function loadDemoSession($: EngineInterface) {
  let names: string[] = []
  try {
    const ran = await $.process.run(['ls', `${await $.session.root()}/.iirc`], { timeoutMs: 5000 })
    names = ran.stdout.split('\n').filter(n => n.endsWith('.md') && n !== 'index.md').slice(0, 12)
  } catch {}
  const used = names.slice(0, 6)
  const unread = names.slice(6, 10)
  const written = names.slice(10, 12)
  await update($, demoSession, () => ({
    pages: { read: used, written, suggested: [...used, ...unread], used, gone: [] },
    counts: {
      reads: used.length + 3, writes: written.length, suggested: used.length + unread.length, used: used.length,
      missed: unread.map((n, i) => [n, 4 - i] as [string, number]), match: DEMO_COUNTS.match, timeouts: DEMO_COUNTS.timeouts,
    },
    health: DEMO_HEALTH,
  }))
}

/** What the pane's session tab draws: the demo's sample session while it is open, else this session's. */
async function sessionView($: EngineInterface): Promise<SessionView> {
  return (await read($, demoSession)) ?? { pages: await read($, sessionPages), counts: await read($, counts), health: await read($, health) }
}

/** The card's TRUST, STORES, and SUGGESTED, NOT READ as plain lines, for where the card cannot draw. */
export function healthLines(checkup: IircHealth | null, c: SessionCounts): string[] {
  const lines: string[] = []
  if (checkup) {
    lines.push(checkup.suspect.length === 0 ? 'trust: no suspect pages' : `trust: ${checkup.suspect.length} suspect: ${checkup.suspect.slice(0, LIST_MAX).join(', ')}; fix with ${MAINTAIN}`)
    lines.push('stores: ' + checkup.stores.map(storeText).join('; ') + (checkup.stores.some(x => x.unpushed > 0) ? `; fix with ${MAINTAIN}` : ''))
  }
  if (c.match.all !== null) lines.push(`average match: ${matchText(c.match)}`)
  if (c.missed.length > 0) lines.push('suggested, not read: ' + c.missed.slice(0, LIST_MAX).map(([p, n]) => `${p} ×${n}`).join(', '))
  return lines
}

/** The session's average match, and the read and unread averages when both exist. */
export function matchText(m: MatchAverages): string {
  return `${m.all}%` + (m.read !== null && m.unread !== null ? ` · read ${m.read}% · not read ${m.unread}%` : '')
}

/** One store as the card says it: its pages, then clean or what it holds back. */
export function storeText(x: IircHealth['stores'][number]): string {
  const held = [x.uncommitted > 0 ? `${x.uncommitted} not committed` : '', x.unpushed > 0 ? `${x.unpushed} not pushed` : ''].filter(Boolean)
  return `${x.name} ${x.pages} ${x.pages === 1 ? 'page' : 'pages'}, ${held.length > 0 ? held.join(', ') : 'clean'}`
}

/** Ask iirc how many distinct pages this session has read and written, from its log. */
function refreshCounts($: EngineInterface) {
  // on a timer, so the run outlives this dispatch and no prompt or tool waits for it
  $.clock.after(0, () => void loadCounts($).catch(() => {}))
}

/** This session's counts and page lists from `iirc summarize-session-usage`, awaited. */
async function loadCounts($: EngineInterface) {
      if (!(await uiEnabled($))) return
      const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'summarize-session-usage', await $.session.id()], {
        cwd: await $.session.root(),
        timeoutMs: 15000,
      })
      if (ran.exitCode !== 0) return
      const got = JSON.parse(ran.stdout) as Record<string, unknown>
      const n = (key: string) => (Array.isArray(got[key]) ? (got[key] as unknown[]).length : 0)
      const missed = Array.isArray(got.missed) ? (got.missed as [string, number][]) : []
      const match = { ...NO_MATCH, ...(got.match as Partial<MatchAverages> | undefined) }
      const list = (key: string) => (Array.isArray(got[key]) ? (got[key] as string[]) : [])
      await update($, sessionPages, () => ({ read: list('read'), written: list('written'), suggested: list('suggested'), used: list('used'), gone: list('gone') }))
      const timeouts = typeof got.timeouts === 'number' ? got.timeouts : 0
      await update($, counts, () => ({ reads: n('read'), writes: n('written'), suggested: n('suggested'), used: n('used'), missed, match, timeouts }))
}

/** Ask iirc which pages are suspect and what each store holds back, for the card. */
async function refreshHealth($: EngineInterface) {
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'doctor', '--health'], { cwd: await $.session.root(), timeoutMs: 15000 })
    if (ran.exitCode === 0) await update($, health, () => JSON.parse(ran.stdout) as IircHealth)
  } catch {}   // the card leaves TRUST and STORES out
}

/** Ask iirc for the brief and show it. Without --hook, doctor --brief reads no stdin and pulls nothing. */
function refreshBrief($: EngineInterface) {
  // on a timer, so the run outlives this dispatch and no prompt or tool waits for it
  $.clock.after(0, () => {
    void (async () => {
      if (!(await uiEnabled($))) return
      const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'doctor', '--brief'], {
        cwd: await $.session.root(),
        timeoutMs: 15000,
      })
      if (ran.exitCode === 0) await showBrief($, ran.stdout)
    })().catch(() => {})
  })
}

/** Near the auto-compact threshold, ask iirc once for the line that asks the model to write what it learned. */
async function askCompactNudge($: EngineInterface) {
  if (await read($, compactAsked)) return
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown
  const limit = b?.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : context.window
  if (context.tokens === undefined || context.tokens < COMPACT_NEAR * limit) return
  await update($, compactAsked, () => true)
  const line = await iircLine($, ['remind-to-write', '--at', 'compaction'])
  if (line) await update($, compactNudge, () => line)
}

/** The waiting compaction nudge, once: the caller hands it to the model. */
async function takeCompactNudge($: EngineInterface): Promise<string | null> {
  const line = await read($, compactNudge)
  if (line === null) return null
  await update($, compactNudge, () => null)
  if (await uiEnabled($)) $.ui.toast('✎ iirc: context compaction is near; Claude was asked to write what it learned')
  return line
}

/** One line `bin/iirc` prints for the model, with this session on stdin as a hook payload; '' when it says nothing. */
async function iircLine($: EngineInterface, args: string[]): Promise<string> {
  const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, ...args], {
    cwd: await $.session.root(),
    stdin: JSON.stringify({ session_id: await $.session.id() }),
    timeoutMs: 10000,
  })
  return ran.exitCode === 0 ? ran.stdout.trim() : ''
}

export const register: Register = on => {
  // A resumed session stores its SessionStart line where neither session.append
  // nor $.session.messages() shows it, so ask iirc for the brief directly.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status(undefined)   // earlier versions drew the brief on the status line
    refreshBrief($)
    refreshCounts($)
    $.clock.after(0, () => void refreshHealth($))
    try {
      if ((await $.store.get('isStatusShown')) === false) await update($, isStatusShown, () => false)
    } catch {}   // the line stays on, the default
    return result
  })

  // A throw in iirc's own work must never reach the tool call: before next, the hook's .catch runs the call;
  // after it, the nudge's own .catch keeps the result
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) await update($, lastTool, () => e.tool_use_id)
    const result = await next(e)
    // keep the hint row's page count and read count current within the session
    if (e.tool === 'Bash') {
      if (CHANGES_BRIEF_RE.test(e.command)) refreshBrief($)
      if (COUNTS_RE.test(e.command)) refreshCounts($)
    }
    if (e.agentId === undefined && result.deny === undefined) {
      const line = await takeCompactNudge($).catch(() => null)
      if (line) return { ...result, context: [...(result.context ?? []), line] }
    }
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('prompt.submit', async ($, e, next) => {
    const line = await takeCompactNudge($)
    return next(line ? { ...e, context: [...(e.context ?? []), line] } : e)
  })

  // after each main-thread turn: is the context near the auto-compact threshold?
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) $.clock.after(0, () => void askCompactNudge($).catch(() => {}))
    return result
  })

  // the summary keeps what no page holds yet, so the session can write it after compaction;
  // a compaction that stands starts a new window for the nudge
  on('session.compact', async ($, e, next) => {
    const keep = await iircLine($, ['show-compaction-instructions']).catch(() => '')
    const result = await next(keep ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep } : e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) {
      await update($, compactAsked, () => false)
      await update($, compactNudge, () => null)
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.door === 'prompt') {
      await update($, lastPrompt, () => promptKey(e.uuid))
      return next(e)
    }
    if (e.door !== 'hook-context' || e.origin.kind !== 'hook') return next(e)
    const text = textOf(e.message.content)
    if (!text.includes('iirc: ') || !(await uiEnabled($))) return next(e)

    const event = e.origin.event
    if (event === 'UserPromptSubmit') {
      const pages = parseRecall(text)
      const prompt = await read($, lastPrompt)
      if (pages.length > 0 && prompt !== null) await update($, byPrompt, map => keepLast(map, prompt, pages))
      if (pages.length > 0) refreshCounts($)
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const tool = await read($, lastTool)
      const pages = parseRecall(text)
      const recovered = parseRecovered(text)
      if (pages.length > 0) refreshCounts($)
      if (tool !== null && (pages.length > 0 || recovered.length > 0)) {
        await update($, byTool, map => keepLast(map, tool, { pages, recovered }))
      }
    } else if (event === 'Stop') {
      const names = STOP_RE.exec(text)?.[1]
      if (names) $.ui.toast(`✎ iirc: ${names} failed and then worked; Claude was asked to write it up before stopping`)
    } else if (event === 'SessionStart') {
      await showBrief($, text)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // A plain `/iirc` or `/iirc status` shows the home card, `/iirc help` the commands,
  // `/iirc summary-line-visibility on|off` turns the hint-row line on or off, and
  // `/iirc max-suggested-pages N` sets how many pages recall suggests; every other /iirc goes to the skill.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'iirc' && e.command !== 'iirc:iirc') return next(e)
    // bare or `help`, it is help; the skill loads by itself when a task needs it
    if (!e.args.trim()) return { text: await helpText($, 'home') }
    if (e.args.trim() === 'status') return { text: await helpText($, 'status') }
    if (e.args.trim() === 'help') return { text: await helpText($, 'help') }
    const showArgs = SHOW_ARGS_RE.exec(e.args)
    if (showArgs) {
      const ref = showArgs[1] ?? ''
      const { page, error } = await showPage($, ref)
      // the card draws over this text; the text stands where the card cannot
      return { text: page ? `${String(page.fm.title ?? page.name)}\n${String(page.fm.summary ?? '')}\n\n${page.body.trim()}` : `iirc show ${ref}: ${error}` }
    }
    if (e.args.trim() === 'unfold-suggested-pages') {
      // unfold the latest suggested-pages row, the keyboard's way to what a click on [+] does
      const keys = Object.keys(await read($, byPrompt))
      const last = keys[keys.length - 1]
      if (!last) return { text: 'no suggested pages yet this session' }
      await update($, open, map => keepLast(map, last, true))
      return { text: 'the latest suggested pages are unfolded above' }
    }
    const readerArgs = READER_ARGS_RE.exec(e.args)
    if (readerArgs) {
      // `reader demo` fills the session tab with sample numbers over real pages, for screenshots
      const ref = readerArgs[1]
      await openSession($, ref === 'demo')
      if (!ref || ref === 'demo') return { text: 'iirc reader opened: this session\'s pages; a page name opens it in a page tab' }
      // a page: its tab over a fresh session tab, so h goes back to the session's pages
      await openPage($, ref)
      return { text: `iirc reader opened on ${ref}` }
    }
    // the card with sample numbers, for a screenshot that shows the design rather than one session
    if (/^demo(\s+status)?$/.test(e.args.trim())) return { text: 'the /iirc card with sample numbers' }
    // the doctor card with sample checks; the text is doctor's lines, which the card parses as it parses doctor's
    if (DEMO_DOCTOR_RE.test(e.args.trim())) return { text: DEMO_DOCTOR }
    const direct = DIRECT_RE.exec(e.args.trim())
    if (direct) return { text: await runDirect($, direct[1]) }
    const maxArgs = MAX_SUGGESTED_ARGS_RE.exec(e.args)
    if (maxArgs) {
      // the recall hook runs in the CLI, so the CLI keeps the number, in the machine config
      const ran = await $.process.run([`${$.plugin.root}/bin/iirc`, 'max-suggested-pages', ...(maxArgs[1] ? [maxArgs[1]] : [])], {
        cwd: await $.session.root(),
        timeoutMs: 15000,
      })
      return { text: (ran.stdout || ran.stderr).trim() }
    }
    const m = SUMMARY_LINE_ARGS_RE.exec(e.args)
    if (!m) return next(e)
    if (m[1]) {
      const isOn = m[1] === 'on'
      await $.store.set('isStatusShown', isOn)
      await update($, isStatusShown, () => isOn)
      return { text: `iirc summary-line-visibility ${m[1]}` }
    }
    return { text: `iirc summary-line-visibility is ${(await read($, isStatusShown)) ? 'on' : 'off'}; /iirc summary-line-visibility on|off changes it` }
  })

  // A plain /iirc draws its help as a panel in place of the text row.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const isIirc = e.props.command === 'iirc' || e.props.command === 'iirc:iirc'
    const args = e.props.args.trim()
    const shown = isIirc && !e.props.isErrored ? SHOW_ARGS_RE.exec(args) : null
    if (shown) {
      const pages = await read($, shownPages)
      const name = shown[1] ?? ''
      const page = pages[name] ?? pages[`${name}.md`]
      return page ? drawPageCard($, e, page) : next(e)
    }
    if (isIirc && !e.props.isErrored && (args === 'doctor' || args === 'doctor --fix' || DEMO_DOCTOR_RE.test(args))) {
      const report = parseDoctor(e.props.text)
      return report ? drawDoctor($, e, report, args === 'doctor --fix') : next(e)
    }
    if (!isIirc || !['', 'status', 'help', 'demo', 'demo status'].includes(args) || e.props.isErrored) return next(e)
    const view: CardView = args === 'help' ? 'help' : args.endsWith('status') ? 'status' : 'home'
    if (args.startsWith('demo')) return drawHelp($, e, view, DEMO_STATUS, DEMO_COUNTS, true, 3, DEMO_HEALTH)
    return drawHelp($, e, view, await read($, status), await read($, counts), await read($, isStatusShown), await read($, maxSuggested), await read($, health))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = await read($, reader)
    const c = await read($, cursor)
    const { Box, Text } = $.ui.resolve(e)
    // and one row spare: a single row too many and Claude Code scrolls the window to the focus, taking the header with it
    paneRows = Math.max(1, e.props.scroll.bodyRows - HEADER_ROWS - 1)
    const isPage = r.tab === 'page' && r.page !== null && !(r.loading && r.page.label !== r.loading)
    let items: unknown[]
    let top: number
    if (isPage && r.page) {
      const page = pageItems($, e, r, c.page, e.props.bodyColumns)
      pageHeights = page.heights
      items = page.items
      top = Math.min(c.pageTop, Math.max(0, items.length - 1))
    } else if (r.tab === 'page') {
      items = [drawReaderNote($, e, r)]
      top = 0
    } else {
      const v = await sessionView($)
      const session = sessionItems($, e, v.pages, v.counts, v.health, c.session)
      sessionRowStops = session.map(x => x.stop)
      items = session.map(x => x.el)
      top = Math.min(c.sessionTop, Math.max(0, items.length - paneRows))
    }
    // only what fits under the header is drawn: a tree taller than the window lets Claude Code scroll it
    // itself to keep the focus ring in view, and that scroll takes the header with it
    let end = items.length
    if (isPage) {
      let used = 0
      end = top
      while (end < items.length && (end === top || used + (pageHeights[end] ?? 1) <= paneRows)) used += pageHeights[end++] ?? 1
    } else if (r.tab !== 'page') {
      end = Math.min(items.length, top + paneRows)
    }
    return (
      <Box flexDirection="column">
        {drawTabs($, e, r, e.props.bodyColumns, e.viewport?.columns, `${e.props.scroll.bodyRows}${e.viewport ? `/${e.viewport.rows}` : ''}`, e.props.isFocused)}
        <Text color="subtle">{top > 0 ? `  ↑ ${top} above` : ' '}</Text>
        {items.slice(top, end) as never}
      </Box>
    )
  })
  // the wheel and the scroll keys move the content under the header, not the window
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const r = await read($, reader)
    if (r.tab === 'page' && r.page) {
      scrollRest += e.by
      await update($, cursor, x => {
        let top = x.pageTop
        while (scrollRest > 0 && top < pageHeights.length - 1 && scrollRest >= (pageHeights[top] ?? 1)) scrollRest -= pageHeights[top++] ?? 1
        while (scrollRest < 0 && top > 0 && -scrollRest >= (pageHeights[top - 1] ?? 1)) scrollRest += pageHeights[--top] ?? 1
        return { ...x, pageTop: top }
      })
    } else {
      await update($, cursor, x => ({ ...x, sessionTop: Math.max(0, Math.min(Math.max(0, sessionRowStops.length - paneRows), x.sessionTop + e.by)) }))
    }
    // the window itself stays at row 0, and goes back there if Claude Code moved it on its own to show the focus
    return next({ ...e, offset: 0 })
  })
  // a pane Claude Code closes resets the same way as q, which goes through closePane
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await resetReader($)
    return next(e)
  })

  // The brief under the prompt, beside the engine's hint: a status line takes no color.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, status)
    const original = await next(e)
    if (s === null || !(await read($, isStatusShown))) return original
    const c = await read($, counts)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {original}
        <Box flexDirection="row">
          <Text color={LEVEL_COLOR[liveStatus(s, c).level]}>● </Text>
          <Text color="subtle">{statusText(s, c)}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const key = promptKey(e.requestId)
    const pages = (await read($, byPrompt))[key]
    if (!pages || pages.length === 0) return next(e)
    const original = await next(e)
    const isOpen = (await read($, open))[key] === true
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {original}
        {drawPages($, e, key, pages, isOpen, 'suggested')}
      </Box>
    )
  })

  // A tool call draws as its own ToolUse row, or folded into a ToolGroup line
  // ("Ran 3 shell commands"). Draw under whichever the person sees; an
  // expanded group's calls are ToolUse rows of their own.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const note = (await read($, byTool))[e.requestId]
    if (!note) return next(e)
    const original = await next(e)
    const opened = await read($, open)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {original}
        {drawNote($, e, e.requestId, note, opened[e.requestId] === true)}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const notes = await read($, byTool)
    const ids = e.props.calls.map(c => c.tool_use_id).filter((id): id is string => !!id && !!notes[id])
    if (ids.length === 0) return next(e)
    const original = await next(e)
    const opened = await read($, open)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {original}
        {ids.map(id => drawNote($, e, id, notes[id], opened[id] === true))}
      </Box>
    )
  })

}

/** The gauge color at position t, 0 to 1: red to amber to green. */
function gaugeColor(t: number): string {
  return t < 0.5 ? mix(GAUGE[0], GAUGE[1], t * 2) : mix(GAUGE[1], GAUGE[2], (t - 0.5) * 2)
}

/** The color a fraction t of the way from hex color a to hex color b. */
function mix(a: string, b: string, t: number): string {
  const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [hex(a), hex(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/** A plain /iirc draws the home card: status and counts. /iirc help draws the settings and every command. */
// The cards align to the start, so each is only as wide as its longest line; the terminal still caps it.
function drawHelp($: EngineInterface, e: ResolveInput, view: CardView, s: IircStatus | null, c: SessionCounts, isShown: boolean, max: number | null, checkup: IircHealth | null) {
  const { Box, Text } = $.ui.resolve(e)
  if (s) s = liveStatus(s, c)
  // the brief is as old as the session start; maintenance the CLI finds due since then turns the chip yellow
  const isHealthWarn = !!checkup && (checkup.due ?? []).length > 0
  if (s && s.level === 'ok' && isHealthWarn) s = { ...s, level: 'warn', fix: MAINTAIN }
  const level = s ? s.level : 'warn'
  const tone = LEVEL_COLOR[level]
  // flat arrays of elements: a fragment inside a row lays out as a column on the terminal
  const head: unknown[] = [
    <Text key="dot" color={tone}>● </Text>,
    <Text key="name" bold color="claude">iirc</Text>,
    <Text key="gap">{'   '}</Text>,
  ]
  // "If I Recall Correctly", each initial lit, then what the plugin does
  // spaces lead each word: a Text's trailing space is not drawn
  for (const [k, word] of ['If', 'I', 'Recall', 'Correctly'].entries()) {
    head.push(<Text key={`i${k}`} bold color="claude">{(k > 0 ? ' ' : '') + word[0]}</Text>)
    if (word.length > 1) head.push(<Text key={`w${k}`} bold color={TITLE}>{word.slice(1)}</Text>)
  }

  const chipText = level === 'ok' ? '✔ all good' : level === 'warn' ? '▲ needs a look' : `✖ ${s ? s.note : 'no brief yet'}`
  // a section title: an orange bar and the text in the tagline's violet, each in a box that will not shrink,
  // or the text wraps under the bar
  const heading = (text: string) => (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}><Text color={TAGLINE_FROM}>▍</Text></Box>
      <Box flexShrink={0} marginLeft={1}><Text bold color={HEADING}>{text}</Text></Box>
    </Box>
  )
  const statusRow: unknown[] = [
    <Box key="label" width={12} flexShrink={0}>{heading('STATUS')}</Box>,
    <Text key="chip" bold color="#0d1117" backgroundColor={tone}>{` ${chipText} `}</Text>,
  ]
  if (s && level !== 'ok' && s.fix) {
    statusRow.push(<Text key="fixlead" color="subtle">{'   fix with '}</Text>, <Text key="fix" bold color="claude">{s.fix}</Text>)
  }
  if (s && s.mode && s.mode !== 'semantic+keyword') statusRow.push(<Text key="mode" color={LEVEL_COLOR.warn}>{`   ${s.mode} mode`}</Text>)
  const tiles: [string, string][] = s && s.pages !== null
    ? [[String(s.pages), s.pages === 1 ? 'page' : 'pages'], [`${c.used}/${c.suggested}`, 'used'], [String(c.reads), 'reads'], [String(c.writes), 'writes']]
    : []
  const share = c.suggested > 0 ? c.used / c.suggested : 0
  const filled = Math.round(share * BAR)
  const pct = Math.round(share * 100)
  const band = pct >= 50 ? GAUGE[2] : pct >= 25 ? GAUGE[1] : GAUGE[0]
  // each cell takes the gradient color of its position, so a fuller bar runs from red into green
  const cells = Array.from({ length: BAR }, (_, k) =>
    k < filled ? <Text key={k} color={gaugeColor(k / (BAR - 1))}>█</Text> : <Text key={k} color="inactive">░</Text>,
  )
  // command first, in the same column as the MAINTENANCE and LOOK UP rows
  const setting = (label: string, value: string, command: string) => (
    <Box key={label} flexDirection="row" paddingLeft={2}>
      <Box width={CMD_COL} flexShrink={0}><Text color="suggestion">{command}</Text></Box>
      <Box width={24} flexShrink={0}><Text color="subtle">{label}</Text></Box>
      <Text bold color="claude">{value}</Text>
    </Box>
  )
  const command = (cmd: string, what: string) => (
    <Box key={cmd} flexDirection="row" paddingLeft={2}>
      <Box width={CMD_COL} flexShrink={0}><Text color="suggestion">{cmd}</Text></Box>
      <Text color="subtle">{what}</Text>
    </Box>
  )
  // TRUST and STORES: a mark, the fact, and the command that clears it, under a 12-column label like STATUS
  const fact = (key: string, label: string, isOk: boolean, pieces: RenderChildren[], fix?: string) => (
    <Box key={key} flexDirection="row">
      <Box width={12} flexShrink={0}>{label ? heading(label) : <Text> </Text>}</Box>
      <Text color={isOk ? LEVEL_COLOR.ok : LEVEL_COLOR.warn}>{isOk ? '✔ ' : '▲ '}</Text>
      {pieces}
      {fix && <Text color="subtle">{'   fix with '}</Text>}
      {fix && <Text bold color="claude">{fix}</Text>}
    </Box>
  )
  const trustRows: RenderChildren[] = []
  const storeRows: RenderChildren[] = []
  const widthOf = (text: string, fix?: string) => 12 + 2 + text.length + (fix ? '   fix with '.length + fix.length : 0)
  const factWidths: number[] = []
  if (checkup) {
    const n = checkup.suspect.length
    const text = n === 0 ? 'no suspect pages' : `${n} suspect ${n === 1 ? 'page' : 'pages'}: a cited file changed`
    trustRows.push(fact('trust', 'TRUST', n === 0, [<Text key="t" color="subtle">{text}</Text>], n > 0 ? MAINTAIN : undefined))
    factWidths.push(widthOf(text, n > 0 ? MAINTAIN : undefined))
    for (const name of checkup.suspect.slice(0, LIST_MAX)) {
      trustRows.push(
        <Box key={`s${name}`} flexDirection="row" paddingLeft={14}>
          {/* the bullet in a column that will not shrink, so a long name wraps and nothing else moves */}
          <Box width={2} flexShrink={0}><Text color="claude">›</Text></Box>
          <Box flexShrink={1}>{pageLink($, e, `card-s-${name}`, name, { color: 'claude' })}</Box>
        </Box>,
      )
      factWidths.push(14 + 2 + name.replace(/\.md$/, '').length)   // a link draws the name without .md
    }
    checkup.stores.forEach((x, k) => {
      const isOk = x.uncommitted === 0 && x.unpushed === 0
      const rest = storeText(x).slice(x.name.length)
      const fix = x.unpushed > 0 ? MAINTAIN : undefined
      storeRows.push(fact(`st${k}`, k === 0 ? 'STORES' : '', isOk, [
        <Text key="n" bold color="claude">{x.name}</Text>,
        <Text key="r" color="subtle">{rest}</Text>,
      ], fix))
      factWidths.push(widthOf(x.name + rest, fix))
    })
  }
  const missed = c.missed.slice(0, LIST_MAX)
  const helpBody = (
    <Box flexDirection="column">
      <Text> </Text>
      {heading('SETTINGS')}
      {setting('summary line, on|off', isShown ? 'on' : 'off', SET_LINE)}
      {setting('suggested pages', max === null ? '?' : `up to ${max}`, SET_MAX)}
      {setting('search', s?.mode ?? '?', SET_SEARCH)}
      {(['MAINTENANCE', 'LOOK UP'] as const).map(group => (
        <Box key={group} flexDirection="column">
          <Text> </Text>
          {heading(group)}
          {COMMANDS.filter(([, , g]) => g === group).map(([cmd, what]) => command(`/iirc ${cmd}`, what))}
          {group === 'LOOK UP' && command(REQUEST_CMD, REQUEST_HINT)}
        </Box>
      ))}
    </Box>
  )
  const blank = (key: string) => <Text key={key}> </Text>
  // a pointer to another view: its title and command on one row, what it holds under it
  const pointer = (key: string, title: string, cmd: string, hint: string, color?: string) => [
    <Box key={key} flexDirection="row">
      <Box width={16} flexShrink={0}>{heading(title)}</Box>
      <Text color="suggestion">{cmd}</Text>
    </Box>,
    <Box key={`${key}-hint`} flexDirection="row" paddingLeft={2}>
      <Text color="claude">{'› '}</Text>
      <Text dimColor={!color} color={color} italic>{hint}</Text>
    </Box>,
  ]
  const ask = [
    <Box key="ask" flexDirection="row">
      <Box width={16} flexShrink={0}>{heading('ASK IN WORDS')}</Box>
      <Text color="suggestion">/iirc &lt;request&gt;</Text>
    </Box>,
    ...EXAMPLES.map(example => (
      <Box key={example} flexDirection="row" paddingLeft={2}>
        <Text color="claude">{'› '}</Text>
        <Text dimColor italic>{example}</Text>
      </Box>
    )),
  ]
  const gauge = c.suggested > 0 ? [
    <Box key="gauge-title" flexDirection="row" width={GAUGE_W}>
      <Box flexGrow={1}>{heading(GAUGE_TITLE)}</Box>
      <Text bold color={band}>{`${pct}%`}</Text>
    </Box>,
    <Box key="gauge-bar" flexDirection="row" paddingLeft={2}>{cells}</Box>,
    <Box key="gauge-count" flexDirection="row" paddingLeft={2}>
      <Text bold color="claude">{String(c.used)}</Text>
      <Text color="subtle">{' of '}</Text>
      <Text bold color="claude">{String(c.suggested)}</Text>
      <Text color="subtle">{' suggested pages were read'}</Text>
    </Box>,
    ...(c.match.all !== null ? [
      <Box key="gauge-match" flexDirection="row" paddingLeft={2}>
        <Text color="subtle">{'average match '}</Text>
        <Text bold color="claude">{`${c.match.all}%`}</Text>
        {c.match.read !== null && c.match.unread !== null && <Text color="subtle">{' · read '}</Text>}
        {c.match.read !== null && c.match.unread !== null && <Text bold color="claude">{`${c.match.read}%`}</Text>}
        {c.match.read !== null && c.match.unread !== null && <Text color="subtle">{' · not read '}</Text>}
        {c.match.read !== null && c.match.unread !== null && <Text bold color="claude">{`${c.match.unread}%`}</Text>}
      </Box>,
    ] : []),
  ] : []
  const tile = (n: string, label: string) => (
    <Box key={label} flexDirection="column" flexShrink={0}>
      <Text bold color="claude">{n}</Text>
      <Text color="subtle">{label}</Text>
    </Box>
  )
  // the pointer to /iirc status says when there is something to look at there
  const statusHint = level === 'ok' ? STATUS_HINT : `▲ needs a look: ${STATUS_HINT}`
  // The card is as wide as its widest row, measured here, so the title rule can span it exactly:
  // a row of Text cannot stretch to fill a box. Every glyph used is one column wide.
  const widths = [9 + 'If I Recall Correctly'.length, 9 + TAGLINE.length]
  if (view === 'home') {
    widths.push(16 + REQUEST_CMD.length, ...EXAMPLES.map(x => 4 + x.length))
    widths.push(16 + '/iirc help'.length, 4 + MORE_HINT.length)
    widths.push(16 + '/iirc status'.length, 4 + statusHint.length)
    if (s && s.pages !== null) widths.push(2 + 'STORE'.length, 2 + String(s.pages).length, 2 + 'pages'.length)
    if (c.suggested > 0) widths.push(GAUGE_W, 2 + `${c.used} of ${c.suggested} suggested pages were read`.length, c.match.all !== null ? 2 + 'average match '.length + matchText(c.match).length : 0)
  } else if (view === 'status') {
    const fixWidth = s && level !== 'ok' && s.fix ? '   fix with '.length + s.fix.length : 0
    const modeWidth = s && s.mode && s.mode !== 'semantic+keyword' ? `   ${s.mode} mode`.length : 0
    widths.push(12 + chipText.length + 2 + fixWidth + modeWidth)
    if (tiles.length > 0) {
      const [n, label] = tiles[tiles.length - 1]
      widths.push(15 + 2 + 'THIS SESSION'.length, 2 + 13 * (tiles.length - 1) + Math.max(n.length, label.length))
    }
    if (c.suggested > 0) widths.push(GAUGE_W, 2 + `${c.used} of ${c.suggested} suggested pages were read`.length, c.match.all !== null ? 2 + 'average match '.length + matchText(c.match).length : 0)
    widths.push(...factWidths)
    if (missed.length > 0) widths.push(2 + 'SUGGESTED, NOT READ'.length, ...missed.map(([name]) => 2 + 5 + name.replace(/\.md$/, '').length))
  } else {
    widths.push(2 + CMD_COL + 24 + Math.max(2, `up to ${max ?? '?'}`.length, (s?.mode ?? '?').length))
    widths.push(...COMMANDS.map(([, what]) => 2 + CMD_COL + what.length), 2 + CMD_COL + REQUEST_HINT.length)
  }
  // as wide as the widest row, but never wider than the terminal: past that, rows wrap inside the frame
  const room = (e as { viewport?: { columns: number } }).viewport?.columns
  const inner = Math.min(Math.max(...widths), room ? room - 4 : Infinity)
  // home: how to ask, where the rest is, and the two numbers worth a glance
  const homeBody = (
    <Box flexDirection="column">
      {blank('b1')}
      {ask}
      {blank('b2')}
      {pointer('more', 'MORE COMMANDS', '/iirc help', MORE_HINT)}
      {blank('b3')}
      {pointer('full', 'FULL STATUS', '/iirc status', statusHint, level === 'ok' ? undefined : LEVEL_COLOR[level])}
      {gauge.length > 0 && blank('b4')}
      {gauge}
      {s && s.pages !== null && blank('b5')}
      {s && s.pages !== null && heading('STORE')}
      {s && s.pages !== null && <Box flexDirection="row" paddingLeft={2}>{tile(String(s.pages), s.pages === 1 ? 'page' : 'pages')}</Box>}
    </Box>
  )
  // status: every number the card knows
  const statusBody = (
    <Box flexDirection="column">
      {blank('s1')}
      <Box flexDirection="row">{statusRow}</Box>
      {trustRows}
      {storeRows}
      {tiles.length > 0 && blank('s2')}
      {/* pages counts the store; the other tiles and the hit rate count this session */}
      {tiles.length > 0 && (
        <Box flexDirection="row">
          <Box width={15} flexShrink={0}>{heading('STORE')}</Box>
          {heading('THIS SESSION')}
        </Box>
      )}
      {tiles.length > 0 && (
        <Box flexDirection="row" paddingLeft={2}>
          {/* the last tile takes only its own width, so it adds no space before the right border */}
          {tiles.map(([n, label], k) => (
            <Box key={label} flexDirection="column" width={k < tiles.length - 1 ? 13 : undefined} flexShrink={0}>
              <Text bold color="claude">{n}</Text>
              <Text color="subtle">{label}</Text>
            </Box>
          ))}
        </Box>
      )}
      {gauge.length > 0 && blank('s3')}
      {gauge}
      {/* recall's noise: pages it kept suggesting that nobody read, most often first */}
      {missed.length > 0 && blank('s4')}
      {missed.length > 0 && heading('SUGGESTED, NOT READ')}
      {missed.map(([name, n]) => (
        <Box key={`m${name}`} flexDirection="row" paddingLeft={2}>
          {/* the count first, in a column that will not shrink: a row too wide for the card wraps only the name */}
          <Box width={5} flexShrink={0}><Text bold color={LEVEL_COLOR.warn}>{`×${n}`}</Text></Box>
          <Box flexShrink={1}>{pageLink($, e, `card-m-${name}`, name, { color: 'claude' })}</Box>
        </Box>
      ))}
    </Box>
  )
  return (
    <Box key="card" flexDirection="column" borderStyle="round" borderColor={FRAME} paddingX={1} alignSelf="flex-start" width={inner + 4}>
      {/* two lines: one row this wide would shrink every piece and wrap each word */}
      <Box flexDirection="row">{head}</Box>
      <Box flexDirection="row" paddingLeft={9}>
        {/* one Text per character, each a step along the gradient; cut to the card, or the row drops letters to fit */}
        {[...fitTo(TAGLINE, inner - 9)].map((ch, k) => (
          <Text key={k} italic color={mix(TAGLINE_FROM, TAGLINE_TO, k / (TAGLINE.length - 1))}>{ch}</Text>
        ))}
      </Box>
      {/* a rule under the title, orange to violet, as long as the tagline line */}
      <Box flexDirection="row">
        {Array.from({ length: inner }, (_, k) => (
          <Text key={k} color={mix(TAGLINE_FROM, TAGLINE_TO, k / (inner - 1))}>━</Text>
        ))}
      </Box>
      {view === 'help' && helpBody}
      {view === 'home' && homeBody}
      {view === 'status' && statusBody}
    </Box>
  )
}

export type DoctorReport = { ok: string[]; failed: { label: string; fix: string }[]; notes: string[]; info: string[] }

/** Doctor's lines, `ok  label`, `FAIL label  (fix)`, `note text`, and indented info; null when none parse. */
export function parseDoctor(text: string): DoctorReport | null {
  const r: DoctorReport = { ok: [], failed: [], notes: [], info: [] }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^iirc: /, '')
    if (/^iirc .* exited \d+:$/.test(line.trim())) continue
    if (/^Run `iirc doctor --fix`/.test(line.trim())) continue   // the card says this itself
    let m
    if ((m = /^ok\s+(.*)$/.exec(line))) r.ok.push(m[1].trim())
    else if ((m = /^FAIL\s+(.*?)(?:\s{2}\((.*)\))?$/.exec(line))) r.failed.push({ label: m[1].trim(), fix: (m[2] ?? '').trim() })
    else if ((m = /^note\s+(.*)$/.exec(line))) r.notes.push(m[1].trim())
    else if (line.trim()) r.info.push(line.trim())
  }
  return r.ok.length + r.failed.length + r.notes.length > 0 ? r : null
}

function drawDoctor($: EngineInterface, e: ResolveInput, r: DoctorReport, isFix: boolean) {
  const { Box, Text } = $.ui.resolve(e)
  const level = r.failed.length > 0 ? 'error' : r.notes.length > 0 ? 'warn' : 'ok'
  const tone = LEVEL_COLOR[level]
  const total = r.ok.length + r.failed.length
  const chipLabel = level === 'error'
    ? `✖ ${r.failed.length} of ${total} failed`
    : level === 'warn'
      ? `▲ ${r.ok.length} pass, ${r.notes.length} ${r.notes.length === 1 ? 'note' : 'notes'}`
      : `✔ all ${total} checks pass`
  // a section title: an orange bar and the text in the tagline's violet, each in a box that will not shrink,
  // or the text wraps under the bar
  const heading = (text: string) => (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}><Text color={TAGLINE_FROM}>▍</Text></Box>
      <Box flexShrink={0} marginLeft={1}><Text bold color={HEADING}>{text}</Text></Box>
    </Box>
  )
  const row = (key: string, mark: string, color: string, text: string, dim = false) => (
    <Box key={key} flexDirection="row" paddingLeft={2}>
      <Box width={3} flexShrink={0}><Text color={color}>{mark}</Text></Box>
      <Text color={dim ? 'subtle' : undefined}>{text}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={FRAME} paddingX={1} alignSelf="flex-start">
      <Box flexDirection="row">
        <Text color={tone}>● </Text>
        <Text bold color="claude">iirc</Text>
        <Text color="subtle">{isFix ? '   doctor --fix' : '   doctor'}</Text>
      </Box>
      <Text> </Text>
      <Box flexDirection="row">
        <Box width={12} flexShrink={0}>{heading('RESULT')}</Box>
        <Text bold color="#0d1117" backgroundColor={tone}>{` ${chipLabel} `}</Text>
      </Box>
      {r.failed.length > 0 && <Text> </Text>}
      {r.failed.length > 0 && heading('FAILED')}
      {r.failed.map((f, k) => (
        <Box key={`f${k}`} flexDirection="column">
          {row(`fl${k}`, '✖', LEVEL_COLOR.error, f.label)}
          {f.fix && (
            <Box flexDirection="row" paddingLeft={5}>
              <Text color="subtle">{'fix: '}</Text>
              <Text color="claude">{f.fix}</Text>
            </Box>
          )}
        </Box>
      ))}
      {r.notes.length > 0 && <Text> </Text>}
      {r.notes.length > 0 && heading('NOTES')}
      {r.notes.map((n, k) => row(`n${k}`, '▲', LEVEL_COLOR.warn, n))}
      {r.ok.length > 0 && <Text> </Text>}
      {r.ok.length > 0 && heading('PASSED')}
      {r.ok.map((o, k) => row(`o${k}`, '✔', LEVEL_COLOR.ok, o, true))}
      {r.info.length > 0 && <Text> </Text>}
      {r.info.map((i, k) => (
        <Box key={`i${k}`} paddingLeft={2}><Text dimColor italic>{i}</Text></Box>
      ))}
      {r.failed.length > 0 && !isFix && <Text> </Text>}
      {r.failed.length > 0 && !isFix && (
        <Box flexDirection="row">
          <Text color="subtle">{'run '}</Text>
          <Text color="suggestion">/iirc doctor --fix</Text>
          <Text color="subtle">{' to repair what it can'}</Text>
        </Box>
      )}
    </Box>
  )
}

/** A section title as the cards draw it: an orange bar and the text in violet, each in a box that will not shrink. */
function sectionTitle($: EngineInterface, e: ResolveInput, text: string) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={`title-${text}`} flexDirection="row" flexShrink={0}>
      <Box flexShrink={0}><Text color={TAGLINE_FROM}>▍</Text></Box>
      <Box flexShrink={0} marginLeft={1}><Text bold color={HEADING}>{text}</Text></Box>
    </Box>
  )
}

/** A page name that opens the page in the reader tab. */
function pageLink($: EngineInterface, e: ResolveInput, key: string, name: string, style: Piece['style'] = { bold: true, color: 'claude' }) {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key={key} plain onPress={() => void openPage($, name)}>
      <Text {...style}>{name.replace(/\.md$/, '')}</Text>
    </Button>
  )
}

/** How long ago an ISO time was, in the largest whole unit. */
export function ageText(iso: unknown, now = Date.now()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return 'unknown'
  const days = Math.floor((now - t) / 86400000)
  return days < 1 ? 'today' : days === 1 ? '1 day ago' : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`
}

/** A gradient rule, orange to violet, as the cards draw under their title. */
function gradientRule($: EngineInterface, e: ResolveInput, width: number, key = 'rule') {
  const { Box, Text } = $.ui.resolve(e)
  const n = Math.max(1, width)
  return (
    <Box key={key} flexDirection="row">
      {Array.from({ length: n }, (_, k) => <Text key={`r${k}`} color={mix(TAGLINE_FROM, TAGLINE_TO, n > 1 ? k / (n - 1) : 0)}>━</Text>)}
    </Box>
  )
}

/** A filled chip, as the card's STATUS: dark text on a color. */
function chip($: EngineInterface, e: ResolveInput, key: string, text: string, color: string) {
  const { Text } = $.ui.resolve(e)
  return <Text key={key} bold color="#0d1117" backgroundColor={color}>{` ${text} `}</Text>
}

// a kind's chip color: decisions violet, findings blue, procedures green, environment facts amber
const KIND_COLOR: Record<string, string> = { decision: '#a78bfa', finding: '#6cb6ff', procedure: '#57ab5a', environment: '#d4a72c' }

// the keys row: key, label, the glyph a narrow pane shows instead, what it does
const KEYS: [string, string, string, 'down' | 'up' | 'top' | 'end' | 'session' | 'page' | 'closeTab' | 'close'][] = [
  ['h', '◂', '◂', 'session'], ['j', '↓', '↓', 'down'], ['k', '↑', '↑', 'up'], ['l', '▸', '▸', 'page'],
  ['g', 'top', '⤒', 'top'], ['e', 'end', '⤓', 'end'], ['x', 'close tab', '✕', 'closeTab'], ['q', 'close', '⏏', 'close'],
]

/** The keys row's columns with labels: each `k: label` and two spaces after. Narrower panes show glyphs alone. */
function keysWidth(keys: typeof KEYS): number {
  return keys.reduce((n, [k, label]) => n + k.length + 2 + label.length + 2, 0)
}

/** What a key of the keys row does. */
function runKey($: EngineInterface, act: (typeof KEYS)[number][3]) {
  if (act === 'down') return moveCursor($, 1)
  if (act === 'up') return moveCursor($, -1)
  if (act === 'top') return moveCursor($, 'start')
  if (act === 'end') return moveCursor($, 'end')
  if (act === 'session') return update($, reader, x => ({ ...x, tab: 'session' as const }))
  if (act === 'page') return update($, reader, x => (x.page || x.loading ? { ...x, tab: 'page' as const } : x))
  if (act === 'closeTab') return update($, reader, () => ({ page: null, history: [], error: null, loading: null, tab: 'session' as const }))
  return closePane($)
}

/** Reset the reader and drop the demo, then close the pane: the plugin's own $.ui.close does not reach its ui.close hook. */
async function closePane($: EngineInterface) {
  await resetReader($)
  return $.ui.close({ id: PANE }).catch(() => undefined)
}

/** A closed reader starts at the Session tab next time, with no stale page, no way back, and no demo. */
async function resetReader($: EngineInterface) {
  await update($, reader, () => ({ page: null, history: [], error: null, loading: null, tab: 'session' as const }))
  await update($, demoSession, () => null)
}

/** The pane's fixed header: its tabs as chips with the iirc mark, the gradient rule, and the keys. */
function drawTabs($: EngineInterface, e: ResolveInput, r: Reader, columns: number, terminal?: number, rows?: string, isFocused = true) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const name = r.loading ?? r.page?.name
  const isPage = r.tab === 'page' && !!name
  // the shown tab is a filled chip; the other is plain, dim until the pointer or the focus is on it
  const tab = (key: string, hotkey: string, label: string, isOn: boolean, onPress: () => void) => (
    <Button key={key} plain hotkey={hotkey} onPress={onPress}>
      {isOn ? <Text bold color="#0d1117" backgroundColor={HEADING}>{` ${label} `}</Text> : <Text color="subtle">{` ${label} `}</Text>}
    </Button>
  )
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexDirection="row" flexGrow={1}>
          {tab('tab-session', '1', 'session', !isPage, () => void update($, reader, x => ({ ...x, tab: 'session' as const })))}
          {name && <Text>{' '}</Text>}
          {/* the page's tab takes the room the session tab, the close marks, and the iirc mark leave */}
          {name && tab('tab-page', '2', tabTitle(name, Math.max(8, columns - 36)), isPage, () => void update($, reader, x => ({ ...x, tab: 'page' as const })))}
        </Box>
        <Text>{' '}</Text>
        {/* the mark is green while the pane holds the keys, gray while they are the prompt's */}
        <Text color={isFocused ? LEVEL_COLOR.ok : 'inactive'}>● </Text>
        <Text bold color="claude">iirc</Text>
      </Box>
      {/* without the keys, the legend says how to get them: the keys do nothing until the pane has them */}
      {!isFocused && (
        <Box flexDirection="row">
          <Text color={LEVEL_COLOR.warn}>{'keys off '}</Text>
          <Text color="subtle" wrap="truncate-end">{'· click the reader, or ctrl+x tab'}</Text>
        </Box>
      )}
      {/* the vi keys on one line: each a Button, since a hotkey belongs to one; glyphs alone in a narrow pane */}
      {isFocused && <Box flexDirection="row">
        {/* x shows only while a page tab is open: there is nothing else to close */}
        {(() => {
          const keys = KEYS.filter(([, , , act]) => act !== 'closeTab' || !!name)
          const isWide = columns >= keysWidth(keys)
          return keys.map(([k, label, glyph, act]) => (
            <Box key={`vi-${k}`} flexShrink={0} marginRight={2}>
              <Button key={`key-${k}`} plain hotkey={k} onPress={() => void runKey($, act)}><Text color="subtle">{isWide ? label : glyph}</Text></Button>
            </Box>
          ))
        })()}
      </Box>}
      {/* the rule closes the header: the content starts below it */}
      {gradientRule($, e, columns)}
    </Box>
  )
}

/** The Session tab as rows of one line each, so the pane can start the list at any row: each with the page link it holds. */
function sessionItems($: EngineInterface, e: ResolveInput, sp: SessionPages, c: SessionCounts, checkup: IircHealth | null, at = 0) {
  const { Box, Text } = $.ui.resolve(e)
  const times = new Map(c.missed)
  const used = new Set(sp.used)
  const gone = new Set(sp.gone)
  // the vi cursor, drawn: the focus ring is the engine's and not every surface shows it
  const here = sessionStops(sp, c, checkup)[at]
  const out: { stop: string | null; el: unknown }[] = []
  const line = (key: string, el: unknown) => out.push({ stop: null, el: <Box key={key} flexDirection="row">{el as never}</Box> })
  const row = (key: string, mark: string, color: string, name: string, tail: string) => {
    const isGone = gone.has(name)
    out.push({
      stop: isGone ? null : `open-${key}`,
      el: (
        <Box key={key} flexDirection="row">
          {/* the cursor: a filled marker and the mark on an orange chip, unlike the inversion the pointer makes */}
          <Box width={2} flexShrink={0}><Text bold color={TAGLINE_FROM}>{here === `open-${key}` ? '▶' : ' '}</Text></Box>
          <Box width={3} flexShrink={0}>
            {here === `open-${key}`
              ? <Text bold color="#0d1117" backgroundColor={TAGLINE_FROM}>{` ${mark} `}</Text>
              : <Text bold color={color}>{mark}</Text>}
          </Box>
          {/* the times suggested, left of the name in a column that will not shrink, as on the status card */}
          <Box width={5} flexShrink={0}><Text bold color={LEVEL_COLOR.warn}>{isGone ? '' : tail.trim()}</Text></Box>
          {/* a page renamed or deleted since is no link: there is nothing to open */}
          <Box flexShrink={1}>{isGone ? <Text dimColor strikethrough>{name.replace(/\.md$/, '')}</Text> : pageLink($, e, `open-${key}`, name)}</Box>
          {isGone && <Text color="subtle">{'  renamed or deleted'}</Text>}
        </Box>
      ),
    })
  }
  const blank = (key: string) => line(key, <Text> </Text>)
  out.push({ stop: null, el: sectionTitle($, e, 'SUGGESTED') })
  line('legend', [
    <Text key="a" color={LEVEL_COLOR.ok}>{'  ✓ '}</Text>, <Text key="b" color="subtle">{'read   '}</Text>,
    <Text key="c" color="subtle">{'· '}</Text>, <Text key="d" color="subtle">{'not read   '}</Text>,
    <Text key="e" bold color={LEVEL_COLOR.warn}>{'×N'}</Text>, <Text key="f" color="subtle">{' times suggested'}</Text>,
  ])
  const suggested = sortSuggested(sp, c)
  if (suggested.length === 0) line('none', <Box paddingLeft={2}><Text dimColor>nothing yet</Text></Box>)
  for (const name of suggested) {
    if (used.has(name)) row(`s-${name}`, '✓', LEVEL_COLOR.ok, name, '')
    else row(`s-${name}`, '·', 'subtle', name, times.get(name) ? ` ×${times.get(name)}` : '')
  }
  if (sp.written.length > 0) {
    blank('b2')
    out.push({ stop: null, el: sectionTitle($, e, 'WRITTEN') })
    for (const name of sp.written) row(`w-${name}`, '✎', LEVEL_COLOR.warn, name, '')
  }
  if (checkup && checkup.suspect.length > 0) {
    blank('b3')
    out.push({ stop: null, el: sectionTitle($, e, 'SUSPECT') })
    for (const name of checkup.suspect) row(`x-${name}`, '▲', LEVEL_COLOR.warn, name, '')
  }
  return out
}

/** The page tab while it has no page to show: loading, an error, or how to open one. */
function drawReaderNote($: EngineInterface, e: ResolveInput, r: Reader) {
  const { Text } = $.ui.resolve(e)
  if (r.loading) return <Text key="note" color="subtle">{`reading ${r.loading}…`}</Text>
  return <Text key="note" color={r.error ? 'error' : 'subtle'}>{r.error ?? 'A page name in the session tab, the suggested pages, or a card opens the page here.'}</Text>
}

/** A page as a card in the transcript: the reader tab's drawing, whole, in the cards' frame. */
function drawPageCard($: EngineInterface, e: ResolveInput, page: ShownPage) {
  const { Box, Text } = $.ui.resolve(e)
  const columns = (e as { viewport?: { columns: number } }).viewport?.columns ?? 80
  const { items } = pageItems($, e, { page, history: [], error: null, loading: null, tab: 'page' }, -1, columns - 4, 'card-')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={FRAME} paddingX={1}>
      <Box flexDirection="row">
        <Text color={LEVEL_COLOR.ok}>● </Text>
        <Text bold color="claude">iirc</Text>
        <Text color="subtle">{`   ${page.label}`}</Text>
      </Box>
      {gradientRule($, e, Math.min(columns - 4, 60), 'card-rule')}
      <Text> </Text>
      {items as never}
    </Box>
  )
}

/** Rows a text takes at a width, wrapped by word: an estimate for scrolling, not for drawing. */
function rowsAt(text: string, width: number): number {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(10, width))), 0)
}

/** The page tab as items the pane can start at: the heading, each paragraph, then the links; with each item's height. */
function pageItems($: EngineInterface, e: ResolveInput, r: Reader, at: number, columns: number, keyPrefix = '') {
  const { Box, Button, Markdown, Text } = $.ui.resolve(e)
  const page = r.page as ShownPage
  const fm = page.fm
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
  const topics = Array.isArray(fm.topics) ? fm.topics.map(String).join(', ') : str(fm.topics)
  const verified = fm.verified ? `verified ${ageText(fm.verified)}` : 'never verified'
  const meta = `${page.label} · updated ${ageText(fm.updated)} · ${verified}`
  const items: unknown[] = []
  const heights: number[] = []
  const kind = str(fm.kind) || 'page'
  const suspect = page.signals.find(sig => sig.level === 'suspect')
  const trust = suspect ? chip($, e, 'trust', '▲ suspect', LEVEL_COLOR.warn) : chip($, e, 'trust', '✔ trusted', LEVEL_COLOR.ok)
  items.push(
    <Box key="head" flexDirection="column" marginBottom={1}>
      {r.history.length > 0 && (
        <Box flexDirection="row" marginBottom={1}>
          <Button key="back" plain hotkey="b" onPress={() => void goBack($)}><Text color="subtle">{'← back'}</Text></Button>
        </Box>
      )}
      <Text bold color={TITLE}>{str(fm.title) || page.name}</Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        {chip($, e, 'kind', kind, KIND_COLOR[kind] ?? HEADING)}
        <Text>{' '}</Text>
        {trust}
      </Box>
      <Text color="subtle">{meta}</Text>
      {r.error && <Text color="error">{r.error}</Text>}
      {page.signals.map(sig => (
        <Text key={`sig-${sig.signal}`} color={sig.level === 'suspect' ? LEVEL_COLOR.warn : 'subtle'}>{`${sig.level === 'suspect' ? '▲' : '·'} ${sig.level}: ${sig.reason}`}</Text>
      ))}
      {/* the summary set off as a quote, the cards' orange bar beside it */}
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}><Text color={TAGLINE_FROM}>▍</Text></Box>
        <Text italic color="suggestion">{str(fm.summary)}</Text>
      </Box>
      {topics && (
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          {topics.split(', ').map(t => <Text key={`t-${t}`} color="claude">{`#${t}  `}</Text>)}
        </Box>
      )}
      <Box marginTop={1}>{gradientRule($, e, Math.min(columns, 48), 'head-rule')}</Box>
    </Box>,
  )
  heights.push((r.history.length > 0 ? 2 : 0) + rowsAt(str(fm.title), columns) + 1 + 1 + rowsAt(meta, columns) + (r.error ? 1 : 0)
    + page.signals.length + 1 + rowsAt(str(fm.summary), columns - 2) + (topics ? 2 : 0) + 2 + 1)
  // one block per paragraph, so j and k have places to stop
  paragraphs(page.body).forEach((text, i) => {
    items.push(
      <Box key={`p-${i}`} flexDirection="row" marginBottom={1}>
        <Box width={2} flexShrink={0}><Text bold color={TAGLINE_FROM}>{at === i ? '▶' : ' '}</Text></Box>
        <Markdown key={`para-${i}`} text={text} />
      </Box>,
    )
    heights.push(rowsAt(text, columns - 2) + 1)
  })
  items.push(
    <Box key="tail" flexDirection="column">
      {page.links.length > 0 && sectionTitle($, e, 'LINKED PAGES')}
      {page.links.map(name => (
        <Box key={`l-${name}`} flexDirection="row" paddingLeft={2}>
          <Text color="claude">{'› '}</Text>
          {pageLink($, e, `link-${name}`, name)}
        </Box>
      ))}
      {page.links.length > 0 && <Text> </Text>}
      <Text dimColor>{page.path}</Text>
    </Box>,
  )
  heights.push(page.links.length + (page.links.length > 0 ? 2 : 0) + 1)
  return { items, heights }
}

function drawNote($: EngineInterface, e: ResolveInput, id: string, note: ToolNote, isOpen: boolean) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={`iirc-note-${id}`} flexDirection="column">
      {note.pages.length > 0 && drawPages($, e, id, note.pages, isOpen, 'match this error')}
      {note.recovered.map(r => (
        <Box flexDirection="row" paddingLeft={3}>
          <Text color="warning">✎ </Text>
          <Text color="subtle">iirc: </Text>
          <Text bold color="claude">{r.command}</Text>
          <Text color="subtle">{` failed ${r.failures} times, then worked; Claude was asked to write a page`}</Text>
        </Box>
      ))}
    </Box>
  )
}

function drawPages($: EngineInterface, e: ResolveInput, id: string, pages: RecalledPage[], isOpen: boolean, verb: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const toggle = () => update($, open, map => keepLast(map, id, !(map[id] === true)))
  const noun = pages.length === 1 ? 'page' : 'pages'
  const label = verb === 'suggested' ? `${noun} suggested` : `${noun} suggested for this error`
  return (
    <Box key={`iirc-${id}`} flexDirection="column" paddingLeft={3}>
      {/* the whole row is one button, so a click on the words opens the list too */}
      <Button key={`toggle-${id}`} plain onPress={toggle}>
        <Text bold color="suggestion">{isOpen ? '[−]' : '[+]'}</Text>
        <Text> </Text>
        <Text bold color="claude">iirc: </Text>
        <Text color="subtle">[</Text>
        <Text bold color="claude">{String(pages.length)}</Text>
        <Text color="subtle">] </Text>
        <Text color="suggestion">{label}</Text>
      </Button>
      {isOpen &&
        pages.map((p, i) => {
          const isLast = i === pages.length - 1
          // its own style object, so the drawn line can find the name and make it a link
          const nameStyle: Piece['style'] = { bold: true, color: 'claude' }
          const pieces: Piece[] = [
            { text: '◆ ', style: { color: p.isSuspect ? 'warning' : 'success' } },
            { text: p.name.replace(/\.md$/, ''), style: nameStyle },
            ...(p.isSuspect ? [{ text: ' (suspect)', style: { color: 'warning' } } as Piece] : []),
            ...(p.match ? [{ text: `  [${p.match}]`, style: { color: 'suggestion' } } as Piece] : []),
            { text: '  ' + p.summary, style: { dimColor: true, italic: true } },
          ]
          // wrap here, so each wrapped line keeps the tree's gutter; unmeasured, one line
          const width = e.viewport ? e.viewport.columns - PAGE_INDENT : Infinity
          return wrapPieces(pieces, width).map((line, j) => (
            <Box key={`iirc-${id}-${i}-${j}`} flexDirection="row" paddingLeft={2}>
              {/* a fixed column: a Text's trailing space is not drawn */}
              <Box width={3} flexShrink={0}>
                <Text color="subtle">{j > 0 ? (isLast ? ' ' : '│') : isLast ? '└─' : '├─'}</Text>
              </Box>
              {line.map((piece, k) =>
                piece.style === nameStyle ? (
                  <Button key={`open-${id}-${i}-${j}-${k}`} plain onPress={() => void openPage($, p.name)}>
                    <Text {...piece.style}>{piece.text}</Text>
                  </Button>
                ) : (
                  <Text {...piece.style} wrap="truncate-end">
                    {piece.text}
                  </Text>
                ),
              )}
            </Box>
          ))
        })}
    </Box>
  )
}

/** Text with its style, so a wrapped line keeps each part's color. */
type Piece = { text: string; style: { color?: 'success' | 'warning' | 'claude' | 'suggestion'; bold?: boolean; dimColor?: boolean; italic?: boolean } }

/** Word-wraps styled pieces into lines no wider than `width` cells; a word longer than a line is split. */
export function wrapPieces(pieces: Piece[], width: number): Piece[][] {
  const lines: Piece[][] = [[]]
  let used = 0
  const put = (text: string, style: Piece['style']) => {
    const line = lines[lines.length - 1]
    const last = line[line.length - 1]
    if (last && last.style === style) last.text += text
    else line.push({ text, style })
    used += text.length
  }
  for (const piece of pieces) {
    for (const token of piece.text.split(/(\s+)/)) {
      if (!token) continue
      const isSpace = /^\s+$/.test(token)
      if (used + token.length > width) {
        if (isSpace) {
          lines.push([])
          used = 0
          continue
        }
        if (used > 0) {
          lines.push([])
          used = 0
        }
        let rest = token
        while (rest.length > width) {
          put(rest.slice(0, width), piece.style)
          lines.push([])
          used = 0
          rest = rest.slice(width)
        }
        put(rest, piece.style)
      } else if (!(isSpace && used === 0 && lines.length > 1)) {
        put(token, piece.style)
      }
    }
  }
  // a space where the line broke belongs to neither line
  for (const line of lines) {
    const last = line[line.length - 1]
    if (last) last.text = last.text.trimEnd()
    if (last && !last.text) line.pop()
  }
  return lines.filter(line => line.length > 0)
}
