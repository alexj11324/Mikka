# #1505 原只读 child 交接原件

Run [42576948008/1](https://github.com/alexj11324/Mikka/actions/runs/42576948008) 使用精确 source af78045a57d58516fbfe5604255251a91faeb6ed；五个原 helper 未改。先从原 artifact 校验旧 receipt，精确撤销旧 token（DELETE 204）并断开匹配连接，再建立同一仓库 metadata/contents 只读 child，正常仓库读取及 Owner 未变检查均通过。

新原始 receipt 为1691字节，SHA256 f81a81a6e668f45daa01af217fba5e5bf294888e969c25c5efa4323507f47d26。应用连接期限2026-11-09T11:05:19.063Z，provider期限2026-11-09T15:05:26.000Z。旧03:00 receipt已经用于清理旧child，不能用于后续新行。

原job log唯一读取，389026B，SHA256 d92eb13a46e014a0f437622a0a2abe080c4e4e32454501996cf8765b09f0f80a；其中appClientId被平台mask，未补写日志。此处receipt来自实际下载并核验的artifact ZIP，不是从masked log重构。原ZIP1920B，SHA256 f8dce5e9dba3d6ef461616dcb0c36f70e7ce1a16b08fb8d48e404586721fbfd9，含三份原始JSON。

07:07是source、凭据前及cleanup前的入场截止，cleanup和prepare之间没有再查时钟，并非全操作终止器；这项源码局限保留。本次cleanup实际07:05:20.859–22.383、prepare实际07:05:23.964–30.326，全部早于截止。

操作入口已关闭至286ae62b4a5c3147bc99452973584637ca310464（if:false/GO空），closure run42577319322 skipped。仅用于取得artifact字节的临时VM运行104642ms，07:10:24.329 UTC stopped并GET确认；未创建业务VM或运行模型。新正式六例仍0，历史失败保持。
