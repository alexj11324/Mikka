# Thread execution identity — PR #1199 visual evidence

Fixed source: `bd1699ed88eb35006328ce8edae94bbbb2985c47`; tree `82beb11639f095263916dc105bd78bead3df9deb`.

`pnpm build` exited 0 on the fixed clean source. Normal TestAccountPool owner/peer authentication and HTTP checks returned owner 200 with exact frozen workspace/payer references, peer 404, and legacy 200 with null identity/unknown credential. All three lease-registered synthetic fixture rows were removed; the successful scope released normally. The owned Next server and browser were stopped. No model, third-party MCP, or subscription provider was called.

The five images are screenshots of the local production build at 1440 and 390 pixels, in English and Chinese, light and dark themes. Both the implementation agent and root independently inspected all five with no clipping/overflow defect found. PNG filenames in the unmodified `review.json` map to the same-basename WebP files; `provenance.json` records the format conversion without cropping or redaction and exact file hashes.

These stopped run records are explicitly synthetic visual fixtures. They demonstrate the frozen-record presentation and owner API boundary. They do not prove that an official subscription was actually used. Root will inspect the actual Primary production run IDs/stages separately.

An earlier normal initialization attempt failed at the landing page because the temporary Next server hostname differed from its localhost auth origin. It created no run fixtures; its account isolation was preserved. Starting the same build with matching `--hostname localhost` produced the ordinary 200 landing and the successful capture above. No product source, manifest, permissions, or account guard was changed to obtain the result.
