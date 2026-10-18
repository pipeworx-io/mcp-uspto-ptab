interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * USPTO PTAB MCP — wraps the USPTO Open Data Portal (ODP) PTAB APIs
 *
 * Patent litigation and prosecution-appeal dockets before the Patent Trial and
 * Appeal Board, across THREE separate ODP products on the same host:
 *  - AIA trials: inter partes review (IPR), post-grant review (PGR),
 *    covered-business-method (CBM), derivation — proceedings, decisions, filed
 *    documents.
 *  - Ex parte Appeals: an applicant's appeal of an examiner's rejection to the
 *    Board (case numbers like "2024-001234", distinct from an AIA trial number).
 *  - Interferences: pre-AIA priority contests between competing applicants/
 *    patentees (case numbers like "106012").
 * These are three separate ODP products, not three views of one dataset — an
 * ex parte appeal number and an AIA trial number are different identifier
 * spaces, and only the trials product exposes proceeding/document endpoints;
 * appeals and interferences expose decisions only.
 *
 * Host + auth are IDENTICAL to the `patents` pack (USPTO ODP). Same free ODP
 * API key (X-Api-Key header, platform-key pattern via `_apiKey`).
 *
 * Search endpoints accept a Lucene-style `q` string (field:value with AND/OR/
 * NOT, wildcards, and [from TO to] ranges) plus a `pagination` object, sent as
 * a JSON POST body. Responses wrap results in a `patentTrial*DataBag` /
 * `patentAppealDataBag` / `patentInterferenceDataBag` array.
 *
 * Tools:
 * - ptab_search_proceedings:   IPR/PGR/CBM/derivation proceedings
 * - ptab_search_decisions:     PTAB trial decision documents (institution / final written)
 * - ptab_search_documents:     filings/briefs/declarations within a trial proceeding
 * - ptab_proceeding_timeline:  chronological event list for one AIA trial
 * - ptab_patent_risk_profile:  AIA-trial summary for one challenged patent
 * - ptab_party_exposure:       AIA-trial summary for one petitioner/owner
 * - ptab_recent_decisions:     recently issued AIA trial decisions
 * - ptab_search_appeals:       ex parte Appeals decisions (outcome counts first, records last)
 * - ptab_appeal:               one ex parte Appeal decision + outcome + document link
 * - ptab_search_interferences: pre-AIA Interference decisions
 *
 * Docs: https://data.uspto.gov/apis/ptab-trials/, https://data.uspto.gov/apis/ptab-appeals/,
 * https://data.uspto.gov/apis/ptab-interferences/
 *
 * NOTE on the Appeals/Interferences field names below: the ODP docs for these
 * two products are served by a client-side-routed SPA (no static page text to
 * read without a browser), so the bag/field names here come from USPTO's own
 * published API-change mapping doc + third-party client libraries, not a live
 * authenticated call (no key was available at build time — see the house
 * rule against guessing without evidence). Where a field name is uncertain,
 * the query builder OR's multiple plausible field names together, and the
 * record parser is defensive (see `unwrapLoud`): a non-empty result set that
 * doesn't match any known bag name fails LOUD with the real top-level keys,
 * rather than silently reporting zero records.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Uspto Ptab');
}


const BASE_URL = 'https://api.uspto.gov/api/v1/patent/trials';
const APPEALS_BASE_URL = 'https://api.uspto.gov/api/v1/patent/appeals';
const INTERFERENCES_BASE_URL = 'https://api.uspto.gov/api/v1/patent/interferences';

// ── Raw API types (subset — API returns more; we pick defensively) ────

interface TrialMetaData {
  trialTypeCode?: string;
  trialStatusCategory?: string;
  petitionFilingDate?: string;
  accordedFilingDate?: string;
  institutionDecisionDate?: string;
  latestDecisionDate?: string;
  terminationDate?: string;
  trialLastModifiedDate?: string;
  fileDownloadURI?: string;
}

interface PartyData {
  patentNumber?: string;
  patentOwnerName?: string;
  realPartyInInterestName?: string;
  counselName?: string;
  inventorName?: string;
  applicationNumberText?: string;
  grantDate?: string;
  groupArtUnitNumber?: string;
  technologyCenterNumber?: string;
}

interface DocumentData {
  documentCategory?: string;
  documentName?: string;
  documentTitleText?: string;
  documentTypeDescriptionText?: string;
  documentIdentifier?: string;
  documentNumber?: number;
  documentFilingDate?: string;
  documentSizeQuantity?: number;
  filingPartyCategory?: string;
  mimeTypeIdentifier?: string;
  fileDownloadURI?: string;
}

interface DecisionData {
  decisionIssueDate?: string;
  decisionTypeCategory?: string;
  trialOutcomeCategory?: string;
  appealOutcomeCategory?: string;
  statuteAndRuleBag?: string[];
  issueTypeBag?: string[];
}

interface TrialRecord {
  trialNumber?: string;
  trialTypeCode?: string;
  trialDocumentCategory?: string;
  lastModifiedDateTime?: string;
  trialMetaData?: TrialMetaData;
  patentOwnerData?: PartyData;
  regularPetitionerData?: PartyData;
  respondentData?: PartyData;
  derivationPetitionerData?: PartyData;
  documentData?: DocumentData;
  decisionData?: DecisionData;
}

interface TrialSearchResponse {
  count?: number;
  requestIdentifier?: string;
  patentTrialProceedingDataBag?: TrialRecord[];
  patentTrialDecisionDataBag?: TrialRecord[];
  patentTrialDocumentDataBag?: TrialRecord[];
}

// ── Auth + fetch ─────────────────────────────────────────────────────

function resolveApiKey(args: Record<string, unknown>): string {
  // Gateway auto-injects PLATFORM_USPTO_KEY as _apiKey when configured
  // (same key as the `patents` pack). BYO users pass _apiKey directly.
  const key = (args._apiKey as string | undefined)?.trim();
  delete args._apiKey;
  if (key) return key;
  throw new Error(
    'USPTO ODP API key required for PTAB Trials. Get one free at https://data.uspto.gov/apis/getting-started and pass via _apiKey, or contact the operator about platform credentials. (Same key as the USPTO patents pack.)',
  );
}

async function ptabSearch(
  apiKey: string,
  path: string,
  toolLabel: string,
  q: string,
  offset: number,
  limit: number,
  baseUrl: string = BASE_URL,
): Promise<TrialSearchResponse> {
  const body = { q, pagination: { offset, limit } };
  let res: Response;
  try {
    res = await pwFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `USPTO PTAB ${toolLabel} network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `USPTO PTAB ${toolLabel}: unauthorized (HTTP ${res.status}). Check the USPTO ODP _apiKey — get one free at https://data.uspto.gov/apis/getting-started.`,
    );
  }
  if (res.status === 429) {
    throw new Error(
      `USPTO PTAB ${toolLabel}: rate-limited (HTTP 429). Back off and retry — the ODP default tier is ~60 req/min.`,
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 10_000);
    // USPTO ODP answers "nothing matched" with HTTP 404, not an empty 200. Left
    // as an error that reads as a failure — and for these tools the empty answer
    // is usually the REAL one: most patents have never been challenged, so
    // "no PTAB proceedings" is the correct, reassuring result for
    // ptab_patent_risk_profile, not a broken call. Only treat 404 as empty when
    // USPTO says it is a no-match; a 404 from a wrong path stays an error.
    if (res.status === 404 && /no matching records/i.test(text)) {
      return {} as TrialSearchResponse;
    }
    throw new Error(
      `USPTO PTAB ${toolLabel} error: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > 10_000_000) throw new Error(`USPTO PTAB ${toolLabel} response exceeded size limit.`);
  const text = await res.text();
  if (new TextEncoder().encode(text).length > 10_000_000) {
    throw new Error(`USPTO PTAB ${toolLabel} response exceeded size limit.`);
  }
  try {
    return JSON.parse(text) as TrialSearchResponse;
  } catch {
    throw new Error(`USPTO PTAB ${toolLabel} error: non-JSON response from USPTO ODP.`);
  }
}

function unwrap(data: TrialSearchResponse): TrialRecord[] {
  // Decisions + documents both return `patentTrialDocumentDataBag` in practice;
  // proceedings return `patentTrialProceedingDataBag`. Check all defensively.
  return (
    data.patentTrialProceedingDataBag ??
    data.patentTrialDecisionDataBag ??
    data.patentTrialDocumentDataBag ??
    []
  );
}

// ── Appeals / Interferences (loose, defensively-parsed shape) ──────────
//
// These two ODP products are not mirrored by our own pack's existing live
// traffic the way AIA trials are, and their SPA docs pages render no static
// text (see the house rule against guessing without evidence — the bag/field
// names below come from USPTO's own published API-change mapping doc, not a
// live call). `GenericRecord` deliberately keeps an index signature instead of
// a narrow interface so a field-name miss doesn't throw a TypeScript-shaped
// wall at runtime; `unwrapLoud` is what turns a genuine schema mismatch into a
// loud, diagnosable error instead of a silent empty result.
interface GenericRecord extends Record<string, unknown> {
  decisionData?: DecisionData;
  documentData?: DocumentData;
}

interface GenericSearchResponse extends Record<string, unknown> {
  count?: number;
  requestIdentifier?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Read the first matching key across a record and (optionally) one or more
// nested sub-objects, trying several plausible field-name spellings. Live
// post-deploy probing (fleet #3306 follow-up, 2026-10-18) confirmed some of
// these guesses right and some wrong — see the field-name confidence note
// below — so this checks TOP LEVEL first, then each nested candidate in turn,
// which costs nothing when a guess is wrong and catches it when the real
// schema nests a field we assumed was flat (or vice versa).
function pick(r: GenericRecord, keys: string[], nested?: string | string[]): string | undefined {
  for (const k of keys) {
    const v = str(r[k]);
    if (v) return v;
  }
  const nestedKeys = nested ? (Array.isArray(nested) ? nested : [nested]) : [];
  for (const nestKey of nestedKeys) {
    const sub = r[nestKey];
    if (sub && typeof sub === 'object') {
      for (const k of keys) {
        const v = str((sub as Record<string, unknown>)[k]);
        if (v) return v;
      }
    }
  }
  return undefined;
}

// Unwrap a search response whose top-level bag key is uncertain. Tries every
// candidate key; if the response plainly reports zero matches (count === 0,
// or absent with no candidate present), that is a legitimate empty result. If
// it reports a positive count but none of the candidate keys hold a non-empty
// array, that is a schema mismatch — fail LOUD naming the real top-level keys
// so it can be diagnosed from the raw response, rather than silently
// returning `[]` and reading as "no records" (house rule: a zero-parse must
// be loud, never indistinguishable from a true empty search).
function unwrapLoud(data: GenericSearchResponse, candidateBags: string[], toolLabel: string): GenericRecord[] {
  for (const bag of candidateBags) {
    const v = data[bag];
    if (Array.isArray(v)) return v as GenericRecord[];
  }
  const count = typeof data.count === 'number' ? data.count : undefined;
  if (count === 0 || count === undefined) return [];
  const keys = Object.keys(data).join(', ') || '(no keys)';
  throw new Error(
    `USPTO PTAB ${toolLabel}: response reported count=${count} but none of the expected bag keys ` +
      `(${candidateBags.join(', ')}) were present as arrays. Top-level keys seen: ${keys}. ` +
      `This is a schema-mismatch, not a true empty result — the ODP field name differs from what this pack assumes.`,
  );
}

// ── q-builder ────────────────────────────────────────────────────────

// Escape Lucene special chars in a raw field value (leave field: prefix alone).
function esc(v: string): string {
  return v.trim().replace(/([+\-!(){}\[\]^"~*?:\\/])/g, '\\$1');
}

function fieldClause(field: string, value: string): string {
  // Wrap phrases containing spaces in quotes so multi-word names stay together.
  const raw = value.trim();
  if (/\s/.test(raw)) return `${field}:"${raw.replace(/"/g, '\\"')}"`;
  return `${field}:${esc(raw)}`;
}

function joinAnd(parts: string[]): string {
  return parts.filter(Boolean).join(' AND ');
}

// ── Formatters ───────────────────────────────────────────────────────

function pickParty(p?: PartyData) {
  if (!p) return null;
  const out: Record<string, string> = {};
  if (p.realPartyInInterestName) out.real_party = p.realPartyInInterestName;
  if (p.patentOwnerName) out.patent_owner = p.patentOwnerName;
  if (p.counselName) out.counsel = p.counselName;
  if (p.inventorName) out.inventor = p.inventorName;
  if (p.patentNumber) out.patent_number = p.patentNumber;
  if (p.applicationNumberText) out.application_number = p.applicationNumberText;
  if (p.grantDate) out.grant_date = p.grantDate;
  return Object.keys(out).length ? out : null;
}

function formatProceeding(r: TrialRecord) {
  const m = r.trialMetaData ?? {};
  return {
    trial_number: r.trialNumber ?? null,
    trial_type: m.trialTypeCode ?? r.trialTypeCode ?? null,
    status: m.trialStatusCategory ?? null,
    petition_filing_date: m.petitionFilingDate ?? null,
    accorded_filing_date: m.accordedFilingDate ?? null,
    institution_decision_date: m.institutionDecisionDate ?? null,
    latest_decision_date: m.latestDecisionDate ?? null,
    termination_date: m.terminationDate ?? null,
    last_modified: m.trialLastModifiedDate ?? r.lastModifiedDateTime ?? null,
    patent_number: r.patentOwnerData?.patentNumber ?? null,
    patent_owner: pickParty(r.patentOwnerData),
    petitioner: pickParty(r.regularPetitionerData),
    respondent: pickParty(r.respondentData),
    derivation_petitioner: pickParty(r.derivationPetitionerData),
    files_uri: m.fileDownloadURI ?? null,
  };
}

function formatDecision(r: TrialRecord) {
  const m = r.trialMetaData ?? {};
  const d = r.decisionData ?? {};
  const doc = r.documentData ?? {};
  return {
    trial_number: r.trialNumber ?? null,
    trial_type: m.trialTypeCode ?? r.trialTypeCode ?? null,
    document_category: r.trialDocumentCategory ?? doc.documentCategory ?? null,
    decision_type: d.decisionTypeCategory ?? null,
    decision_issue_date: d.decisionIssueDate ?? m.latestDecisionDate ?? null,
    trial_outcome: d.trialOutcomeCategory ?? null,
    appeal_outcome: d.appealOutcomeCategory ?? null,
    issue_types: d.issueTypeBag ?? null,
    statutes_and_rules: d.statuteAndRuleBag ?? null,
    document_title: doc.documentTitleText ?? doc.documentName ?? null,
    document_identifier: doc.documentIdentifier ?? null,
    document_uri: doc.fileDownloadURI ?? null,
    status: m.trialStatusCategory ?? null,
    patent_number: r.patentOwnerData?.patentNumber ?? null,
    patent_owner: pickParty(r.patentOwnerData),
    petitioner: pickParty(r.regularPetitionerData),
  };
}

function formatDocument(r: TrialRecord) {
  const doc = r.documentData ?? {};
  const m = r.trialMetaData ?? {};
  return {
    trial_number: r.trialNumber ?? null,
    trial_type: m.trialTypeCode ?? r.trialTypeCode ?? null,
    document_category: r.trialDocumentCategory ?? doc.documentCategory ?? null,
    document_name: doc.documentName ?? null,
    document_title: doc.documentTitleText ?? null,
    document_type: doc.documentTypeDescriptionText ?? null,
    document_identifier: doc.documentIdentifier ?? null,
    document_number: doc.documentNumber ?? null,
    filing_date: doc.documentFilingDate ?? null,
    filing_party: doc.filingPartyCategory ?? null,
    size_bytes: doc.documentSizeQuantity ?? null,
    mime_type: doc.mimeTypeIdentifier ?? null,
    file_uri: doc.fileDownloadURI ?? null,
    patent_number: r.patentOwnerData?.patentNumber ?? null,
  };
}

function clampLimit(v: unknown, def = 10): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function clampOffset(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function requiredText(args: Record<string, unknown>, key: string) {
  const value = typeof args[key] === 'string' ? args[key].trim() : '';
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function partyClause(party: string) {
  return `(${fieldClause('regularPetitionerData.realPartyInInterestName', party)} OR ${fieldClause('patentOwnerData.patentOwnerName', party)})`;
}

function tally(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value?.trim() || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function resultCoverage(data: { count?: number }, records: unknown[]) {
  const total = data.count ?? records.length;
  return { matching_records: total, analyzed_records: records.length, truncated: total > records.length };
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

// ── Appeals / Interferences formatters ──────────────────────────────
//
// FIELD NAMES CONFIRMED LIVE (fleet #3306, two follow-up passes with
// `include_raw` reading real ODP payloads, 2026-10-18 — not guessed):
//
//   APPEALS record shape: appealNumber, appealDocumentCategory (top-level);
//   appealMetaData.{appealFilingDate, fileDownloadURI}; appellantData.
//   {applicationNumberText, counselName, groupArtUnitNumber, inventorName,
//   realPartyInInterestName, patentNumber (an EMPTY STRING when none, not
//   absent — treat "" as null), patentOwnerName, publicationNumber,
//   publicationDate, technologyCenterNumber}; documentData.{documentIdentifier,
//   documentName, documentOCRText, decisionIssueDate, decisionTypeCategory,
//   fileDownloadURI, documentFilingDate}. decisionData.{decisionIssueDate,
//   appealOutcomeCategory} was ALSO confirmed live in the first follow-up
//   pass (outcome "Affirmed" came through correctly) — kept as the primary
//   source for those two fields since it already works; documentData is
//   read as a fallback in case a given record only populates one of the two.
//
//   INTERFERENCES record shape (full raw sample captured via include_raw):
//   interferenceNumber, lastModifiedDateTime (top-level); interferenceMetaData.
//   {declarationDate, interferenceStyleName, fileDownloadURI,
//   interferenceLastModifiedDate}; seniorPartyData/juniorPartyData.
//   {applicationNumberText, patentOwnerName, realPartyInInterestName,
//   inventorName, counselName, publicationNumber, publicationDate,
//   groupArtUnitNumber, technologyCenterNumber} (juniorPartyData additionally
//   carries patentNumber + grantDate — a "senior party" in a priority contest
//   may be the still-pending applicant with no patent number yet);
//   additionalPartyDataBag[] of {applicationNumberText, inventorName,
//   patentNumber, additionalPartyName}; documentData.{documentTitleText,
//   documentName, documentIdentifier, decisionIssueDate, decisionTypeCategory,
//   interferenceOutcomeCategory (NOT appealOutcomeCategory — a different key
//   from the appeals/trials products), statuteAndRuleBag[], documentFilingDate,
//   fileDownloadURI, documentOCRText}. There is NO separate `decisionData`
//   object on an interference record — all decision fields live directly
//   under documentData.
//
// A second-source community Python client (pip `uspto-odp`) was tried in an
// earlier pass and modeled both products as flat records with no nesting at
// all — that turned out to be wrong (the real shape nests everything under
// per-party/per-document sub-objects as above); it is not referenced further.
// `include_raw` stays on all three tools so any record shape that still
// slips through can be read directly rather than re-guessed.

function formatAppeal(r: GenericRecord) {
  const d = r.decisionData ?? {};
  const doc = r.documentData ?? {};
  const docRaw = (r.documentData as unknown as Record<string, unknown>) ?? {};
  const appellant = (r.appellantData as Record<string, unknown>) ?? {};
  const meta = (r.appealMetaData as Record<string, unknown>) ?? {};
  return {
    appeal_number: pick(r, ['appealNumber', 'appealDocketNumber']) ?? null,
    application_number: str(appellant.applicationNumberText) ?? null,
    patent_number: str(appellant.patentNumber) ?? null, // "" on an un-patented application — str() already turns "" into undefined
    applicant: str(appellant.realPartyInInterestName) ?? str(appellant.patentOwnerName) ?? str(appellant.inventorName) ?? null,
    counsel: str(appellant.counselName) ?? null,
    art_unit: str(appellant.groupArtUnitNumber) ?? null,
    technology_center: str(appellant.technologyCenterNumber) ?? null,
    appeal_filing_date: str(meta.appealFilingDate) ?? null,
    decision_type: d.decisionTypeCategory ?? str(docRaw.decisionTypeCategory) ?? null,
    decision_issue_date: d.decisionIssueDate ?? str(docRaw.decisionIssueDate) ?? null,
    outcome: d.appealOutcomeCategory ?? null,
    issue_types: d.issueTypeBag ?? null,
    statutes_and_rules: d.statuteAndRuleBag ?? null,
    document_title: doc.documentTitleText ?? doc.documentName ?? null,
    document_identifier: doc.documentIdentifier ?? null,
    document_uri: doc.fileDownloadURI ?? null,
    case_files_uri: str(meta.fileDownloadURI) ?? null,
    last_modified: pick(r, ['lastModifiedDateTime']) ?? null,
  };
}

function formatInterferenceParty(p: Record<string, unknown>) {
  return {
    name: str(p.patentOwnerName) ?? null,
    real_party_in_interest: str(p.realPartyInInterestName) ?? null,
    inventor: str(p.inventorName) ?? null,
    counsel: str(p.counselName) ?? null,
    application_number: str(p.applicationNumberText) ?? null,
    patent_number: str(p.patentNumber) ?? null,
    grant_date: str(p.grantDate) ?? null,
    publication_number: str(p.publicationNumber) ?? null,
    publication_date: str(p.publicationDate) ?? null,
  };
}

function formatInterference(r: GenericRecord) {
  const docRaw = (r.documentData as unknown as Record<string, unknown>) ?? {};
  const doc = r.documentData ?? {};
  const meta = (r.interferenceMetaData as Record<string, unknown>) ?? {};
  const junior = (r.juniorPartyData as Record<string, unknown>) ?? {};
  const senior = (r.seniorPartyData as Record<string, unknown>) ?? {};
  const additional = Array.isArray(r.additionalPartyDataBag) ? (r.additionalPartyDataBag as Record<string, unknown>[]) : [];
  return {
    interference_number: pick(r, ['interferenceNumber']) ?? null,
    style: str(meta.interferenceStyleName) ?? null,
    declared: str(meta.declarationDate) ?? null,
    junior_party: formatInterferenceParty(junior),
    senior_party: formatInterferenceParty(senior),
    additional_parties: additional.map((p) => ({
      name: str(p.additionalPartyName) ?? null,
      inventor: str(p.inventorName) ?? null,
      application_number: str(p.applicationNumberText) ?? null,
      patent_number: str(p.patentNumber) ?? null,
    })),
    decision_type: str(docRaw.decisionTypeCategory) ?? null,
    decision_issue_date: str(docRaw.decisionIssueDate) ?? null,
    outcome: str(docRaw.interferenceOutcomeCategory) ?? null,
    statutes_and_rules: Array.isArray(docRaw.statuteAndRuleBag) ? (docRaw.statuteAndRuleBag as string[]) : null,
    document_title: doc.documentTitleText ?? doc.documentName ?? null,
    document_identifier: doc.documentIdentifier ?? null,
    document_uri: doc.fileDownloadURI ?? null,
    case_files_uri: str(meta.fileDownloadURI) ?? null,
    last_modified: pick(r, ['lastModifiedDateTime']) ?? str(meta.interferenceLastModifiedDate) ?? null,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'ptab_search_proceedings',
    description:
      'Search USPTO PTAB trial proceedings — patent litigation before the Patent Trial and Appeal Board (inter partes review / IPR, post-grant review / PGR, covered-business-method / CBM, derivation). Returns trial number, type, status, the challenged patent, petitioner, patent owner, and key dates (petition filing, institution decision, latest decision, termination). Filter by free-text `query`, `patent_number` (the patent being challenged), `party` (petitioner or patent-owner real-party name), `trial_type` (IPR/PGR/CBM/DER), and/or `status`. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Optional free-text keyword search across the proceeding record (e.g. a technology term or company name). Combined with the structured filters below via AND.',
        },
        patent_number: {
          type: 'string',
          description: 'Optional. Patent number under challenge, e.g. "11809431" or "US9876543B2". Matches patentOwnerData.patentNumber.',
        },
        party: {
          type: 'string',
          description: 'Optional. Petitioner or patent-owner real-party-in-interest name, e.g. "Apple" or "Zydus Lifesciences". Matches either regularPetitionerData or patentOwnerData real-party name.',
        },
        trial_type: {
          type: 'string',
          description: 'Optional. Trial type code: IPR (inter partes review), PGR (post-grant review), CBM (covered business method), DER (derivation). Matches trialMetaData.trialTypeCode.',
        },
        status: {
          type: 'string',
          description: 'Optional. Trial status category, e.g. "Pending", "Terminated", "Final Written Decision", "Instituted". Matches trialMetaData.trialStatusCategory.',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10).',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key (same key as the patents pack). Get free at https://data.uspto.gov/apis/getting-started. Falls back to platform key if configured.',
        },
      },
    },
  },
  {
    name: 'ptab_search_decisions',
    description:
      'Search USPTO PTAB decision documents — institution decisions and final written decisions issued in IPR/PGR/CBM trials, plus appeal outcomes. Returns the trial number, decision type, issue date, trial/appeal outcome, the issue types and statutes/rules at play, and the decision document title + download URI. Filter by free-text `query`, `patent_number`, `trial_type`, and a `decided_after`/`decided_before` date range. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Optional free-text keyword search across decision records.',
        },
        patent_number: {
          type: 'string',
          description: 'Optional. Challenged patent number, e.g. "12018298". Matches patentOwnerData.patentNumber.',
        },
        trial_type: {
          type: 'string',
          description: 'Optional. Trial type code: IPR, PGR, CBM, DER. Matches trialMetaData.trialTypeCode.',
        },
        decided_after: {
          type: 'string',
          description: 'Optional. Only decisions on/after this date (ISO YYYY-MM-DD). Matches trialMetaData.latestDecisionDate.',
        },
        decided_before: {
          type: 'string',
          description: 'Optional. Only decisions on/before this date (ISO YYYY-MM-DD). Matches trialMetaData.latestDecisionDate.',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10).',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key (same key as the patents pack). Get free at https://data.uspto.gov/apis/getting-started.',
        },
      },
    },
  },
  {
    name: 'ptab_search_documents',
    description:
      'Search USPTO PTAB filings and documents within trial proceedings — petitions, patent-owner responses, expert declarations, exhibits, motions, and briefs. Pass `proceeding_number` (the trial number, e.g. "IPR2024-00001") to list every document filed in a proceeding, and/or `query` for free-text search. Returns document name/title, type, filing date, filing party, size, and download URI. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        proceeding_number: {
          type: 'string',
          description: 'Trial/proceeding number to list documents for, e.g. "IPR2024-00001", "PGR2026-00039". Matches trialNumber.',
        },
        query: {
          type: 'string',
          description: 'Optional free-text keyword search across document records (e.g. "declaration", "petition"). Combined with proceeding_number via AND.',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 25).',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0).',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key (same key as the patents pack). Get free at https://data.uspto.gov/apis/getting-started.',
        },
      },
    },
  },
  {
    name: 'ptab_proceeding_timeline',
    description:
      'Build a chronological PTAB proceeding timeline from the proceeding record and its public decision documents. Returns institution, final-written-decision, rehearing, settlement, dismissal, and other recorded decision events; absence of an event is not proof that it never occurred.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        proceeding_number: { type: 'string', description: 'PTAB trial number, e.g. IPR2024-00001.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: ['proceeding_number'],
    },
  },
  {
    name: 'ptab_patent_risk_profile',
    description:
      'Summarize PTAB proceedings and recorded decision outcomes for one challenged patent. Reports status/outcome counts and recent matters for review routing; it is not a validity opinion, litigation forecast, freedom-to-operate analysis, or claim-level legal conclusion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        patent_number: { type: 'string', description: 'Patent number as indexed by USPTO, e.g. 11809431.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: ['patent_number'],
    },
  },
  {
    name: 'ptab_party_exposure',
    description:
      'Summarize PTAB proceeding exposure for a petitioner or patent owner, including roles, challenged patents, statuses, trial types, and recorded outcomes. Party matching follows USPTO indexed names and may combine similarly named entities; verify identity before relying on totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        party: { type: 'string', description: 'Company or party name.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: ['party'],
    },
  },
  {
    name: 'ptab_recent_decisions',
    description:
      'Return and summarize recently issued public PTAB trial decisions, optionally filtered by trial type, patent, or party. Outcome labels describe the document-level USPTO record and require review in proceeding context; they are not claim-by-claim legal conclusions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Look-back window, 1–365 days (default 30).' },
        trial_type: { type: 'string', description: 'Optional IPR, PGR, CBM, or DER.' },
        patent_number: { type: 'string' }, party: { type: 'string' },
        limit: { type: 'number', description: '1–100, default 25.' },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: [],
    },
  },
  {
    name: 'ptab_search_appeals',
    description:
      "Search USPTO ex parte Appeals decisions — an applicant's appeal of a patent examiner's rejection to the Patent Trial and Appeal Board. This is a SEPARATE docket from AIA trials (IPR/PGR/CBM/derivation): an appeal number looks like \"2024-001234\", not \"IPR2024-00001\". Returns an outcome-count summary first (affirmed / reversed / affirmed-in-part / other), then the matching decision records, each with the applicant/real-party-in-interest, application and patent number, counsel, art unit, appeal filing date, decision type/date, and the decision document link. Filter by `appeal_number`, `application_number` (the rejected application under appeal), free-text `query`, and/or a `decided_after`/`decided_before` date range. Powered by the USPTO Open Data Portal (data.uspto.gov).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        appeal_number: {
          type: 'string',
          description: 'Optional. Ex parte appeal number, e.g. "2024-001234" (with or without an "Appeal" prefix). This is NOT an AIA trial number.',
        },
        application_number: {
          type: 'string',
          description: 'Optional. The patent application number under appeal, e.g. "16123456".',
        },
        query: {
          type: 'string',
          description: 'Optional free-text keyword search across appeal decision records (e.g. a technology term or applicant name).',
        },
        decided_after: {
          type: 'string',
          description: 'Optional. Only decisions on/after this date (ISO YYYY-MM-DD).',
        },
        decided_before: {
          type: 'string',
          description: 'Optional. Only decisions on/before this date (ISO YYYY-MM-DD).',
        },
        limit: {
          type: 'number',
          description: 'Number of decision records to return (1-100, default 25). Outcome counts are computed over this same page.',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0).',
        },
        include_raw: {
          type: 'boolean',
          description: 'Optional, default false. When true, also return raw_sample: one UNMODIFIED raw record exactly as the upstream API returned it (no field renaming), to verify or correct this tool\'s field mapping.',
        },
        _apiKey: {
          type: 'string',
          description: 'USPTO ODP API key (same key as the patents/uspto-ptab packs). Get free at https://data.uspto.gov/apis/getting-started.',
        },
      },
      required: [],
    },
  },
  {
    name: 'ptab_appeal',
    description:
      'Get one USPTO ex parte Appeal decision by its appeal number (e.g. "2024-001234") — the Board\'s decision on an applicant\'s appeal of an examiner rejection. Returns the decision type, issue date, outcome (affirmed / reversed / affirmed-in-part), issues and rules at play, and the decision document title + download link. Powered by the USPTO Open Data Portal (data.uspto.gov).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        appeal_number: {
          type: 'string',
          description: 'Ex parte appeal number, e.g. "2024-001234" (with or without an "Appeal" prefix).',
        },
        include_raw: {
          type: 'boolean',
          description: 'Optional, default false. When true, also return raw_sample: the UNMODIFIED raw record exactly as the upstream API returned it (no field renaming), to verify or correct this tool\'s field mapping.',
        },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: ['appeal_number'],
    },
  },
  {
    name: 'ptab_search_interferences',
    description:
      "Search USPTO patent Interference decisions — pre-AIA priority contests between competing applicants/patentees over who invented first. A SEPARATE docket from AIA trials and ex parte Appeals. Filter by `patent_number` (a patent or application involved in the contest), `party` (junior- or senior-party name, or either party's real party in interest), and/or free-text `query`. Returns the interference number, style (\"A v. B\"), declaration date, the junior and senior party (each with name, real party in interest, inventor, counsel, application/patent number, grant date), any additional parties, decision type/date and outcome, and the decision document link. Powered by the USPTO Open Data Portal (data.uspto.gov).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        patent_number: {
          type: 'string',
          description: 'Optional. Patent or application number involved in the interference.',
        },
        party: {
          type: 'string',
          description: 'Optional. Junior- or senior-party name in the priority contest.',
        },
        query: {
          type: 'string',
          description: 'Optional free-text keyword search across interference decision records.',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 25).',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0).',
        },
        include_raw: {
          type: 'boolean',
          description: 'Optional, default false. When true, also return raw_sample: one UNMODIFIED raw record exactly as the upstream API returned it (no field renaming), to verify or correct this tool\'s field mapping.',
        },
        _apiKey: { type: 'string', description: 'USPTO ODP API key.' },
      },
      required: [],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────

async function searchProceedings(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 10);
  const offset = clampOffset(args.offset);

  const parts: string[] = [];
  if (typeof args.query === 'string' && args.query.trim()) parts.push(args.query.trim());
  if (typeof args.patent_number === 'string' && args.patent_number.trim()) {
    parts.push(fieldClause('patentOwnerData.patentNumber', args.patent_number));
  }
  if (typeof args.party === 'string' && args.party.trim()) {
    const p = args.party.trim();
    parts.push(
      `(${fieldClause('regularPetitionerData.realPartyInInterestName', p)} OR ${fieldClause('patentOwnerData.patentOwnerName', p)})`,
    );
  }
  if (typeof args.trial_type === 'string' && args.trial_type.trim()) {
    parts.push(fieldClause('trialMetaData.trialTypeCode', args.trial_type.toUpperCase()));
  }
  if (typeof args.status === 'string' && args.status.trim()) {
    parts.push(fieldClause('trialMetaData.trialStatusCategory', args.status));
  }
  if (parts.length === 0) {
    throw new Error(
      'Pass at least one of: query, patent_number, party, trial_type, status.',
    );
  }
  const q = joinAnd(parts);

  const data = await ptabSearch(apiKey, '/proceedings/search', 'ptab_search_proceedings', q, offset, limit);
  const records = unwrap(data);
  return {
    query: q,
    total: data.count ?? records.length,
    returned: records.length,
    offset,
    proceedings: records.map(formatProceeding),
  };
}

async function searchDecisions(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 10);
  const offset = clampOffset(args.offset);

  const parts: string[] = [];
  if (typeof args.query === 'string' && args.query.trim()) parts.push(args.query.trim());
  if (typeof args.patent_number === 'string' && args.patent_number.trim()) {
    parts.push(fieldClause('patentOwnerData.patentNumber', args.patent_number));
  }
  if (typeof args.trial_type === 'string' && args.trial_type.trim()) {
    parts.push(fieldClause('trialMetaData.trialTypeCode', args.trial_type.toUpperCase()));
  }
  const after = typeof args.decided_after === 'string' ? args.decided_after.trim() : '';
  const before = typeof args.decided_before === 'string' ? args.decided_before.trim() : '';
  if (after || before) {
    const lo = after || '*';
    const hi = before || '*';
    parts.push(`trialMetaData.latestDecisionDate:[${lo} TO ${hi}]`);
  }
  if (parts.length === 0) {
    throw new Error(
      'Pass at least one of: query, patent_number, trial_type, decided_after/decided_before.',
    );
  }
  const q = joinAnd(parts);

  const data = await ptabSearch(apiKey, '/decisions/search', 'ptab_search_decisions', q, offset, limit);
  const records = unwrap(data);
  return {
    query: q,
    total: data.count ?? records.length,
    returned: records.length,
    offset,
    decisions: records.map(formatDecision),
  };
}

async function searchDocuments(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 25);
  const offset = clampOffset(args.offset);

  const parts: string[] = [];
  if (typeof args.proceeding_number === 'string' && args.proceeding_number.trim()) {
    parts.push(fieldClause('trialNumber', args.proceeding_number));
  }
  if (typeof args.query === 'string' && args.query.trim()) parts.push(args.query.trim());
  if (parts.length === 0) {
    throw new Error('Pass proceeding_number (e.g. "IPR2024-00001") and/or a free-text query.');
  }
  const q = joinAnd(parts);

  const data = await ptabSearch(apiKey, '/documents/search', 'ptab_search_documents', q, offset, limit);
  const records = unwrap(data);
  return {
    query: q,
    total: data.count ?? records.length,
    returned: records.length,
    offset,
    documents: records.map(formatDocument),
  };
}

async function proceedingTimeline(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const proceedingNumber = requiredText(args, 'proceeding_number').toUpperCase();
  if (!/^(IPR|PGR|CBM|DER)\d{4}-\d{5}$/.test(proceedingNumber)) {
    throw new Error('proceeding_number must look like IPR2024-00001');
  }
  const q = fieldClause('trialNumber', proceedingNumber);
  const [proceedingData, decisionData] = await Promise.all([
    ptabSearch(apiKey, '/proceedings/search', 'ptab_proceeding_timeline', q, 0, 1),
    ptabSearch(apiKey, '/decisions/search', 'ptab_proceeding_timeline', q, 0, 100),
  ]);
  const proceeding = unwrap(proceedingData)[0];
  const decisions = unwrap(decisionData);
  if (!proceeding && decisions.length === 0) {
    return { found: false, proceeding_number: proceedingNumber, message: 'No public PTAB proceeding or decision record matched.' };
  }
  const metadata = proceeding?.trialMetaData ?? decisions[0]?.trialMetaData ?? {};
  const events: Array<{ date: string; event: string; detail?: string | null; document_uri?: string | null }> = [];
  if (metadata.petitionFilingDate) events.push({ date: metadata.petitionFilingDate, event: 'petition_filed' });
  if (metadata.accordedFilingDate) events.push({ date: metadata.accordedFilingDate, event: 'filing_date_accorded' });
  for (const record of decisions) {
    const decision = formatDecision(record);
    if (decision.decision_issue_date) events.push({ date: decision.decision_issue_date, event: 'decision',
      detail: decision.trial_outcome ?? decision.decision_type ?? decision.document_title, document_uri: decision.document_uri });
  }
  if (metadata.terminationDate) events.push({ date: metadata.terminationDate, event: 'termination' });
  events.sort((a, b) => a.date.localeCompare(b.date));
  return {
    found: true, proceeding_number: proceedingNumber, proceeding: proceeding ? formatProceeding(proceeding) : null,
    decision_records: decisions.length, decisions_truncated: (decisionData.count ?? decisions.length) > decisions.length, timeline: events,
    scope_note: 'Timeline events come from public USPTO metadata and decision documents. Missing or delayed records should not be interpreted as proof that an event did not occur.',
  };
}

async function patentRiskProfile(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const patentNumber = requiredText(args, 'patent_number');
  const q = fieldClause('patentOwnerData.patentNumber', patentNumber);
  const [proceedingData, decisionData] = await Promise.all([
    ptabSearch(apiKey, '/proceedings/search', 'ptab_patent_risk_profile', q, 0, 100),
    ptabSearch(apiKey, '/decisions/search', 'ptab_patent_risk_profile', q, 0, 100),
  ]);
  const proceedings = unwrap(proceedingData);
  const decisions = unwrap(decisionData);
  return {
    patent_number: patentNumber,
    proceedings: { ...resultCoverage(proceedingData, proceedings), by_status: tally(proceedings.map((row) => row.trialMetaData?.trialStatusCategory)),
      by_trial_type: tally(proceedings.map((row) => row.trialMetaData?.trialTypeCode ?? row.trialTypeCode)),
      recent: proceedings.map(formatProceeding).sort((a, b) => String(b.petition_filing_date ?? '').localeCompare(String(a.petition_filing_date ?? ''))).slice(0, 25) },
    decisions: { ...resultCoverage(decisionData, decisions), by_outcome: tally(decisions.map((row) => row.decisionData?.trialOutcomeCategory)),
      by_decision_type: tally(decisions.map((row) => row.decisionData?.decisionTypeCategory)),
      recent: decisions.map(formatDecision).sort((a, b) => String(b.decision_issue_date ?? '').localeCompare(String(a.decision_issue_date ?? ''))).slice(0, 25) },
    // Zero rows is the usual outcome — most patents are never challenged — and it
    // is a real finding, not a failed lookup. Say so explicitly, and bound what it
    // means: PTAB is one forum, so silence here is not validity anywhere else.
    ...(proceedings.length === 0 && decisions.length === 0
      ? { finding: `No PTAB proceedings or decisions on record for patent ${patentNumber}. This patent has not been challenged at the PTAB. That is a real result, not a failed lookup — but PTAB is only one forum, so it says nothing about district-court litigation, ex parte reexamination, foreign oppositions, or the patent's validity.` }
      : {}),
    scope_note: 'PTAB records are proceeding- and document-level signals. This summary is not a patent-validity opinion, claim construction, litigation forecast, freedom-to-operate analysis, or legal advice.',
  };
}

async function partyExposure(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const party = requiredText(args, 'party');
  const q = partyClause(party);
  const [proceedingData, decisionData] = await Promise.all([
    ptabSearch(apiKey, '/proceedings/search', 'ptab_party_exposure', q, 0, 100),
    ptabSearch(apiKey, '/decisions/search', 'ptab_party_exposure', q, 0, 100),
  ]);
  const proceedings = unwrap(proceedingData);
  const decisions = unwrap(decisionData);
  const needle = party.toLowerCase();
  const petitionerRecords = proceedings.filter((row) => JSON.stringify(pickParty(row.regularPetitionerData)).toLowerCase().includes(needle));
  const ownerRecords = proceedings.filter((row) => JSON.stringify(pickParty(row.patentOwnerData)).toLowerCase().includes(needle));
  return {
    party_query: party, proceeding_coverage: resultCoverage(proceedingData, proceedings), decision_coverage: resultCoverage(decisionData, decisions),
    role_counts_in_analyzed_proceedings: { petitioner: petitionerRecords.length, patent_owner: ownerRecords.length },
    by_status: tally(proceedings.map((row) => row.trialMetaData?.trialStatusCategory)),
    by_trial_type: tally(proceedings.map((row) => row.trialMetaData?.trialTypeCode ?? row.trialTypeCode)),
    recorded_decision_outcomes: tally(decisions.map((row) => row.decisionData?.trialOutcomeCategory)),
    challenged_patents: tally(proceedings.map((row) => row.patentOwnerData?.patentNumber)).slice(0, 50),
    recent_proceedings: proceedings.map(formatProceeding).sort((a, b) => String(b.petition_filing_date ?? '').localeCompare(String(a.petition_filing_date ?? ''))).slice(0, 25),
    scope_note: 'USPTO party-name matching can combine affiliates, spelling variants, or similarly named entities. Counts are record-level and may be truncated; verify party identity and proceeding documents before drawing conclusions.',
  };
}

async function recentDecisions(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const days = Math.min(365, Math.max(1, Number(args.days) || 30));
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const parts = [`decisionData.decisionIssueDate:[${isoDate(from)} TO ${isoDate(to)}]`];
  if (args.trial_type) parts.push(fieldClause('trialMetaData.trialTypeCode', String(args.trial_type).toUpperCase()));
  if (args.patent_number) parts.push(fieldClause('patentOwnerData.patentNumber', String(args.patent_number)));
  if (args.party) parts.push(partyClause(String(args.party)));
  const limit = clampLimit(args.limit, 25);
  const q = joinAnd(parts);
  const data = await ptabSearch(apiKey, '/decisions/search', 'ptab_recent_decisions', q, 0, limit);
  const records = unwrap(data);
  return {
    window: { from: isoDate(from), to: isoDate(to) }, query: q, ...resultCoverage(data, records),
    by_outcome: tally(records.map((row) => row.decisionData?.trialOutcomeCategory)),
    by_trial_type: tally(records.map((row) => row.trialMetaData?.trialTypeCode ?? row.trialTypeCode)),
    decisions: records.map(formatDecision).sort((a, b) => String(b.decision_issue_date ?? '').localeCompare(String(a.decision_issue_date ?? ''))),
    scope_note: 'Outcome labels describe public USPTO document records and require proceeding context. They are not claim-by-claim validity conclusions or litigation forecasts.',
  };
}

// ── Appeals / Interferences implementations ─────────────────────────
//
// Deliberately NO hard regex on appeal_number/interference_number — the
// prior bug here was a hard trial-number regex (`^(IPR|PGR|CBM|DER)\d{4}-
// \d{5}$`) that rejected a valid ex parte appeal number as malformed because
// it only recognized AIA trial numbers. These accept any non-empty string
// (after stripping a leading "Appeal"/"Interference No." label and
// whitespace) and let the ODP search itself be the source of truth on
// validity, rather than re-encoding an assumed format client-side.

function normalizeAppealNumber(raw: string): string {
  return raw.trim().replace(/^appeal\s*/i, '').replace(/^no\.?\s*/i, '').trim();
}

function normalizeInterferenceNumber(raw: string): string {
  return raw.trim().replace(/^interference\s*(no\.?)?\s*/i, '').replace(/,/g, '').trim();
}

// OR several plausible field-name spellings together for one value, so a
// query still matches whichever field name ODP actually uses (see the
// unverified-schema note at the top of this file).
function anyFieldClause(fields: string[], value: string): string {
  return `(${fields.map((f) => fieldClause(f, value)).join(' OR ')})`;
}

// At most ONE raw record, completely unmodified — a cheap, bounded way to
// let a caller (or the next build pass) see the real upstream JSON shape
// instead of guessing field names again. Off by default; never included
// unless the caller explicitly asks.
function rawSample(records: GenericRecord[], includeRaw: unknown): Record<string, unknown> {
  return includeRaw === true && records.length > 0 ? { raw_sample: records[0] } : {};
}

async function searchAppeals(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 25);
  const offset = clampOffset(args.offset);

  const parts: string[] = [];
  if (typeof args.appeal_number === 'string' && args.appeal_number.trim()) {
    parts.push(anyFieldClause(['appealNumber', 'appealDocketNumber'], normalizeAppealNumber(args.appeal_number)));
  }
  if (typeof args.application_number === 'string' && args.application_number.trim()) {
    parts.push(fieldClause('applicationNumberText', args.application_number));
  }
  if (typeof args.query === 'string' && args.query.trim()) parts.push(args.query.trim());
  const after = typeof args.decided_after === 'string' ? args.decided_after.trim() : '';
  const before = typeof args.decided_before === 'string' ? args.decided_before.trim() : '';
  if (after || before) {
    parts.push(`decisionData.decisionIssueDate:[${after || '*'} TO ${before || '*'}]`);
  }
  if (parts.length === 0) {
    throw new Error('Pass at least one of: appeal_number, application_number, query, decided_after/decided_before.');
  }
  const q = joinAnd(parts);

  const raw = await ptabSearch(apiKey, '/decisions/search', 'ptab_search_appeals', q, offset, limit, APPEALS_BASE_URL);
  const data = raw as unknown as GenericSearchResponse;
  const records = unwrapLoud(data, ['patentAppealDataBag', 'patentAppealDecisionDataBag', 'appealDecisionDataBag'], 'ptab_search_appeals');
  return {
    query: q,
    // Outcome counts FIRST, records last (per the gap this tool closes).
    by_outcome: tally(records.map((r) => r.decisionData?.appealOutcomeCategory)),
    ...resultCoverage(data, records),
    appeals: records.map(formatAppeal),
    ...rawSample(records, args.include_raw),
    scope_note: 'Ex parte Appeals decisions are a separate USPTO docket from AIA trials (IPR/PGR/CBM/derivation) and from Interferences. Outcome labels require review in proceeding context.',
  };
}

async function getAppeal(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const appealNumber = normalizeAppealNumber(requiredText(args, 'appeal_number'));
  const q = anyFieldClause(['appealNumber', 'appealDocketNumber'], appealNumber);
  const raw = await ptabSearch(apiKey, '/decisions/search', 'ptab_appeal', q, 0, 5, APPEALS_BASE_URL);
  const data = raw as unknown as GenericSearchResponse;
  const records = unwrapLoud(data, ['patentAppealDataBag', 'patentAppealDecisionDataBag', 'appealDecisionDataBag'], 'ptab_appeal');
  if (records.length === 0) {
    return {
      found: false,
      appeal_number: appealNumber,
      message: 'No public ex parte Appeal decision matched this appeal number.',
    };
  }
  return {
    found: true,
    appeal_number: appealNumber,
    matches: records.length,
    decision: formatAppeal(records[0]),
    other_matches: records.slice(1).map(formatAppeal),
    ...rawSample(records, args.include_raw),
    scope_note: 'From the USPTO ex parte Appeals docket — an applicant\'s appeal of an examiner rejection, not an AIA trial (IPR/PGR/CBM/derivation) or Interference.',
  };
}

async function searchInterferences(args: Record<string, unknown>) {
  const apiKey = resolveApiKey(args);
  const limit = clampLimit(args.limit, 25);
  const offset = clampOffset(args.offset);

  // Field names confirmed live via include_raw (fleet #3306 follow-up,
  // 2026-10-18) — junior/senior party and patent/application number live
  // under juniorPartyData/seniorPartyData, not flat juniorPartyName etc.
  const parts: string[] = [];
  if (typeof args.patent_number === 'string' && args.patent_number.trim()) {
    const v = args.patent_number.trim();
    parts.push(
      anyFieldClause(
        ['juniorPartyData.patentNumber', 'seniorPartyData.patentNumber', 'juniorPartyData.applicationNumberText', 'seniorPartyData.applicationNumberText'],
        v,
      ),
    );
  }
  if (typeof args.party === 'string' && args.party.trim()) {
    const p = args.party.trim();
    parts.push(
      `(${anyFieldClause(
        [
          'juniorPartyData.patentOwnerName',
          'seniorPartyData.patentOwnerName',
          'juniorPartyData.realPartyInInterestName',
          'seniorPartyData.realPartyInInterestName',
          'interferenceMetaData.interferenceStyleName',
        ],
        p,
      )} OR ${esc(p)})`,
    );
  }
  if (typeof args.query === 'string' && args.query.trim()) parts.push(args.query.trim());
  if (parts.length === 0) {
    throw new Error('Pass at least one of: patent_number, party, query.');
  }
  const q = joinAnd(parts);

  const raw = await ptabSearch(apiKey, '/decisions/search', 'ptab_search_interferences', q, offset, limit, INTERFERENCES_BASE_URL);
  const data = raw as unknown as GenericSearchResponse;
  const records = unwrapLoud(data, ['patentInterferenceDataBag', 'interferenceDecisionDataBag'], 'ptab_search_interferences');
  return {
    query: q,
    ...resultCoverage(data, records),
    interferences: records.map(formatInterference),
    ...rawSample(records, args.include_raw),
    scope_note: 'Interferences are pre-AIA priority contests, a separate USPTO docket from AIA trials and ex parte Appeals. Junior/senior party labels follow USPTO\'s priority-contest convention (not seniority of counsel); verify party identity against the decision document.',
  };
}

// ── callTool router ──────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ptab_search_proceedings':
      return searchProceedings(args);
    case 'ptab_search_decisions':
      return searchDecisions(args);
    case 'ptab_search_documents':
      return searchDocuments(args);
    case 'ptab_proceeding_timeline':
      return proceedingTimeline(args);
    case 'ptab_patent_risk_profile':
      return patentRiskProfile(args);
    case 'ptab_party_exposure':
      return partyExposure(args);
    case 'ptab_recent_decisions':
      return recentDecisions(args);
    case 'ptab_search_appeals':
      return searchAppeals(args);
    case 'ptab_appeal':
      return getAppeal(args);
    case 'ptab_search_interferences':
      return searchInterferences(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
