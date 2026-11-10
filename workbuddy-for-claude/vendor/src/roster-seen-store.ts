/**
 * "When did THIS machine first see this model?" — the single source of truth
 * behind the composer pill's "· N 新模型" segment.
 *
 * ## What it answers, and what it does not
 *
 * It records only a FIRST-SEEN TIMESTAMP per model id: the moment that id
 * first appeared in the roster this machine pulled. Anything derived from it
 * must be worded as "本机首次见到的模型", NEVER as "网关新增": the upstream
 * `/v1/models`-style list carries no "listed since" field, so no field in this
 * plugin can prove a model was added this week. The one fact that IS provable
 * is "the day this machine started seeing it", and that is the only thing said.
 *
 * It also does NOT record activity or promotion changes (free models, off-peak,
 * daily sign-in): those are live readings, drawn straight from the upstream by
 * the panel's credit block and the pill popover. A second "promotion diff
 * ledger" would be one fact kept in two books, and two books eventually say two
 * different things (ADR-017's doctrine).
 *
 * ## One call diffs AND persists
 *
 * {@link RosterSeenStore.note} must not be split into "diff the cache, write
 * later": two concurrent reconcile rounds could both judge against the same old
 * map, and the later write would re-announce the models the earlier one already
 * announced. Read, compute and write happen in one call.
 *
 * ## The first write is SEEDING, not announcing
 *
 * Upgrading to a build that carries this file leaves no history on disk — at
 * that moment we KNOW the catalog holds these models but do NOT know which of
 * them are new. Announcing the whole catalog as "just added" is exactly the lie
 * this file exists to avoid, so the seeding round stamps every id with an
 * already-expired timestamp (`now - window`) and `newIds` answers empty. That
 * self-healing is deliberate: an id must leave the roster and come back before
 * it earns a real first-seen stamp.
 *
 * ## More than 200 ids is SHAPE DRIFT, not "keep the newest 200"
 *
 * Evicting by "keep the newest" drops an id that is STILL in the catalog, which
 * makes it look unseen next round → re-stamped → re-announced; and the evicted
 * set rotates each round, so the new-model count oscillates and GROWS (measured
 * with 250 ids against the 200 cap: 50 → 100 → …). A history file that invents
 * its own new models is worse than no file at all, so an over-cap round is read
 * as shape drift: it is NOT written and NOT announced, the old map is kept
 * as-is, the marker disappears during the anomaly, and it self-heals once the
 * catalog returns to a sane size.
 *
 * ## Delisting, and where the file lives
 *
 * Ids that left the roster are dropped from the table, so a model that comes
 * back later counts as newly-seen again — exactly the "it came back" case a
 * reader cares about.
 *
 * REGION-SCOPED like every other plugin-owned file in this repo: the CN and
 * international catalogs are separate, so a first-seen in one region says
 * nothing about the other, and the two rosters must never overwrite each
 * other's history. Written under the same atomic-write helpers as
 * `src/account-pool-store.ts` (host-first, `mode: 0o600`, `dirMode: 0o700`).
 *
 * doctor coverage: {@link describeRosterSeenPayload} gives the read-only
 * summary, and `src/bin.ts` reports a corrupt / unknown-version file from it
 * rather than silently answering "no new models".
 *
 * @module dsh-connect-workbuddy/roster-seen-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome, withFileLock, writeFileAtomic } from './host-peers.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** Version of the on-disk payload this build writes. */
export const ROSTER_SEEN_VERSION = 1

/** The versions this build can read (add a new one on upgrade, keep old ones). */
export const KNOWN_ROSTER_SEEN_VERSIONS: readonly number[] = Object.freeze([ROSTER_SEEN_VERSION])

/**
 * The "new" window: a first-seen stamp inside it counts as new.
 *
 * 7 days is a deliberate scale — it has to cover "the user was away a few days
 * and came back to two new models" without letting one bulk upload still carry
 * a marker two weeks later. The window is a CONSTANT here rather than a config:
 * a "new model" marker that could be tuned to 365 days has no meaning.
 */
export const ROSTER_SEEN_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The catalog-size cap. Over it is shape drift (not an eviction queue — see
 * the module note).
 *
 * Matches the sibling plugins' implementations: real catalogs are a few
 * hundred models, and 200 leaves headroom for "this side suddenly returned the
 * whole-site list" accidents.
 */
export const ROSTER_SEEN_MAX_IDS = 200

/**
 * How long a read answer stays valid before the file is read again.
 *
 * Another process may have just written, so the answer has to be visible within
 * a tick — but a single snapshot assembly should not re-read the file several
 * times.
 */
const ROSTER_SEEN_READ_TTL_MS = 5000

/** Filename prefix for one region's first-sighting history. */
const ROSTER_SEEN_FILE_PREFIX = '.workbuddy-roster-seen'

/** First-seen table: model id → epoch milliseconds of first sighting. */
export type RosterSeen = Record<string, number>

/** The on-disk payload. `version: null` appears only on a missing/corrupt read. */
interface RosterSeenPayload {
  seen: RosterSeen
  version: number | null
}

const EMPTY_PAYLOAD: RosterSeenPayload = { seen: {}, version: null }

/** Whether this build can read a stored version. */
export function isKnownRosterSeenVersion(version: unknown): boolean {
  return typeof version === 'number' && KNOWN_ROSTER_SEEN_VERSIONS.includes(version)
}

/**
 * Normalise a first-seen table: keep only entries whose id is a non-empty
 * string and whose stamp is a finite positive number.
 *
 * Dropping rather than repairing a bad entry is deliberate: a stamp of 0 or
 * negative makes `now - stamp` come out as decades, and that id would count as
 * "new" forever. Better to let it take a real stamp the next time it appears.
 */
export function normalizeRosterSeen(raw: unknown): RosterSeen {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: RosterSeen = {}
  for (const [id, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '') continue
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue
    out[id] = stamp
  }
  return out
}

/**
 * One region's path for its first-sighting history.
 *
 * Region-keyed for the same reason the credential and pool copies are: the two
 * regions are parallel stacks and must never overwrite each other's history.
 */
export function rosterSeenPath(region: WorkBuddyRegion, dir?: string): string {
  if (typeof dir === 'string' && dir !== '') return join(dir, `${ROSTER_SEEN_FILE_PREFIX}.${region}.json`)
  return join(resolveDshHome(), `${ROSTER_SEEN_FILE_PREFIX}.${region}.json`)
}

/**
 * The ids from a first-seen table that are still "new", oldest first.
 *
 * Ascending on purpose: the caller shows only the first few names (the pill
 * tooltip / popover budget), and the ones seen EARLIEST are the ones closest to
 * expiring — and the ones the reader is most likely to have already met and
 * needs told "it really only just appeared".
 */
export function freshIdsOf(seen: RosterSeen, nowMs: number): string[] {
  return Object.entries(seen)
    .filter(([, first]) => nowMs - first < ROSTER_SEEN_NEW_WINDOW_MS)
    .sort((left, right) => left[1] - right[1])
    .map(([id]) => id)
}

/**
 * Parse a raw JSON value into a payload; an unreadable version reads as an
 * empty table but KEEPS the version number — reads stay permissive, while the
 * write guard refuses to overwrite it (the two halves are one rule).
 */
function parseRosterSeenPayload(raw: unknown): RosterSeenPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_PAYLOAD
  const source = raw as Record<string, unknown>
  const version = typeof source['version'] === 'number' ? source['version'] : null
  if (!isKnownRosterSeenVersion(version)) return { seen: {}, version }
  return { seen: normalizeRosterSeen(source['seen']), version }
}

/** Store construction options. */
export interface RosterSeenStoreOptions {
  /** Override the home directory (tests). */
  dir?: string
  /** Read-cache TTL. */
  ttlMs?: number
}

/** A first-sighting readout, assembled read-only by the usage route. */
export interface RosterSeenReadout {
  newModelIds: readonly string[]
  /** A sentence when the on-disk history is in a version this build cannot read. */
  versionNote?: string
}

/**
 * The file-backed first-sighting table for one region.
 */
export function createFileRosterSeenStore(
  region: WorkBuddyRegion,
  options: RosterSeenStoreOptions = {},
) {
  const { dir, ttlMs = ROSTER_SEEN_READ_TTL_MS } = options
  const filePath = rosterSeenPath(region, dir)

  /** Read the file's raw JSON, or `null` for a missing or unreadable file. */
  const readRaw = async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch {
      return null
    }
  }

  // A short-TTL read cache: another process may have written, so the answer has
  // to be fresh within a tick, but one snapshot assembly must not re-read.
  let cached: { payload: RosterSeenPayload; at: number } | undefined
  const readPayload = async (): Promise<RosterSeenPayload> => {
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.payload
    const payload = parseRosterSeenPayload(await readRaw())
    cached = { payload, at: Date.now() }
    return payload
  }

  // Read-diff-write must be serialised within this process too: two concurrent
  // reconcile rounds judging against the same old map is the exact re-announce
  // bug the module note warns about.
  let writeTail: Promise<unknown> = Promise.resolve()
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(task, task)
    writeTail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    /**
     * Record one round's complete catalog and answer which of its ids are still
     * inside the new window.
     *
     * One call diffs AND persists (see the module note). The first write is
     * SEEDING: every id is stamped as already expired and `newIds` answers
     * empty.
     */
    async note(ids: readonly string[], nowMs: number = Date.now()): Promise<{ newIds: string[] }> {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : []
      const unique = [...new Set(list)]
      // An empty catalog is nothing to record. Above all it must NOT be read as
      // "everything was delisted" and written down: one transient empty round
      // would empty the whole table, and the next round would re-stamp and
      // announce everything as new.
      if (unique.length === 0) return { newIds: [] }
      const now = Number.isFinite(nowMs) ? nowMs : Date.now()
      return enqueueWrite(() => withFileLock(filePath, async () => {
        // The read happens INSIDE the lock, not before it: read-diff-write must be
        // one step against other processes, or two reconcilers could judge against
        // the same old map and the second write would undo the first.
        const current = parseRosterSeenPayload(await readRaw())
        // Unknown version: STOP here, neither writing nor announcing — an empty
        // table plus `seeded = false` would announce the whole catalog as newly
        // added. `doctor` says why the history is being ignored.
        if (current.version !== null && !isKnownRosterSeenVersion(current.version)) return { newIds: [] }
        // Keep only the ids STILL in this round's catalog: a delisted id is
        // dropped, so a return counts as a fresh first sighting (that is the
        // "it came back" case the reader cares about).
        const previous = current.seen
        const seeded = current.version === null
        const next: RosterSeen = {}
        for (const id of unique) {
          const first = previous[id]
          // A future stamp (clock rollback, a hand-edited file) is clamped to
          // now: otherwise `now - stamp` is negative and the marker stays lit.
          next[id] = typeof first === 'number' && first > 0 ? Math.min(first, now) : seeded ? now - ROSTER_SEEN_NEW_WINDOW_MS : now
        }
        if (Object.keys(next).length > ROSTER_SEEN_MAX_IDS) {
          // Shape drift: neither write nor announce, keep the old map (module note).
          return { newIds: [] }
        }
        const changed =
          seeded
          || Object.keys(previous).length !== Object.keys(next).length
          || Object.keys(next).some((id) => previous[id] !== next[id])
        if (changed) {
          // An IO failure throws: the reconciler only warns, but the reason must
          // never be swallowed into "there were no new models this round" — those
          // are two entirely different facts.
          await writeFileAtomic(filePath, `${JSON.stringify({
            version: ROSTER_SEEN_VERSION,
            seen: next,
            updatedAt: new Date().toISOString(),
          }, null, 2)}\n`, {
            mode: 0o600,
            dirMode: 0o700,
          })
          cached = { payload: { seen: next, version: ROSTER_SEEN_VERSION }, at: Date.now() }
        }
        return { newIds: seeded ? [] : freshIdsOf(next, now) }
      }))
    },
    /**
     * Read-only: the ids that still count as "new" right now (ascending).
     *
     * NEVER WRITES. The snapshot and the provider route are read paths, and
     * writing happens only in the reconciler's `note`; a read path that topped
     * up stamps would let one panel poll rewrite "who is new".
     */
    async fresh(nowMs: number = Date.now()): Promise<string[]> {
      const payload = await readPayload()
      return freshIdsOf(payload.seen, Number.isFinite(nowMs) ? nowMs : Date.now())
    },
    /** Whether this table has ever been written (seeded vs "really none new"). */
    async isSet(): Promise<boolean> {
      return (await readPayload()).version !== null
    },
    /**
     * The read-only readout the usage route carries, or the version note when
     * the on-disk history is in a version this build cannot read.
     */
    async readout(nowMs: number = Date.now()): Promise<RosterSeenReadout> {
      const payload = await readPayload()
      const version = payload.version
      if (version === null || isKnownRosterSeenVersion(version)) {
        return { newModelIds: freshIdsOf(payload.seen, Number.isFinite(nowMs) ? nowMs : Date.now()) }
      }
      return {
        newModelIds: [],
        versionNote: `The first-sighting history is stored in version ${String(version)}, which this build cannot read; it is answered as empty, so the pill shows no new-model marker. Known versions: ${KNOWN_ROSTER_SEEN_VERSIONS.join(', ')}.`,
      }
    },
    /** The on-disk path (diagnostics and tests). */
    filePath,
  }
}

export type RosterSeenStore = ReturnType<typeof createFileRosterSeenStore>

/**
 * doctor's read-only summary: parse a roster-seen payload without building a
 * store or touching any cache.
 *
 * `null` for a payload the whole shape does not recognise; `versionKnown: false`
 * for a recognised version this build cannot read — so `doctor` can tell "the
 * file is corrupt" from "a newer build wrote it".
 */
export function describeRosterSeenPayload(raw: unknown): { versionKnown: boolean; ids: number; fresh: number } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const version = (raw as Record<string, unknown>)['version']
  if (typeof version !== 'number') return null
  const seen = normalizeRosterSeen((raw as Record<string, unknown>)['seen'])
  return {
    versionKnown: isKnownRosterSeenVersion(version),
    ids: Object.keys(seen).length,
    fresh: freshIdsOf(seen, Date.now()).length,
  }
}