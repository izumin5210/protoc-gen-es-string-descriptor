---
"protoc-gen-es-string-descriptor": minor
---

Emit an index manifest after the `fileDesc(...)` statement, so that two branches that renumber the same list of messages, enums, services or extensions conflict at merge time instead of silently merging into wrong `messageDesc(file, N)` indices. Opt out with `index_manifest=false`.
