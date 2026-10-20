# 教训记录

## 2026-10-20 调研需要登录的线上应用时，别在登录墙前停下

**发生了什么**：要分析 app.comma.surf 的真实字体，用 chrome-devtools MCP 打开却只看到登录页。
我先去猜「MCP 的 profile 是全新的所以没登录」，又绕去扒 JS bundle 找 class 名，
被用户纠正：**直接复制浏览器 profile**。

**两个真正的坑**：

1. **先确认用户在哪个浏览器里登录的**。我默认是 Chrome，把
   `~/Library/Application Support/Google/Chrome` 全翻了一遍也没有 comma.surf 的 cookie。
   实际是 **Brave**（`~/Library/Application Support/BraveSoftware/Brave-Browser`）。
   截图里的浏览器不等于 Chrome —— `ps aux | grep -iE "Brave|Chrome|Arc|Edge"` 先看一眼。

2. **chrome-devtools MCP 启动的 Chrome 带 `--use-mock-keychain`**，
   读不了真实钥匙串里的 cookie 解密密钥，所以**复制 cookie 文件进 MCP 的 profile 没用**。
   必须自己起一个不带该参数的实例，且**用同一个浏览器**（Brave 的 cookie 要用
   "Brave Safe Storage" 钥匙串项解密，换 Chrome 起也解不开）。

**可复用的做法**：

```bash
# 1. 复制 profile（只拷 cookie 与存储，别拷整个目录）
DST=/tmp/xxx-prof; mkdir -p "$DST/Default"
cp "$SRC/Local State" "$DST/"
cp "$SRC/Default/Cookies" "$DST/Default/"
cp -R "$SRC/Default/Local Storage" "$DST/Default/"

# 2. 用原浏览器 + 调试端口起一个独立实例（不带 --use-mock-keychain）
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --user-data-dir="$DST" --remote-debugging-port=9333 \
  "--remote-allow-origins=*" --no-first-run --disable-sync --disable-extensions
```

**收尾**：拷出来的 profile 含用户**全站 cookie**，用完必须删掉
（`rm -rf /tmp/xxx-prof`，以及 MCP profile 里那份）。`pkill` 时务必带上
`user-data-dir=` 精确匹配，别误杀用户自己开着的浏览器。

**顺带**：查「实际渲染字体的物理文件名」不要靠 `getComputedStyle().fontFamily`
（那只是声明的字体栈），要用 CDP 的 **`CSS.getPlatformFontsForNode`**。
调用前必须先 `DOM.getDocument` 填充节点表，否则报 "Could not find node with given id"。

---

## 2026-10-20 不要用一个窗口的查询结果去概括整体状态

**发生了什么**：我说「CI 从来没跑起来过，GitHub Actions 因账单全停」，
并把这个结论写进了 PR #3 的描述。用户反问「怎么可能，我已经公开仓库了呀」。

**真相**：仓库是 public，CI 完全正常，账单问题只在 21:44–22:51 卡了一段。
我跑的是 `gh run list --limit 8`，那 8 条**恰好全落在故障窗口内**，
于是我把「这 8 条失败」当成了「从来都是失败」。

**规则**：

1. **说「一直」「从来」「总是」之前，必须拉全量历史再下结论**。
   `gh run list --limit N` 的 N 是个陷阱 —— 先看时间跨度够不够，
   或者直接按结论分组统计：`--json conclusion --jq 'group_by(.conclusion)[] | ...'`。
   本次只要跑一句 `group_by` 就能看到「success: 9 次」，立刻发现结论错了。
2. **临时性故障不要写成系统性故障**。看到 billing/quota/rate-limit 这类错误，
   先看时间分布：如果前后都有成功的运行，那是临时抖动，不是坏掉。
3. **错误结论一旦写进 PR 描述 / commit message，就进了仓库历史**，
   发现后要主动去改（`gh pr edit <n> --body`），不能只在对话里更正。

**为什么容易犯**：`gh run list` 默认按时间倒序，最新的一批最显眼。
故障窗口通常就在最近，所以「最近的都失败」会强烈暗示「一直失败」。
这是个采样偏差，不是数据问题。

