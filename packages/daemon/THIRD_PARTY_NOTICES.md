# Third-party notices

## codeburn

The subscription-quota readers under `packages/daemon/src/quota/`
(`claude.ts`, `codex.ts`, `cursor.ts`, `files.ts`, and the usage-response
parsing in `parse.ts`) are adapted from
[codeburn](https://github.com/getagentseal/codeburn), Copyright (c) 2026
AgentSeal, licensed under the MIT License below.

The port is read-only. codeburn can refresh a Codex token and write
`~/.codex/auth.json`; Mikka does not. See `docs/adr/0027-local-credential-quota.md`.

```
MIT License

Copyright (c) 2026 AgentSeal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CUA standalone driver

Mikka's optional local/isolated computer adapter invokes the standalone
[cua-driver-rs 0.38.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)
from CUA. Its Rust workspace declares MIT at upstream revision
`85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`; the copyright and license below
are reproduced from that revision's `LICENSE.md`. Mikka does not install
`cua-perception`, OmniParser, Cua Spaces or `cua-spacesd`. The daemon npm
package contains the adapter and this notice; users/isolated CI supply the
separate driver binary. No CUA source is represented as Mikka-owned code.

```text
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
