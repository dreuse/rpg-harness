# I01 Importer formats and provenance

Package: `@rpg/imports` (`packages/imports`). No dependencies. Pure types and functions.

## Formats

| Format | Extensions | Content check |
|---|---|---|
| pdf | `.pdf` | starts with `%PDF-` |
| docx | `.docx` | starts with ZIP magic `PK\x03\x04` |
| text | `.txt` | no NUL byte in leading bytes |
| markdown | `.md`, `.markdown` | no NUL byte in leading bytes |
| yaml | `.yaml`, `.yml` | no NUL byte in leading bytes |
| json | `.json` | no NUL byte in leading bytes |

Size cap: `MAX_IMPORT_BYTES` (50 MiB). Images and scans go through the separate vision fallback.

## Journey

Stages: `stage`, `extract`, `interpret`, `compile`, `validate`, `review`, `activate`.
States per stage: `pending`, `running`, `succeeded`, `failed`.

## Failures

| Failure | Stage | Formats |
|---|---|---|
| unsupported_format | stage | all |
| mime_mismatch | stage | all |
| size_cap_exceeded | stage | all |
| unsafe_path | stage | all |
| duplicate | stage | all |
| extraction_failed | extract | pdf, docx, text, markdown |
| encrypted | extract | pdf, docx |
| scanned_needs_vision | extract | pdf |
| malformed_structure | extract | yaml, json |
| unsafe_archive_entry | extract | docx |
| archive_size_exceeded | extract | docx |
| low_confidence | interpret | all |
| compile_failed | compile | all |
| validation_failed | validate | all |
| rejected_by_user | review | all |

`withFailure` requires all earlier stages to be `succeeded`.
A file name must have a non-empty stem and an extension. A name is unsafe if it is `..`, or has `/`, `\`, `:` or control characters.
A size that is not a safe non-negative integer counts as `size_cap_exceeded`.

Every failure leaves campaign state unchanged (`ImportRejected`).

## Out of scope (staging code, I02)

- Path resolution under the import root and symlink rejection.
- Real byte counting.
- Archive unpacking limits: no symlink, `..` or absolute entries, cap on total extracted size.

## Provenance

| Field | Rule |
|---|---|
| sourceHash | lowercase sha256 hex of the original file |
| fileName | base name only |
| format | one of the formats above |
| locator | `{ kind: 'unknown' }` or `{ kind: 'known', page?, section?, title? }` with at least one field |
| quality | `high`, `medium`, `low`, `unknown` |

A missing page or section is never invented. Use the unknown locator.

## Untrusted content

`UntrustedContent` holds `text` and `provenance` only. It has no grant, execute or tool field.
`interpretImported` returns `ImportedData` with empty `toolCalls` and `permissions` for any text.
