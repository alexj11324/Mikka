# Figma connects through Composio, not Figma's official MCP

- Date: 2026-10-31
- Source: Alex, after hearing that Figma's remote MCP only lets clients on its approved list connect (Mikka is not on that list) and that it needs OAuth: 「就算了，还是用composio」
- Rule: —
- Replaces: —

Figma is one of the Composio apps in the 插件 store. Bots use the tools
Composio lists for it: reading files, nodes, images and comments, plus a few
writes: comments and reactions, variables, dev resources and webhook
updates. Writes follow the same rule as other app writes, so only destructive
calls ask first. Figma's REST API cannot draw or edit the canvas, so Bots cannot
create or change designs. Mikka does not apply to Figma's MCP list and does not
add OAuth for personal MCP servers for this.
