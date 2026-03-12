---
"protoc-gen-es-string-descriptor": patch
---

Import runtime `fileDesc` from package root instead of `/runtime` subpath to fix `ERR_PACKAGE_PATH_NOT_EXPORTED` in CommonJS environments
