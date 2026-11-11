# Native task MCP settings

Captured from the complete local production build `5463aa49c8effe1455900a240b79f2558750c1bd`, with official UI overlay `0a6e897`, Chromium 154.0.8037.57 and a 1440 × 1000 viewport. The runtime used the cloud edition on `http://127.0.0.1:3000/mikka` and a disposable local PostgreSQL 17 database. Ordinary email sign-up/sign-in supplied a leased test account; mail stayed in a local SMTP sink.

- [HTTP, light](http-light-1440.png): server URL, two headers, add/remove rows, cancel.
- [STDIO, dark](stdio-dark-1440.png): command, one argument per line, working directory, environment, add/remove rows, cancel.

The fields contain illustrative configuration. Values are masked in the UI. No MCP configuration was saved and no model message was submitted. The owning agent reviewed both images: controls fit without clipping or overflow and there were no JavaScript exceptions. An existing avatar asset returned 404.

These images verify the settings UI. They do not establish provider execution, native chat success or production deployment. Separate API/CLI evidence covers those flows.
