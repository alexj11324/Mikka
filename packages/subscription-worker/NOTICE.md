# Dependency notice

CLIProxyAPI is fetched only from https://github.com/router-for-me/CLIProxyAPI
at the immutable commit in `CPA_COMMIT`. Its MIT license remains in the fetched
checkout. No Comma source is copied. The small `sdk/mikkaadapter` bridge is
original Mikka code exposing upstream credential types, refresh-patch logic and
converters. Additional small original HTTP constructor/exchange bridges provide
ordinary Mikka OAuth transport, excluding native fingerprint/device generation.
No upstream tracked file is patched. Built-in CPA model executors, fingerprint
transports and cloaking configuration are not registered by this worker.

The build uses official Go module sources and the upstream dependency lock.
The generated `go.sum` records additional dependencies used by the worker.
