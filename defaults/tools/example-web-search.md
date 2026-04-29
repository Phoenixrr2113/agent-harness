---
id: example-web-search
tags: [tool, example, web-search]
author: human
status: draft
related:
  - research
---

<!-- L0: Example HTTP tool definition for a fictional web search API. Copy and adapt for real services. -->
<!-- L1: Shows the shape of a markdown tool spec: auth via environment variable, a single GET operation
     with typed parameters, and a usage example. Replace the fictional endpoint with a real one. -->

# Tool: Example Web Search (template)

This is a **template** tool definition. Its status is `example`, so validators and loaders
will recognize it as non-executable scaffolding. Copy this file to `tools/<your-tool>.md`,
change the status to `active`, and point it at a real service.

## Authentication

Set the API key in your environment:

```bash
export WEB_SEARCH_API_KEY="your-key-here"
```

The tool reads `WEB_SEARCH_API_KEY` at call time. Never hardcode keys in this file.

## Operations

### search

**Method:** `GET`
**URL:** `https://api.example.com/v1/search`
**Headers:** `Authorization: Bearer $WEB_SEARCH_API_KEY`

**Query parameters:**
- `q` (string, required) — search query
- `limit` (integer, optional, default 10) — max results, 1-50
- `lang` (string, optional, default "en") — ISO 639-1 code

**Response:** JSON with `results: [{title, url, snippet}]`

## Example call

```bash
curl -H "Authorization: Bearer $WEB_SEARCH_API_KEY" \
  "https://api.example.com/v1/search?q=climate+change&limit=5"
```

## Notes

- Rate limit: 100 requests / minute (fictional).
- This endpoint does not exist. Swap it for a real provider (Brave, Tavily, Serper, etc.)
  before marking the tool `active`.

Related: [research]
