# mcp-uspto-ptab

USPTO PTAB Trials MCP — wraps the USPTO Open Data Portal (ODP) PTAB Trials API

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `ptab_search_proceedings` | Search USPTO PTAB trial proceedings — patent litigation before the Patent Trial and Appeal Board (inter partes review / IPR, post-grant review / PGR, covered-business-method / CBM, derivation). Returns trial number, type, status, the challenged patent, petitioner, patent owner, and key dates (petition filing, institution decision, latest decision, termination). Filter by free-text `query`, `patent_number` (the patent being challenged), `party` (petitioner or patent-owner real-party name), `trial_type` (IPR/PGR/CBM/DER), and/or `status`. Powered by the USPTO Open Data Portal (data.uspto.gov). |
| `ptab_search_decisions` | Search USPTO PTAB decision documents — institution decisions and final written decisions issued in IPR/PGR/CBM trials, plus appeal outcomes. Returns the trial number, decision type, issue date, trial/appeal outcome, the issue types and statutes/rules at play, and the decision document title + download URI. Filter by free-text `query`, `patent_number`, `trial_type`, and a `decided_after`/`decided_before` date range. Powered by the USPTO Open Data Portal (data.uspto.gov). |
| `ptab_search_documents` | Search USPTO PTAB filings and documents within trial proceedings — petitions, patent-owner responses, expert declarations, exhibits, motions, and briefs. Pass `proceeding_number` (the trial number, e.g. "IPR2024-00001") to list every document filed in a proceeding, and/or `query` for free-text search. Returns document name/title, type, filing date, filing party, size, and download URI. Powered by the USPTO Open Data Portal (data.uspto.gov). |
| `ptab_proceeding_timeline` | Build a chronological PTAB proceeding timeline from the proceeding record and its public decision documents. Returns institution, final-written-decision, rehearing, settlement, dismissal, and other recorded decision events; absence of an event is not proof that it never occurred. |
| `ptab_patent_risk_profile` | Summarize PTAB proceedings and recorded decision outcomes for one challenged patent. Reports status/outcome counts and recent matters for review routing; it is not a validity opinion, litigation forecast, freedom-to-operate analysis, or claim-level legal conclusion. |
| `ptab_party_exposure` | Summarize PTAB proceeding exposure for a petitioner or patent owner, including roles, challenged patents, statuses, trial types, and recorded outcomes. Party matching follows USPTO indexed names and may combine similarly named entities; verify identity before relying on totals. |
| `ptab_recent_decisions` | Return and summarize recently issued public PTAB trial decisions, optionally filtered by trial type, patent, or party. Outcome labels describe the document-level USPTO record and require review in proceeding context; they are not claim-by-claim legal conclusions. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "uspto-ptab": {
      "url": "https://gateway.pipeworx.io/uspto-ptab/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/uspto-ptab/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "uspto-ptab": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-uspto-ptab"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-uspto-ptab
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Uspto Ptab data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
