# Conversation message versions

An owner may start another version of a delivered personal message or an assistant reply. Each request records the selected input and its original run. The normal admission process starts the new execution after the conversation becomes idle. A fresh native session receives the selected input and preceding conversation context. Its worktree starts independently of the previous attempt's working directory.

Opening a version reads the corresponding reply and pull request. The action creates no run and changes no existing commit or publication. The confirmation before starting a version describes these effects. Historical runs that cannot establish an owner input for a reply cannot safely rerun that reply.

This implements the product direction in [#2258](https://github.com/alexj11324/Mikka/issues/2258) under [#2262](https://github.com/alexj11324/Mikka/issues/2262).
