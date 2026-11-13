# Conversation directory and unread states (#2252, #2254)

Official public build `dafe89a3d7879c59676bd590876cb55f5d3f8acd` and private overlay `ce5a2bb877f63555b4501025db7cea2b1c37a226`. The renderer hash is in [manifest.json](manifest.json).

A disposable PostgreSQL 17 workspace contained two completed conversations. A local Better Auth session opened the official Web build with the source API. The directory showed both conversations unread and the Bot count was 2. “Mark all as read” cleared both. “Mark as unread” on one conversation changed both the Bot and its child to 1. Opening the thread at its end sent the durable read acknowledgement. Returning to the directory confirmed the marker had cleared in all four viewports and themes. The API returned HTTP 200 for all twelve mutations. Mobile here is the 390×844 Web viewport.

| Desktop 1440×900 | Mobile Web 390×844 |
| --- | --- |
| ![Light desktop](reads-desktop-light.png) | ![Light mobile](reads-mobile-light.png) |
| ![Dark desktop](reads-desktop-dark.png) | ![Dark mobile](reads-mobile-dark.png) |
