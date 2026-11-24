/**
 * Session cost in roubles — host half.
 *
 * WHY THIS IS NOT A CATALOGUE CALCULATOR
 * The first version priced a session by multiplying DSH's token counts by the
 * tariff published in RouterAI's `GET /models`. That tariff turned out to be
 * the price of ONE representative provider, while RouterAI bills the request
 * at the endpoint that actually served it: measured generations came out 1.1x
 * to 4.8x above the catalogue figure. A number that can be a fifth of the real
 * bill is worse than no number, because it looks authoritative.
 *
 * This version sums what RouterAI actually charged. Every generation has a
 * `total_cost` in roubles at `GET /generation?id=<X-Generation-Id>`, and the
 * response carries that id in the `X-Generation-Id` header. Summing it gives
 * the exact session bill, not an estimate.
 *
 * WHY THE ID HAS TO BE READ OFF THE WIRE
 * DSH reaches the model through `dsh-llm-deepseek`, which speaks the Messages
 * protocol. That protocol reports tokens only — no `cost` field — and the
 * adapter keeps neither the response header nor the streamed `message.id`
 * (the session log stores its own UUID). So the id is observed where it is
 * still visible: the adapter calls the global `fetch`, and this plugin wraps
 * that function once per process to read two headers and nothing else.
 *
 * THE OBSERVER IS PASS-THROUGH, NOT A PROXY
 * The wrapper awaits the original call, inspects the response headers, and
 * returns that same Response untouched. No body is read, tee'd, or delayed, so
 * streaming behaviour is identical to a run without the plugin. Attribution
 * uses `x-deepseek-harness-session-id`, which the adapter already sets on every
 * model request — including title and compaction calls, so their cost lands in
 * the right session too.
 *
 * COVERAGE IS HONEST ABOUT ITSELF
 * A generation can only be priced after it finishes, so the total trails the
 * conversation by a request or two. Sessions that started before the plugin
 * did (or before the last restart) have no earlier ids to price, and this
 * payload says so with `since` instead of pretending the sum is the whole
 * session. RouterAI's own key spend (`/key`) remains the account-wide truth.
 *
 * WHY THE TOP-LEVEL `apply` IS DEPENDENCY-FREE
 * `assertEntriesActivated` fails the whole boot when any top-level row does not
 * activate, so a row with a static `inject` that never resolves is a boot
 * hazard rather than a graceful degradation. This `apply` touches no service
 * outside `ctx.get`/`ctx.effect` and therefore always activates; everything
 * route-bound sits under the nested `ctx.inject(...)`, which parks only that
 * inner plugin.
 *
 * THE ROUTE IS REGISTERED ON `connection.fetch`, NOT ON `webServer`
 * `/api` is owned by a PREFIX route that applies the Host/Origin fence plus
 * browser authentication, and `webServer.match` consults the exact table first.
 * A direct exact registration on an `/api/...` path therefore shadows the fence
 * and serves the payload to any caller. This registry lives inside the fenced
 * handler, so the checks run before this body does.
 *
 * @module dsh-session-cost-routerai
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Route path; unique among the composed routes (checked against /api/file, /plugins). */
export const ROUTE_PATH = '/api/session-cost'

/** Billed-cost figure cache lifetime; one call per view is plenty. */
const KEY_TTL_MS = 60 * 1000

/** Generation record write window: one file rewrite per burst of requests. */
const SAVE_DEBOUNCE_MS = 3000

/** Keep the state file bounded: newest sessions win, older rows are dropped. */
const MAX_SESSIONS = 200
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Dedupe window for generation ids seen through the observer. */
const SEEN_LIMIT = 5000

/** Request header the harness puts on every model call. */
const SESSION_HEADER = 'x-deepseek-harness-session-id'
/** Response header RouterAI puts on every model call. */
const GENERATION_HEADER = 'x-generation-id'

/**
 * Backoff for the generation lookup. A record exists from the moment the
 * response opens, but its `total_cost` stays zero until the generation
 * settles — and a tool-heavy answer can stream for minutes. These delays reach
 * roughly six minutes, which covers a long turn; a normal call settles on the
 * first or second look.
 */
const RETRY_DELAYS = [
  750, 1500, 3000, 6000, 8000, 8000, 10000, 10000, 15000, 15000,
  20000, 20000, 30000, 30000, 30000, 30000, 30000, 30000,
]

/** Process-wide observer registry, so a reload cannot stack wrappers. */
const OBSERVER_KEY = Symbol.for('dsh-session-cost-routerai/observer-v1')

const DEFAULT_BASE = 'https://routerai.ru/api/v1'
const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Coerce one catalogue number, treating anything unusable as zero. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Coerce one counter, clamping to a non-negative integer. */
function int(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Strip trailing slashes so a configured root always yields the same match. */
function normalizeBase(value) {
  return value.replace(/\/+$/u, '')
}

/**
 * Resolve the profile state file. `statePath: null` disables persistence, which
 * is what the unit tests use.
 * @param configured - the row's `statePath`, or undefined for the default.
 * @returns the path, or null when persistence was disabled explicitly.
 */
function resolveStatePath(configured) {
  if (configured === null) return null
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
  }
  const root = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(root, 'storages', 'session-cost-routerai.json')
}

/**
 * Read the process-wide observer registry, creating it on first use. Holding
 * the native fetch here matters: the tracker's own `/generation` lookups must
 * bypass the wrapper so observation cannot recurse into itself.
 * @returns the registry.
 */
function ensureRegistry() {
  const existing = globalThis[OBSERVER_KEY]
  if (existing !== undefined) return existing
  const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined
  const created = { trackers: new Set(), installed: false, nativeFetch, wrapper: undefined }
  globalThis[OBSERVER_KEY] = created
  return created
}

/**
 * Wrap the global fetch once. The wrapper does nothing but hand the response to
 * every registered tracker; a tracker that throws must never break the request,
 * so each call is isolated.
 * @returns the registry, so the caller can inspect the native fetch.
 */
function installObserver() {
  const registry = ensureRegistry()
  if (registry.installed || typeof globalThis.fetch !== 'function') return registry
  const previous = globalThis.fetch
  const wrapper = async function observedFetch(input, init) {
    const response = await previous.call(this, input, init)
    for (const tracker of [...registry.trackers]) {
      try {
        tracker.observe(input, init, response)
      } catch {
        // Observation is best-effort by contract: a meter must not fail a call.
      }
    }
    return response
  }
  wrapper[OBSERVER_KEY] = true
  registry.wrapper = wrapper
  globalThis.fetch = wrapper
  registry.installed = true
  return registry
}

/**
 * The URL and headers of one observed call, whichever fetch shape was used.
 * @param input - the request URL or Request instance.
 * @param init - the optional RequestInit.
 * @returns the URL string and a Headers view, or undefined when unavailable.
 */
function describeRequest(input, init) {
  let url
  let method
  let source
  if (typeof input === 'string' || input instanceof URL) {
    url = String(input)
    method = init?.method
    source = init?.headers
  } else if (input !== null && typeof input === 'object' && 'url' in input) {
    url = String(input.url)
    method = init?.method ?? input.method
    source = init?.headers ?? input.headers
  }
  if (typeof url !== 'string' || url.length === 0) return undefined
  let headers
  if (source !== undefined) {
    try {
      headers = source instanceof Headers ? source : new Headers(source)
    } catch {
      headers = undefined
    }
  }
  return { url, method: typeof method === 'string' ? method.toUpperCase() : 'GET', headers }
}

/**
 * Price generations and accumulate them per session.
 *
 * Every dependency is injectable so the unit tests can drive it without a
 * network: `fetchImpl` (the native fetch), `sleep`, `now`, and `resolveApiKey`.
 *
 * @param options - base URL, credential resolver, optional state path and seams.
 * @returns the tracker surface used by the route and by the observer.
 */
export function createCostTracker(options) {
  const {
    baseURL,
    resolveApiKey,
    statePath = null,
    fetchImpl = globalThis.fetch,
    retryDelays = RETRY_DELAYS,
    concurrency = 4,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options

  /** sessionId -> counters. Runtime fields live beside the persisted ones. */
  const sessions = new Map()
  /** generation ids already queued, so a retried response cannot double count. */
  const seen = new Set()

  let disposed = false
  let saveTimer = null
  let active = 0
  const waiting = []

  /** State load; the route awaits it so a restart answers with the old totals. */
  const ready = load()

  const messagesUrl = `${normalizeBase(baseURL)}/messages`

  /** Acquire one pricing slot; keeps a burst from opening dozens of lookups. */
  async function acquire() {
    if (active < concurrency) {
      active += 1
      return
    }
    await new Promise((resolve) => { waiting.push(resolve) })
  }

  /** Release one slot and wake the next waiter. */
  function release() {
    active -= 1
    const next = waiting.shift()
    if (next !== undefined) {
      active += 1
      next()
    }
  }

  /** The counters for one session, created on first sight. */
  function bucket(sessionId) {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      const at = now()
      entry = {
        costRub: 0,
        pricedCalls: 0,
        failedCalls: 0,
        pendingCalls: 0,
        totalCalls: 0,
        since: at,
        updatedAt: at,
        provider: undefined,
      }
      sessions.set(sessionId, entry)
      prune()
    }
    return entry
  }

  /** Drop the oldest rows once the table outgrows its bound. */
  function prune() {
    if (sessions.size <= MAX_SESSIONS) return
    const ordered = [...sessions.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id)
  }

  /** Persisted view of one entry, with runtime fields dropped. */
  function serialize() {
    const sessionsOut = {}
    for (const [id, entry] of sessions) {
      sessionsOut[id] = {
        costRub: entry.costRub,
        pricedCalls: entry.pricedCalls,
        failedCalls: entry.failedCalls,
        since: entry.since,
        updatedAt: entry.updatedAt,
        ...entry.provider === undefined ? {} : { provider: entry.provider },
      }
    }
    return { version: 1, sessions: sessionsOut }
  }

  /** Best-effort load; an absent or unreadable file simply starts empty. */
  async function load() {
    if (statePath === null) return
    let text
    try {
      text = await fs.readFile(statePath, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const stored = parsed === null || typeof parsed !== 'object' ? undefined : parsed.sessions
    if (stored === null || typeof stored !== 'object') return
    const oldest = now() - MAX_AGE_MS
    for (const [id, raw] of Object.entries(stored)) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (raw === null || typeof raw !== 'object') continue
      const updatedAt = num(raw.updatedAt) || now()
      if (updatedAt < oldest) continue
      const prior = sessions.get(id)
      if (prior !== undefined) {
        // A generation may already have been observed while the file was being
        // read; the stored totals are older, so they add rather than replace.
        prior.costRub += num(raw.costRub)
        prior.pricedCalls += int(raw.pricedCalls)
        prior.failedCalls += int(raw.failedCalls)
        prior.totalCalls += int(raw.pricedCalls) + int(raw.failedCalls)
        prior.since = Math.min(prior.since, num(raw.since) || prior.since)
        prior.updatedAt = Math.max(prior.updatedAt, updatedAt)
        if (prior.provider === undefined && typeof raw.provider === 'string') prior.provider = raw.provider
        continue
      }
      sessions.set(id, {
        costRub: num(raw.costRub),
        pricedCalls: int(raw.pricedCalls),
        failedCalls: int(raw.failedCalls),
        pendingCalls: 0,
        totalCalls: int(raw.pricedCalls) + int(raw.failedCalls),
        since: num(raw.since) || updatedAt,
        updatedAt,
        provider: typeof raw.provider === 'string' ? raw.provider : undefined,
      })
    }
    prune()
  }

  /** Replace the state file atomically, so a crash cannot leave half a JSON. */
  async function persist(force = false) {
    if (statePath === null || (disposed && !force)) return
    const body = JSON.stringify(serialize())
    const temp = `${statePath}.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await fs.mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
      await fs.writeFile(temp, body, { mode: 0o600 })
      await fs.rename(temp, statePath)
    } catch {
      try {
        await fs.unlink(temp)
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
    }
  }

  /** Coalesce writes: a burst of priced generations costs one file rewrite. */
  function scheduleSave() {
    if (statePath === null || disposed || saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  /**
   * Look one generation up, retrying while RouterAI has not written it yet.
   * @param generationId - the id from the response header.
   * @param apiKey - resolved bearer token.
   * @returns the billed cost and last provider, or undefined when unavailable.
   */
  async function lookup(generationId, apiKey) {
    const url = `${normalizeBase(baseURL)}/generation?id=${encodeURIComponent(generationId)}`
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      if (disposed) return undefined
      try {
        await acquire()
        let response
        try {
          response = await fetchImpl(url, {
            headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          })
        } finally {
          release()
        }
        if (response.ok) {
          const body = await response.json()
          const data = body?.data
          const cost = data?.total_cost
          // A record appears as soon as the response opens, with `total_cost: 0`
          // and no provider; only a settled generation carries the final figure.
          // `latency_ms` is the completion marker, with the other two as
          // fallbacks for routes that report them differently.
          const settled = typeof data?.latency_ms === 'number'
            || typeof data?.provider === 'string'
            || (typeof cost === 'number' && cost > 0)
          if (settled && typeof cost === 'number' && Number.isFinite(cost)) {
            return {
              totalCost: cost,
              ...typeof data.provider === 'string' ? { provider: data.provider } : {},
            }
          }
        }
      } catch {
        // Transport failure: fall through to the next attempt.
      }
      if (attempt < retryDelays.length) await sleep(retryDelays[attempt])
    }
    return undefined
  }

  /**
   * Price one generation and fold it into its session.
   * @param generationId - id from the `X-Generation-Id` header.
   * @param sessionId - session the request belonged to.
   */
  async function priceGeneration(generationId, sessionId) {
    const entry = bucket(sessionId)
    try {
      const apiKey = await resolveApiKey()
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        entry.failedCalls += 1
        return
      }
      const record = await lookup(generationId, apiKey)
      if (record === undefined) {
        entry.failedCalls += 1
        return
      }
      entry.costRub += record.totalCost
      entry.pricedCalls += 1
      if (record.provider !== undefined) entry.provider = record.provider
    } catch {
      entry.failedCalls += 1
    } finally {
      entry.pendingCalls -= 1
      entry.updatedAt = now()
      scheduleSave()
    }
  }

  /**
   * Take one completed model response. Only Messages calls to the configured
   * RouterAI root are considered, and only when both headers are present.
   * @param input - fetch input.
   * @param init - fetch init.
   * @param response - the untouched Response.
   */
  function observe(input, init, response) {
    if (disposed) return
    const described = describeRequest(input, init)
    if (described === undefined) return
    if (described.method !== 'POST') return
    if (described.url !== messagesUrl && !described.url.startsWith(`${messagesUrl}?`)) return
    if (response === null || typeof response !== 'object' || response.ok !== true) return
    const sessionId = described.headers?.get(SESSION_HEADER)
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const generationId = response.headers?.get(GENERATION_HEADER)
    if (typeof generationId !== 'string' || generationId.length === 0) return
    if (seen.has(generationId)) return
    if (seen.size >= SEEN_LIMIT) seen.clear()
    seen.add(generationId)
    const entry = bucket(sessionId)
    entry.totalCalls += 1
    entry.pendingCalls += 1
    void priceGeneration(generationId, sessionId)
  }

  /**
   * The counters one session has accumulated.
   * @param sessionId - the session the caller is displaying.
   * @returns the snapshot, with `costRub: null` until something is priced.
   */
  function snapshot(sessionId) {
    const entry = sessionId === null || sessionId === undefined ? undefined : sessions.get(sessionId)
    if (entry === undefined) {
      return {
        tracked: false,
        costRub: null,
        pricedCalls: 0,
        pendingCalls: 0,
        failedCalls: 0,
        totalCalls: 0,
        since: null,
        provider: null,
      }
    }
    return {
      tracked: true,
      costRub: entry.pricedCalls > 0 ? entry.costRub : null,
      pricedCalls: entry.pricedCalls,
      pendingCalls: entry.pendingCalls,
      failedCalls: entry.failedCalls,
      totalCalls: entry.totalCalls,
      since: entry.since,
      provider: entry.provider ?? null,
    }
  }

  /** Persist immediately; used by shutdown and by the tests. */
  async function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await persist()
  }

  /** Stop observation, flush what is known, and forget the runtime tables. */
  function dispose() {
    if (disposed) return
    disposed = true
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void persist(true)
    sessions.clear()
    seen.clear()
  }

  return {
    ready,
    observe,
    snapshot,
    flush,
    dispose,
    /** Exposed for tests and diagnostics. */
    get sessions() {
      return sessions
    },
  }
}

/**
 * Read the key's own spend and the account balance. Both need the bearer token,
 * so neither value can be fetched from the browser. They stay in the payload
 * because they are the account-wide truth the session sum cannot replace.
 *
 * @param baseURL - RouterAI API root.
 * @param apiKey - resolved bearer token.
 * @param signal - abort signal from the request.
 * @returns whatever could be read; missing fields stay null.
 */
async function fetchKeyFigures(baseURL, apiKey, signal) {
  const headers = { authorization: `Bearer ${apiKey}` }
  const result = { keyUsageRub: null, creditsRub: null }
  try {
    const response = await fetch(`${baseURL}/key`, { headers, signal })
    if (response.ok) {
      const body = await response.json()
      const usage = body?.data?.usage
      if (typeof usage === 'number' && Number.isFinite(usage)) result.keyUsageRub = usage
    }
  } catch {
    // Key spend stays unknown; the client renders a dash.
  }
  try {
    const response = await fetch(`${baseURL}/credits`, { headers, signal })
    if (response.ok) {
      const body = await response.json()
      const credits = body?.data?.credits
      if (typeof credits === 'number' && Number.isFinite(credits)) result.creditsRub = credits
    }
  } catch {
    // Balance stays unknown; the client renders a dash.
  }
  return result
}

/**
 * Pull the routed model id out of a `request/context` event, if that is what
 * it is. Kept narrow on purpose: these events are live-ish session data, and
 * only two scalar leaves are read.
 * @param event - one session event.
 * @returns the model id, or undefined.
 */
function modelOfContextEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'request/context') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  return typeof data.model === 'string' && data.model.length > 0 ? data.model : undefined
}

/**
 * Resolve the model one session bills against, for display only: the figure no
 * longer depends on it, but the panel naming the route is what makes a price
 * legible.
 *
 * @param ctx - host context.
 * @param sessionId - the session to inspect, when the caller named one.
 * @returns the model id, or null when it cannot be determined.
 */
async function resolveModel(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    try {
      const live = sessions.get(sessionId)
      if (live !== undefined) {
        const context = live.requestContext()
        if (context !== null && typeof context === 'object' && typeof context.model === 'string') {
          return context.model
        }
      }
    } catch {
      // Fall through to the other reader.
    }
  }

  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      const snapshot = await query.load(sessionId)
      const events = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot.events
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const model = modelOfContextEvent(events[index])
          if (model !== undefined) return model
        }
      }
    } catch {
      // The session may be gone; the panel then omits the model row.
    }
  }
  return null
}

/**
 * Build one JSON Fetch response.
 * @param status - HTTP status.
 * @param value - JSON-serialisable body.
 * @returns the response handed back to the connection bridge.
 */
function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Host plugin body. Deliberately dependency-free so this row always activates;
 * the carrier-bound work is nested.
 * @param ctx - host context.
 * @param config - the composition row's config.
 */
export function apply(ctx, config = {}) {
  const baseURL = typeof config.baseURL === 'string' && config.baseURL.length > 0
    ? normalizeBase(config.baseURL)
    : DEFAULT_BASE
  const keyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
    ? config.apiKeyEnv
    : DEFAULT_KEY_ENV
  const statePath = resolveStatePath(config.statePath)
  const trackCost = config.trackCost !== false

  /** Key figures cache: cheaper to fetch than a catalogue, so a short window. */
  let keyCache = null

  /** Resolve the bearer token, preferring the row's literal and then the store. */
  async function resolveApiKey() {
    if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return config.apiKey
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    try {
      const hit = await credentials.resolve(keyEnv)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // Credentials unavailable: the route still serves what it knows.
    }
    return undefined
  }

  const registry = ensureRegistry()
  const tracker = createCostTracker({
    baseURL,
    resolveApiKey,
    statePath,
    fetchImpl: registry.nativeFetch,
  })

  if (trackCost && registry.nativeFetch !== undefined) {
    installObserver()
    ctx.effect(() => {
      registry.trackers.add(tracker)
      return () => {
        registry.trackers.delete(tracker)
        tracker.dispose()
      }
    }, 'session-cost: billed-cost observer')
  }

  /**
   * Read the figures for one request. Kept separate from the registration so
   * the route body stays a thin wrapper.
   * @param sessionId - the session the caller is displaying, when named.
   * @param signal - abort signal for the whole read.
   * @returns the payload the browser receives.
   */
  async function readFigures(sessionId, signal) {
    await tracker.ready
    const model = await resolveModel(ctx, sessionId)
    const cost = tracker.snapshot(sessionId)

    let keyFigures = { keyUsageRub: null, creditsRub: null }
    const now = Date.now()
    if (keyCache !== null && now - keyCache.at < KEY_TTL_MS) {
      keyFigures = keyCache.value
    } else {
      const apiKey = await resolveApiKey()
      if (apiKey !== undefined) {
        try {
          keyFigures = await fetchKeyFigures(baseURL, apiKey, signal)
          keyCache = { at: Date.now(), value: keyFigures }
        } catch {
          // Leave both figures null rather than caching a transport failure.
        }
      }
    }

    return {
      ok: true,
      sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
      model,
      ...cost,
      keyUsageRub: keyFigures.keyUsageRub,
      creditsRub: keyFigures.creditsRub,
      fetchedAt: Date.now(),
    }
  }

  // Nested: parks only this inner plugin when `connection` is absent, leaving
  // the top-level row active and the boot audit satisfied.
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(
      () =>
        connCtx.connection.fetch.register({
          path: ROUTE_PATH,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: async (request) => {
            // One abort signal for the whole read, so a dropped request stops it.
            const controller = new AbortController()
            const onAbort = () => controller.abort()
            request.signal?.addEventListener('abort', onAbort)
            try {
              const url = new URL(request.url, 'http://localhost')
              const sessionId = url.searchParams.get('sessionId')
              const payload = await readFigures(sessionId, controller.signal)
              if (request.method === 'HEAD') {
                const head = jsonResponse(200, payload)
                await head.body?.cancel()
                return new Response(null, { status: 200, headers: head.headers })
              }
              return jsonResponse(200, payload)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return jsonResponse(500, { ok: false, reason: message, costRub: null })
            } finally {
              request.signal?.removeEventListener('abort', onAbort)
            }
          },
        }),
      'session-cost: figures route',
    )
  })
}
