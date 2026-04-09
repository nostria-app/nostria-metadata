# Nostria Metadata

API to retrieve Profile or Post in JSON to be utilized in metadata (Social Sharing Preview).

Implements the usage of Relay List to ensure scaling. Relies on Discovery Relay to fetch the Relay List.

## Endpoints

### `GET /og?url=https://example.com`

Returns extracted OpenGraph metadata as JSON.

### `GET /markdown?url=https://example.com`

Returns an AI-friendly Markdown document as `text/markdown`.

Use `content=false` to skip extracting page body content and return metadata-only Markdown:

`GET /markdown?url=https://example.com&content=false`

The response includes:

- the page title and description
- the resolved URL and available OpenGraph image metadata
- best-effort extraction of the main page content, formatted as Markdown, unless `content=false`

