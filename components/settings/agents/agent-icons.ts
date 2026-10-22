// i18n-ignore-file: the Chinese words below are search keywords for the avatar picker, not copy shown on screen.
import {
  BookOpen, Bot, Brain, Braces, Briefcase, Bug, Calculator, Camera, ChartLine, Cloud, Code, Coffee, Compass, Cpu, Database,
  Eye, FileText, Flag, FlaskConical, Gauge, GitBranch, GitPullRequest, Globe, Hammer, Headset, Heart, Languages, Layers, Leaf,
  Lightbulb, ListChecks, LockKeyhole, Mail, Map as MapIcon, Megaphone, MessageSquare, Network, NotebookPen, Package, Palette, PanelsTopLeft,
  PenLine, Puzzle, Receipt, RefreshCcw, Rocket, Scale, Search, Server, ShieldAlert, ShieldCheck, Sparkles, Star, Target,
  Telescope, Terminal, TestTube, Workflow, Wrench, Zap, type LucideIcon,
} from 'lucide-react'
import type { AgentColor, AgentRole } from '@/lib/agent-roles'

export type IconCategory = 'work' | 'code' | 'writing' | 'quality'

/** Icons the avatar picker offers. `keywords` feed the picker's search, in both languages. */
export const AGENT_ICONS: { id: string; icon: LucideIcon; category: IconCategory; keywords: string }[] = [
  { id: 'bot', icon: Bot, category: 'work', keywords: 'bot robot agent 机器人' },
  { id: 'sparkles', icon: Sparkles, category: 'work', keywords: 'sparkles ai magic 魔法 星' },
  { id: 'brain', icon: Brain, category: 'work', keywords: 'brain think 思考 大脑' },
  { id: 'workflow', icon: Workflow, category: 'work', keywords: 'workflow plan coordinate 流程 协调' },
  { id: 'target', icon: Target, category: 'work', keywords: 'target goal 目标' },
  { id: 'rocket', icon: Rocket, category: 'work', keywords: 'rocket launch ship 发布 火箭' },
  { id: 'compass', icon: Compass, category: 'work', keywords: 'compass explore 探索 方向' },
  { id: 'lightbulb', icon: Lightbulb, category: 'work', keywords: 'idea lightbulb 想法 灵感' },
  { id: 'flag', icon: Flag, category: 'work', keywords: 'flag milestone 里程碑 旗' },
  { id: 'briefcase', icon: Briefcase, category: 'work', keywords: 'briefcase business 商务 工作' },
  { id: 'megaphone', icon: Megaphone, category: 'work', keywords: 'megaphone marketing announce 市场 公告' },
  { id: 'headset', icon: Headset, category: 'work', keywords: 'support headset 客服 支持' },
  { id: 'calculator', icon: Calculator, category: 'work', keywords: 'calculator finance 财务 计算' },
  { id: 'globe', icon: Globe, category: 'work', keywords: 'globe web world 网页 全球' },
  { id: 'zap', icon: Zap, category: 'work', keywords: 'zap fast 快 闪电' },
  { id: 'coffee', icon: Coffee, category: 'work', keywords: 'coffee 咖啡' },
  { id: 'code', icon: Code, category: 'code', keywords: 'code develop 代码 开发' },
  { id: 'terminal', icon: Terminal, category: 'code', keywords: 'terminal shell cli 终端 命令行' },
  { id: 'braces', icon: Braces, category: 'code', keywords: 'braces json api 接口' },
  { id: 'git-branch', icon: GitBranch, category: 'code', keywords: 'git branch 分支' },
  { id: 'git-pull-request', icon: GitPullRequest, category: 'code', keywords: 'pull request pr merge 合并' },
  { id: 'bug', icon: Bug, category: 'code', keywords: 'bug debug 缺陷 调试' },
  { id: 'database', icon: Database, category: 'code', keywords: 'database sql data 数据库 数据' },
  { id: 'server', icon: Server, category: 'code', keywords: 'server backend ops 服务器 后端 运维' },
  { id: 'cpu', icon: Cpu, category: 'code', keywords: 'cpu performance 性能 芯片' },
  { id: 'network', icon: Network, category: 'code', keywords: 'network infra 网络 架构' },
  { id: 'cloud', icon: Cloud, category: 'code', keywords: 'cloud deploy 云 部署' },
  { id: 'package', icon: Package, category: 'code', keywords: 'package dependency release 依赖 包' },
  { id: 'panels-top-left', icon: PanelsTopLeft, category: 'code', keywords: 'frontend layout ui 前端 页面 布局' },
  { id: 'palette', icon: Palette, category: 'code', keywords: 'palette design 设计 颜色' },
  { id: 'layers', icon: Layers, category: 'code', keywords: 'layers stack 层 架构' },
  { id: 'puzzle', icon: Puzzle, category: 'code', keywords: 'puzzle plugin integration 插件 集成' },
  { id: 'file-text', icon: FileText, category: 'writing', keywords: 'doc document file 文档 文件' },
  { id: 'book-open', icon: BookOpen, category: 'writing', keywords: 'book docs guide 书 指南' },
  { id: 'pen-line', icon: PenLine, category: 'writing', keywords: 'write pen edit 写作 编辑' },
  { id: 'notebook-pen', icon: NotebookPen, category: 'writing', keywords: 'notes notebook 笔记' },
  { id: 'languages', icon: Languages, category: 'writing', keywords: 'translate language i18n 翻译 语言' },
  { id: 'message-square', icon: MessageSquare, category: 'writing', keywords: 'message chat reply 消息 回复' },
  { id: 'mail', icon: Mail, category: 'writing', keywords: 'mail email 邮件' },
  { id: 'map', icon: MapIcon, category: 'writing', keywords: 'map plan roadmap 地图 路线图' },
  { id: 'receipt', icon: Receipt, category: 'writing', keywords: 'receipt changelog 账单 变更' },
  { id: 'camera', icon: Camera, category: 'writing', keywords: 'camera screenshot 截图 相机' },
  { id: 'shield-check', icon: ShieldCheck, category: 'quality', keywords: 'review shield approve 审查 审核' },
  { id: 'shield-alert', icon: ShieldAlert, category: 'quality', keywords: 'security shield alert 安全' },
  { id: 'lock-keyhole', icon: LockKeyhole, category: 'quality', keywords: 'lock auth permission 权限 锁' },
  { id: 'flask-conical', icon: FlaskConical, category: 'quality', keywords: 'test flask experiment 测试 实验' },
  { id: 'test-tube', icon: TestTube, category: 'quality', keywords: 'test tube 测试 试管' },
  { id: 'list-checks', icon: ListChecks, category: 'quality', keywords: 'checklist qa 清单 验收' },
  { id: 'search', icon: Search, category: 'quality', keywords: 'search research 搜索 调研' },
  { id: 'eye', icon: Eye, category: 'quality', keywords: 'eye watch monitor 观察 监控' },
  { id: 'telescope', icon: Telescope, category: 'quality', keywords: 'telescope research 调研 望远镜' },
  { id: 'gauge', icon: Gauge, category: 'quality', keywords: 'gauge performance metric 性能 指标' },
  { id: 'chart-line', icon: ChartLine, category: 'quality', keywords: 'chart analytics data 分析 图表' },
  { id: 'scale', icon: Scale, category: 'quality', keywords: 'scale legal compliance 合规 法务' },
  { id: 'refresh-ccw', icon: RefreshCcw, category: 'quality', keywords: 'refactor refresh 重构 刷新' },
  { id: 'wrench', icon: Wrench, category: 'quality', keywords: 'wrench fix tool 修复 工具' },
  { id: 'hammer', icon: Hammer, category: 'quality', keywords: 'hammer build 构建 锤子' },
  { id: 'heart', icon: Heart, category: 'quality', keywords: 'heart care 关怀 心' },
  { id: 'star', icon: Star, category: 'quality', keywords: 'star favorite 收藏 星' },
  { id: 'leaf', icon: Leaf, category: 'quality', keywords: 'leaf clean 清理 叶子' },
]

export const ICON_CATEGORIES: IconCategory[] = ['work', 'code', 'writing', 'quality']

export type EmojiCategory = 'faces' | 'animals' | 'objects' | 'symbols'
export const EMOJI_CATEGORIES: EmojiCategory[] = ['faces', 'animals', 'objects', 'symbols']

export const AGENT_EMOJIS: { char: string; category: EmojiCategory; keywords: string }[] = [
  { char: '😀', category: 'faces', keywords: 'smile happy 笑' },
  { char: '😎', category: 'faces', keywords: 'cool sunglasses 酷' },
  { char: '🤓', category: 'faces', keywords: 'nerd 书呆子' },
  { char: '🧐', category: 'faces', keywords: 'inspect monocle 审视' },
  { char: '🤔', category: 'faces', keywords: 'think 思考' },
  { char: '🥷', category: 'faces', keywords: 'ninja 忍者' },
  { char: '🧑‍💻', category: 'faces', keywords: 'developer coder 程序员' },
  { char: '🧑‍🔬', category: 'faces', keywords: 'scientist 科学家' },
  { char: '🧑‍🎨', category: 'faces', keywords: 'artist designer 设计师' },
  { char: '🧑‍🏫', category: 'faces', keywords: 'teacher 老师' },
  { char: '🕵️', category: 'faces', keywords: 'detective 侦探' },
  { char: '🤖', category: 'faces', keywords: 'robot bot 机器人' },
  { char: '👾', category: 'faces', keywords: 'alien game 外星人' },
  { char: '👻', category: 'faces', keywords: 'ghost 幽灵' },
  { char: '🦸', category: 'faces', keywords: 'hero 英雄' },
  { char: '🧙', category: 'faces', keywords: 'wizard 巫师' },
  { char: '🐱', category: 'animals', keywords: 'cat 猫' },
  { char: '🐶', category: 'animals', keywords: 'dog 狗' },
  { char: '🦊', category: 'animals', keywords: 'fox 狐狸' },
  { char: '🐼', category: 'animals', keywords: 'panda 熊猫' },
  { char: '🦉', category: 'animals', keywords: 'owl 猫头鹰' },
  { char: '🐙', category: 'animals', keywords: 'octopus 章鱼' },
  { char: '🦄', category: 'animals', keywords: 'unicorn 独角兽' },
  { char: '🐝', category: 'animals', keywords: 'bee 蜜蜂' },
  { char: '🐢', category: 'animals', keywords: 'turtle 乌龟' },
  { char: '🦀', category: 'animals', keywords: 'crab rust 螃蟹' },
  { char: '🐍', category: 'animals', keywords: 'snake python 蛇' },
  { char: '🐳', category: 'animals', keywords: 'whale docker 鲸' },
  { char: '🦋', category: 'animals', keywords: 'butterfly 蝴蝶' },
  { char: '🐧', category: 'animals', keywords: 'penguin linux 企鹅' },
  { char: '🦖', category: 'animals', keywords: 'dinosaur 恐龙' },
  { char: '🌵', category: 'animals', keywords: 'cactus 仙人掌' },
  { char: '🚀', category: 'objects', keywords: 'rocket launch 火箭' },
  { char: '🛠️', category: 'objects', keywords: 'tools fix 工具' },
  { char: '🔧', category: 'objects', keywords: 'wrench 扳手' },
  { char: '🧪', category: 'objects', keywords: 'test tube 测试' },
  { char: '🔬', category: 'objects', keywords: 'microscope 显微镜' },
  { char: '📚', category: 'objects', keywords: 'books docs 书' },
  { char: '📝', category: 'objects', keywords: 'memo write 笔记' },
  { char: '📊', category: 'objects', keywords: 'chart data 图表' },
  { char: '🎨', category: 'objects', keywords: 'art palette 调色板' },
  { char: '🔍', category: 'objects', keywords: 'search 搜索' },
  { char: '🔒', category: 'objects', keywords: 'lock security 锁' },
  { char: '💡', category: 'objects', keywords: 'idea 想法' },
  { char: '🧭', category: 'objects', keywords: 'compass 指南针' },
  { char: '📦', category: 'objects', keywords: 'package 包裹' },
  { char: '☕', category: 'objects', keywords: 'coffee 咖啡' },
  { char: '🎯', category: 'objects', keywords: 'target 目标' },
  { char: '⚡', category: 'symbols', keywords: 'zap fast 闪电' },
  { char: '🔥', category: 'symbols', keywords: 'fire 火' },
  { char: '✨', category: 'symbols', keywords: 'sparkles 闪光' },
  { char: '⭐', category: 'symbols', keywords: 'star 星' },
  { char: '❤️', category: 'symbols', keywords: 'heart 心' },
  { char: '✅', category: 'symbols', keywords: 'check done 完成' },
  { char: '🧩', category: 'symbols', keywords: 'puzzle 拼图' },
  { char: '♻️', category: 'symbols', keywords: 'recycle refactor 重构' },
  { char: '🌈', category: 'symbols', keywords: 'rainbow 彩虹' },
  { char: '🌙', category: 'symbols', keywords: 'moon 月亮' },
  { char: '☀️', category: 'symbols', keywords: 'sun 太阳' },
  { char: '🌊', category: 'symbols', keywords: 'wave 海浪' },
  { char: '🍀', category: 'symbols', keywords: 'clover luck 幸运' },
  { char: '💎', category: 'symbols', keywords: 'gem 宝石' },
  { char: '🎵', category: 'symbols', keywords: 'music 音乐' },
  { char: '🏁', category: 'symbols', keywords: 'finish flag 终点' },
]

const ICONS_BY_ID = new Map(AGENT_ICONS.map(item => [item.id, item.icon]))

/** Each built-in role's own icon, used until the person picks another. */
export const ROLE_ICONS: Record<Exclude<AgentRole, 'custom'>, string> = {
  coordinator: 'workflow',
  worker: 'code',
  reviewer: 'shield-check',
}

/** What an agent's avatar shows: a lucide icon, or an emoji when the stored value is not an icon id. */
export function agentGlyph(role: AgentRole, icon: string | null): { icon: LucideIcon } | { emoji: string } {
  const id = icon ?? (role === 'custom' ? 'bot' : ROLE_ICONS[role])
  const found = ICONS_BY_ID.get(id)
  return found ? { icon: found } : { emoji: id }
}

/** Built-in roles keep HeroUI's own soft colours; custom roles use the picker palette. */
export const ROLE_AVATAR_COLORS = { coordinator: 'accent', worker: 'success', reviewer: 'warning' } as const

/** Tailwind classes per palette colour, written out in full so Tailwind sees them. */
export const AVATAR_TINTS: Record<AgentColor, string> = {
  violet: 'bg-avatar-violet text-avatar-violet-foreground',
  sky: 'bg-avatar-sky text-avatar-sky-foreground',
  teal: 'bg-avatar-teal text-avatar-teal-foreground',
  orange: 'bg-avatar-orange text-avatar-orange-foreground',
  pink: 'bg-avatar-pink text-avatar-pink-foreground',
  slate: 'bg-avatar-slate text-avatar-slate-foreground',
}

/** The saturated tone of each palette colour, for the picker's swatches. */
export const AVATAR_SWATCHES: Record<AgentColor, string> = {
  violet: 'bg-avatar-violet-foreground',
  sky: 'bg-avatar-sky-foreground',
  teal: 'bg-avatar-teal-foreground',
  orange: 'bg-avatar-orange-foreground',
  pink: 'bg-avatar-pink-foreground',
  slate: 'bg-avatar-slate-foreground',
}

/** The dot in each status badge. */
export const STATUS_DOTS = { running: 'bg-success', idle: 'bg-ink-3', waiting: 'bg-warning', offline: 'bg-destructive' } as const
