// i18n-ignore-file: model prompt text and its examples, not UI copy.
/**
 * Coordinator prompt options for OpenUI's own generateSystemPrompt
 * (scripts/generate-agent-ui-prompt.mjs → lib/coordinator-ui-prompt.json).
 * OpenUI writes the syntax, component, action, streaming and verification
 * sections from the component library; this file only holds what differs for
 * the Coordinator: a reply may be Markdown or OpenUI, and a few host rules.
 */

/** Replaces OpenUI's "entire response must be openui-lang" preamble: Mikka renders either. */
export const COORDINATOR_PRESENTATION_PREAMBLE = `Presentation:

Mikka renders a reply whose first line is \`root = Stack(...)\` as OpenUI Lang, a declarative UI language, and any other reply as Markdown. Choose by the shape of the content, not its length:
- Conversation, a short answer, a confirmation, a status update or a question back: plain text.
- Several places, sights, hotels, restaurants or products, recommended or listed: OpenUI, a BeCardGrid of BeImageCard, one card per item, with TextContent before or after for anything the cards do not say.
- A history, timeline or anything in periods or stages: OpenUI, Steps with one StepsItem per period or stage, with TextContent around it for the narrative.
- A comparison of options or attributes: BeTable. Numbers across categories: BarChart; over time: LineChart. Figures: BeStat. A takeaway: BeAlert.
In an OpenUI reply all prose goes in TextContent (Markdown is allowed inside its string); nothing is written outside OpenUI statements.`

/** Kept short: OpenUI's generated sections already cover syntax, hoisting, streaming and verification. */
export const COORDINATOR_PRESENTATION_RULES = [
  'Begin with root = Stack([intro, section1, ...]); then define referenced sections in reading order, cards one at a time and each FormControl separately so content streams progressively.',
  'Use positional arguments and JSON double-quoted strings with escaped newlines, quotes and backslashes. Never draw an interface as ASCII art or inside a code block; no outer code fences, HTML or React.',
  'Use BeStat for figures, BeTable for rows, Tag for status (a Tag that names a thing, not a state, is neutral; colour carries meaning only), BarChart for comparisons, rankings as BarChart with horizontal true, LineChart for trends, AreaChart for stacked totals, DonutChart for shares (outcome slices carry their status), RadialChart for used versus a limit, Steps for milestones and periods, and BeAlert for a takeaway. For visual recommendations of sights, places or hotels, default to BeCardGrid with BeImageCard.',
  'To review a batch before acting, put EditableTable in a FormControl in a Form, with Buttons and a Button whose @ToAssistant supplies the full context; edited rows return with the reply. Do not nest Form. Buttons, forms and suggestion approvals continue the chat; an account write follows the connection\'s permission and the host\'s policy, and asks only when the host reports it needs approval. No Query/Mutation toolProvider is supplied to the UI: do not emit Query, Mutation or @Run, invent tool results, execution state or permissions, or request passwords or secrets.',
  'Card blocks need at least two consistently structured items. Text, BoldText, IconText, ImageText, ImageTextLarge, MetricIndicatorInline and MetricIndicatorWithStrikethrough belong inside card items, never directly in Stack or BeCard. EntityList size="small" belongs only in CompositeCardItem; otherwise use size="default". Pass a category to Icon.',
  'Image URLs must come from the user or a real tool result; never invent or template them. BeImageCard and BeImage use the host\'s real-image keyword lookup instead of URLs. Use only user/tool data for figures; label sample data in the person\'s language only when requested.',
]

/** One example per shape the defaults name; the topics differ from the cases in coordinator-presentation.test.ts. */
export const COORDINATOR_PRESENTATION_EXAMPLES = [
  `root = Stack([intro, cards, tips])
intro = TextContent("杭州值得去的三处：湖、寺和老街。")
cards = BeCardGrid([lake, temple, street])
lake = BeImageCard("西湖", "West Lake Hangzhou", "环湖步行或骑行，苏堤、白堤和断桥是经典路线，傍晚看湖景最好。", ["湖景", "步行"])
temple = BeImageCard("灵隐寺", "Lingyin Temple Hangzhou", "千年古刹，飞来峰石窟造像就在入口旁，上午人少。", ["古刹", "石窟"])
street = BeImageCard("河坊街", "Hefang Street Hangzhou", "保留清末街巷格局的步行街，适合晚上逛吃。", ["老街", "小吃"])
tips = TextContent("西湖和灵隐寺相距不远，可以排在同一天。")`,
  `root = Stack([intro, periods, today])
intro = TextContent("西安建城三千多年，十三个王朝在此建都。")
periods = Steps([zhou, qin, tang, ming])
zhou = StepsItem("西周 · 丰镐", "约公元前 11 世纪，周文王、武王在沣河两岸建丰京和镐京。")
qin = StepsItem("秦汉 · 咸阳与长安", "秦都咸阳；汉高祖在渭河南岸建长安城，成为丝绸之路起点。")
tang = StepsItem("隋唐 · 长安", "隋建大兴城，唐改称长安，人口逾百万，是当时世界最大的城市之一。")
ming = StepsItem("明清 · 西安府", "明洪武年间改名西安，修建了今天保存完整的城墙。")
today = TextContent("今天的西安是陕西省会，城墙、钟鼓楼和大雁塔仍在城中。")`,
]
