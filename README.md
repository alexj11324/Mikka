# Conversation header acceptance for #2255

On 2026-11-14 from 18:03:43.643 through 18:05:02.495 UTC, two independently signed-in synthetic accounts exercised the original official UI and the packaged Nitro application on isolated Linux with PostgreSQL 17.11.

| Component | Revision |
| --- | --- |
| Public #2270, official Web/Nitro | 27dda384f9073a4662ec4fa0f0cf28a29d50d586 |
| Private #134, official Web | 6896edea131d398945aa06a4d858d09eeb3b10d7 |
| Independent Eve process | 47018c30259c2f7b9e024277d923ae8e89ef128e |

The public recorded renderer fingerprint, packaged independently verified manifest, operating versions, screenshot hashes, and exact per-scenario UTC times are in receipt.json. The official Web build checked 184 actions and 251 exports. The official Nitro bundler completed the server graph in 387857 ms. Its first finalization found the checkout had no ffmpeg binary. After restoring the locked ffmpeg-static executable, the same official finalizer packaged that graph and 61 resources. The normal application launcher validated the packaged release and became ready in 6821 ms. The served version endpoint returned the public and overlay commits above. Chromium communicated directly with the production Web/Nitro process over loopback.

In each of four browser states the owner renamed a conversation, reloaded its saved title, pinned, unpinned, archived, and restored it. UI actions and corresponding PostgreSQL state were checked. The second signed-in account was denied the owner operation. The browser also exercised a regeneration request with no model grant. The response reported regenerated=false, the existing manual title survived, and the UI displayed the expected failure notice captured in the screenshots.

The independent Eve service returned its real healthy/ready response. The separate attempt to package Eve at the public commit above was killed during bundling. No model response or model-generated title was observed. The 390 × 844 screenshots are mobile Chromium viewport checks. Native iPhone and desktop application acceptance, post-merge verification and production are still pending. All captured data is synthetic.
