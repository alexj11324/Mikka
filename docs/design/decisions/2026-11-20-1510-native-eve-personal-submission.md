# Native Eve is the personal chat submission interface

Alex approved this decision on 2026-11-20. The Web, Desktop, and mobile clients send personal chat messages through authenticated Eve sessions. Each explicitly submitted message goes to its selected Bot. A receipt means Eve admitted the message.

Retire the older personal send routes and the desktop RPC send action. Those routes could acknowledge an inbox write while a different Bot’s background judgments delayed delivery. Pending events and conversation history still use their existing storage and recovery.

See the [personal submission contract](../../backend/personal-submission-contract.md) for the route, request identity, and retry behavior.
