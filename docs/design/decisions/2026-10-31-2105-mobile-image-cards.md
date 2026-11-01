# Image cards draw natively in the iOS app

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator: 「我们不是有图片显示吗？但在网页端能够显示，手机端却无法正常显示」; 「不要过度设计」
- Rule: —
- Replaces: —

The iOS app draws the Coordinator's image cards (`BeCardGrid`,
`BeImageCard`, `BeImage`) itself instead of showing their words and
「在网页上打开」. The props and content order are the web's: picture, title,
description, tags, and 继续了解 sending the card's prompt. Pictures come from
the same server lookup (`GET /api/agent/images`, Wikimedia Commons) with the
same query rule. While looking the picture's place is grey; with no picture
or a failed lookup the card shows without one. The credit opens the picture's
Commons page. A grid is one column on a phone. It uses only React Native's
`Image`, so it ships as an over-the-air update.
