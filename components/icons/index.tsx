// Mikka's own glyph set (decision 2026-11-18-1900): Hugeicons free icons, stroke 2 in a 24 box in
// currentColor, which is affectUI's family. Each glyph is a component so BoardUI's props keep their
// shape (`leadingIcon={Plus}`) and a migrated call site keeps the class, size and stroke weight it
// had before. A task's status icon is not here: ISSUE_STATUSES draws its own (2026-11-13-1405).
import { forwardRef, type ComponentType, type ReactElement } from 'react'
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
import {
  AiBrain01Icon,
  Alert02Icon,
  AlertCircleIcon,
  AppWindowIcon,
  ArchiveIcon,
  ArrowDown02Icon,
  ArrowDownAZIcon,
  ArrowDownToLineIcon,
  ArrowExpand01Icon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon,
  ArrowLeftToLineIcon,
  ArrowRight02Icon,
  ArrowRightToLineIcon,
  ArrowShrink01Icon,
  ArrowUp02Icon,
  ArrowUpAzIcon,
  ArrowUpRight01Icon,
  ArrowUpToLineIcon,
  AudioLinesIcon,
  BellIcon,
  BellRingIcon,
  BetweenHorizontalEndIcon,
  BetweenVerticalEndIcon,
  BlocksIcon,
  BoldIcon,
  BookmarkIcon,
  BookOpenIcon,
  BookOpenTextIcon,
  BotIcon,
  BoxIcon,
  BracesIcon,
  Building02Icon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CameraIcon,
  ChartColumnIcon,
  CheckIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleArrowDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleSlashTwoIcon,
  CircleXIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  ClockIcon,
  CloudIcon,
  CloudUploadIcon,
  CodeSimpleIcon,
  CodeSquareIcon,
  ContactIcon,
  ContainerIcon,
  Copy01Icon,
  CornerUpLeftIcon,
  CornerUpRightIcon,
  CreditCardIcon,
  CursorAddSelection02Icon,
  CursorPointer02Icon,
  Delete02Icon,
  DownloadIcon,
  DragDropVerticalIcon,
  Edit04Icon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FactoryIcon,
  FileIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCheckIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileUpIcon,
  FileVideoIcon,
  FlagIcon,
  FolderIcon,
  FolderClosedIcon,
  FolderGit2Icon,
  FolderInputIcon,
  FolderOpenIcon,
  GaugeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  Globe02Icon,
  HandIcon,
  HardDriveIcon,
  HashIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  HelpCircleIcon,
  HighlighterIcon,
  HistoryIcon,
  Home03Icon,
  ImageIcon,
  InboxIcon,
  InfoIcon,
  InternetIcon,
  ItalicIcon,
  KanbanIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LandmarkIcon,
  LanguagesIcon,
  LaptopIcon,
  LayersIcon,
  LightbulbIcon,
  Link01Icon,
  Link02Icon,
  LinkOffIcon,
  ListIcon,
  ListChecksIcon,
  ListOrderedIcon,
  ListTodoIcon,
  ListTreeIcon,
  Loading03Icon,
  LockIcon,
  LockKeyIcon,
  LogoutIcon,
  MailIcon,
  MessageCircleIcon,
  MessageCircleQuestionMarkIcon,
  MessageSquareIcon,
  MessageSquareDiffIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  MicIcon,
  MonitorIcon,
  MoonIcon,
  MoreVerticalIcon,
  OctagonXIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PanelTopIcon,
  PaperclipIcon,
  PauseIcon,
  PauseCircleIcon,
  PencilLineIcon,
  Pin02Icon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PointerIcon,
  PowerIcon,
  PuzzleIcon,
  QuoteDownIcon,
  RedoIcon,
  ReloadIcon,
  RemoveIcon,
  Rows3Icon,
  ScanIcon,
  SearchIcon,
  SecurityCheckIcon,
  SendIcon,
  ServerIcon,
  SettingsIcon,
  Settings02Icon,
  Share02Icon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  SquareKanbanIcon,
  SquarePenIcon,
  SquarePlusIcon,
  SquareTerminalIcon,
  SquareUserRoundIcon,
  StarIcon,
  StopIcon,
  StopCircleIcon,
  SunIcon,
  TableIcon,
  TableOfContentsIcon,
  TagIcon,
  Tally1Icon,
  Tally2Icon,
  Tally3Icon,
  TerminalIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextQuoteIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TypeIcon,
  UnavailableIcon,
  UndoIcon,
  UnfoldMoreIcon,
  UnplugIcon,
  UploadIcon,
  UserIcon,
  UserCircleIcon,
  UserMultiple03Icon,
  UserPlusIcon,
  UserRoundIcon,
  ViewIcon,
  WalletIcon,
  WorkflowIcon,
  WrenchIcon,
  XIcon,
} from '@hugeicons/core-free-icons'

/** What a glyph takes: an SVG element's props, the 24 box's size and stroke weight, and the
 * `data-icon` slot BoardUI marks its icons with. */
export type IconProps = Omit<HugeiconsIconProps, 'icon'> & {
  className?: string
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined
}

/** A glyph, as a component: what a menu's `leadingIcon` and every icon prop take. */
export type IconGlyph = ComponentType<IconProps>

const glyph = (icon: IconSvgElement) => forwardRef<SVGSVGElement, IconProps>(function Glyph(props, ref): ReactElement {
  const { size = 24, strokeWidth = 2, ...rest } = props
  return <HugeiconsIcon ref={ref} icon={icon} size={size} strokeWidth={strokeWidth} color="currentColor" {...rest} />
})

export const AlignCenter = glyph(TextAlignCenterIcon)
export const AlignJustify = glyph(TextAlignJustifyIcon)
export const AlignLeft = glyph(TextAlignLeftIcon)
export const AlignRight = glyph(TextAlignRightIcon)
export const AppWindow = glyph(AppWindowIcon)
export const Archive = glyph(ArchiveIcon)
export const ArrowDown = glyph(ArrowDown02Icon)
export const ArrowDownAZ = glyph(ArrowDownAZIcon)
export const ArrowDownToLine = glyph(ArrowDownToLineIcon)
export const ArrowLeft = glyph(ArrowLeft02Icon)
export const ArrowLeftRight = glyph(ArrowLeftRightIcon)
export const ArrowLeftToLine = glyph(ArrowLeftToLineIcon)
export const ArrowRight = glyph(ArrowRight02Icon)
export const ArrowRightToLine = glyph(ArrowRightToLineIcon)
export const ArrowUp = glyph(ArrowUp02Icon)
export const ArrowUpAZ = glyph(ArrowUpAzIcon)
export const ArrowUpRight = glyph(ArrowUpRight01Icon)
export const ArrowUpToLine = glyph(ArrowUpToLineIcon)
export const AudioLines = glyph(AudioLinesIcon)
export const Ban = glyph(UnavailableIcon)
export const Bell = glyph(BellIcon)
export const BellRing = glyph(BellRingIcon)
export const BetweenHorizontalEnd = glyph(BetweenHorizontalEndIcon)
export const BetweenVerticalEnd = glyph(BetweenVerticalEndIcon)
export const Blocks = glyph(BlocksIcon)
export const Bold = glyph(BoldIcon)
export const Bookmark = glyph(BookmarkIcon)
export const BookOpen = glyph(BookOpenIcon)
export const BookOpenText = glyph(BookOpenTextIcon)
export const Bot = glyph(BotIcon)
export const Box = glyph(BoxIcon)
export const BoxSelect = glyph(PointerIcon)
export const Braces = glyph(BracesIcon)
export const Brain = glyph(AiBrain01Icon)
export const Building2 = glyph(Building02Icon)
export const CalendarCheck = glyph(CalendarCheckIcon)
export const CalendarClock = glyph(CalendarClockIcon)
export const CalendarDays = glyph(CalendarDaysIcon)
export const Camera = glyph(CameraIcon)
export const ChartColumn = glyph(ChartColumnIcon)
export const Check = glyph(CheckIcon)
export const CheckCheck = glyph(CheckCheckIcon)
export const ChevronDown = glyph(ChevronDownIcon)
export const ChevronLeft = glyph(ChevronLeftIcon)
export const ChevronRight = glyph(ChevronRightIcon)
export const ChevronsDownUp = glyph(ChevronsDownUpIcon)
export const ChevronsUpDown = glyph(UnfoldMoreIcon)
export const ChevronUp = glyph(ChevronUpIcon)
export const Circle = glyph(CircleIcon)
export const CircleAlert = glyph(AlertCircleIcon)
export const CircleArrowDown = glyph(CircleArrowDownIcon)
export const CircleCheck = glyph(CircleCheckIcon)
export const CircleDashed = glyph(CircleDashedIcon)
export const CircleDot = glyph(CircleDotIcon)
export const CircleHelp = glyph(HelpCircleIcon)
export const CirclePause = glyph(PauseCircleIcon)
export const CircleSlash = glyph(CircleSlashIcon)
export const CircleSlash2 = glyph(CircleSlashTwoIcon)
export const CircleStop = glyph(StopCircleIcon)
export const CircleUserRound = glyph(UserCircleIcon)
export const CircleX = glyph(CircleXIcon)
export const ClipboardCheck = glyph(ClipboardCheckIcon)
export const ClipboardList = glyph(ClipboardListIcon)
export const Clock = glyph(ClockIcon)
export const Cloud = glyph(CloudIcon)
export const Code = glyph(CodeSimpleIcon)
export const Columns3 = glyph(KanbanIcon)
export const ContactRound = glyph(ContactIcon)
export const Container = glyph(ContainerIcon)
export const Copy = glyph(Copy01Icon)
export const CreditCard = glyph(CreditCardIcon)
export const Download = glyph(DownloadIcon)
export const Ellipsis = glyph(EllipsisIcon)
export const ExternalLink = glyph(ExternalLinkIcon)
export const Eye = glyph(ViewIcon)
export const EyeOff = glyph(EyeOffIcon)
export const Factory = glyph(FactoryIcon)
export const File = glyph(FileIcon)
export const FileArchive = glyph(FileArchiveIcon)
export const FileAudio = glyph(FileAudioIcon)
export const FileCheck = glyph(FileCheckIcon)
export const FileCode2 = glyph(FileCodeIcon)
export const FileDiff = glyph(FileDiffIcon)
export const FileImage = glyph(FileImageIcon)
export const FileSpreadsheet = glyph(FileSpreadsheetIcon)
export const FileText = glyph(FileTextIcon)
export const FileUp = glyph(FileUpIcon)
export const FileVideo = glyph(FileVideoIcon)
export const Flag = glyph(FlagIcon)
export const Folder = glyph(FolderIcon)
export const FolderClosed = glyph(FolderClosedIcon)
export const FolderGit2 = glyph(FolderGit2Icon)
export const FolderInput = glyph(FolderInputIcon)
export const FolderOpen = glyph(FolderOpenIcon)
export const Gauge = glyph(GaugeIcon)
export const GitBranch = glyph(GitBranchIcon)
export const GitCommitHorizontal = glyph(GitCommitHorizontalIcon)
export const GitCompareArrows = glyph(GitCompareArrowsIcon)
export const GitMerge = glyph(GitMergeIcon)
export const GitPullRequest = glyph(GitPullRequestIcon)
export const GitPullRequestClosed = glyph(GitPullRequestClosedIcon)
export const GitPullRequestDraft = glyph(GitPullRequestDraftIcon)
export const Globe = glyph(InternetIcon)
export const Globe2 = glyph(Globe02Icon)
export const GripVertical = glyph(DragDropVerticalIcon)
export const Hand = glyph(HandIcon)
export const HardDrive = glyph(HardDriveIcon)
export const Hash = glyph(HashIcon)
export const Heading1 = glyph(Heading01Icon)
export const Heading2 = glyph(Heading02Icon)
export const Heading3 = glyph(Heading03Icon)
export const Highlighter = glyph(HighlighterIcon)
export const History = glyph(HistoryIcon)
export const House = glyph(Home03Icon)
export const Image = glyph(ImageIcon)
export const Inbox = glyph(InboxIcon)
export const Info = glyph(InfoIcon)
export const Italic = glyph(ItalicIcon)
export const Keyboard = glyph(KeyboardIcon)
export const KeyRound = glyph(KeyRoundIcon)
export const Landmark = glyph(LandmarkIcon)
export const Languages = glyph(LanguagesIcon)
export const Laptop = glyph(LaptopIcon)
export const Layers = glyph(LayersIcon)
export const Lightbulb = glyph(LightbulbIcon)
export const Link = glyph(Link01Icon)
export const Link2 = glyph(Link02Icon)
export const Link2Off = glyph(LinkOffIcon)
export const List = glyph(ListIcon)
export const ListChecks = glyph(ListChecksIcon)
export const ListOrdered = glyph(ListOrderedIcon)
export const ListTodo = glyph(ListTodoIcon)
export const ListTree = glyph(ListTreeIcon)
export const LoaderCircle = glyph(Loading03Icon)
export const Lock = glyph(LockIcon)
export const LockKeyhole = glyph(LockKeyIcon)
export const LogOut = glyph(LogoutIcon)
export const Mail = glyph(MailIcon)
export const Maximize2 = glyph(ArrowExpand01Icon)
export const MessageCircle = glyph(MessageCircleIcon)
export const MessageCircleQuestion = glyph(MessageCircleQuestionMarkIcon)
export const MessageSquare = glyph(MessageSquareIcon)
export const MessageSquareDiff = glyph(MessageSquareDiffIcon)
export const MessageSquareText = glyph(MessageSquareTextIcon)
export const MessagesSquare = glyph(MessagesSquareIcon)
export const Mic = glyph(MicIcon)
export const Minimize2 = glyph(ArrowShrink01Icon)
export const Minus = glyph(RemoveIcon)
export const Monitor = glyph(MonitorIcon)
export const Moon = glyph(MoonIcon)
export const MoreHorizontal = glyph(EllipsisIcon)
export const MoreVertical = glyph(MoreVerticalIcon)
export const MousePointer2 = glyph(CursorPointer02Icon)
export const OctagonX = glyph(OctagonXIcon)
export const PanelLeft = glyph(PanelLeftIcon)
export const PanelRight = glyph(PanelRightIcon)
export const PanelRightClose = glyph(PanelRightCloseIcon)
export const PanelRightOpen = glyph(PanelRightOpenIcon)
export const PanelTop = glyph(PanelTopIcon)
export const Paperclip = glyph(PaperclipIcon)
export const Pause = glyph(PauseIcon)
export const Pencil = glyph(Edit04Icon)
export const PencilLine = glyph(PencilLineIcon)
export const Pin = glyph(Pin02Icon)
export const Play = glyph(PlayIcon)
export const Plug = glyph(PlugIcon)
export const Plus = glyph(PlusIcon)
export const Power = glyph(PowerIcon)
export const Puzzle = glyph(PuzzleIcon)
export const Quote = glyph(QuoteDownIcon)
export const Redo2 = glyph(CornerUpRightIcon)
export const RefreshCw = glyph(ReloadIcon)
export const RotateCcw = glyph(UndoIcon)
export const RotateCw = glyph(RedoIcon)
export const Rows3 = glyph(Rows3Icon)
export const Scan = glyph(ScanIcon)
export const Search = glyph(SearchIcon)
export const Send = glyph(SendIcon)
export const Server = glyph(ServerIcon)
export const Settings = glyph(SettingsIcon)
export const Settings2 = glyph(Settings02Icon)
export const Share2 = glyph(Share02Icon)
export const Shield = glyph(ShieldIcon)
export const ShieldCheck = glyph(SecurityCheckIcon)
export const SignalHigh = glyph(Tally3Icon)
export const SignalLow = glyph(Tally1Icon)
export const SignalMedium = glyph(Tally2Icon)
export const SlidersHorizontal = glyph(SlidersHorizontalIcon)
export const Square = glyph(SquareIcon)
export const SquareCode = glyph(CodeSquareIcon)
export const SquareDashedMousePointer = glyph(CursorAddSelection02Icon)
export const SquareKanban = glyph(SquareKanbanIcon)
export const SquarePen = glyph(SquarePenIcon)
export const SquarePlus = glyph(SquarePlusIcon)
export const SquareTerminal = glyph(SquareTerminalIcon)
export const SquareUserRound = glyph(SquareUserRoundIcon)
export const Star = glyph(StarIcon)
export const Stop = glyph(StopIcon)
export const Strikethrough = glyph(TextStrikethroughIcon)
export const Sun = glyph(SunIcon)
export const Table = glyph(TableIcon)
export const TableOfContents = glyph(TableOfContentsIcon)
export const Tag = glyph(TagIcon)
export const Terminal = glyph(TerminalIcon)
export const TextQuote = glyph(TextQuoteIcon)
export const ThumbsDown = glyph(ThumbsDownIcon)
export const ThumbsUp = glyph(ThumbsUpIcon)
export const Trash2 = glyph(Delete02Icon)
export const TriangleAlert = glyph(Alert02Icon)
export const Type = glyph(TypeIcon)
export const Underline = glyph(TextUnderlineIcon)
export const Undo2 = glyph(CornerUpLeftIcon)
export const Unplug = glyph(UnplugIcon)
export const Upload = glyph(UploadIcon)
export const UploadCloud = glyph(CloudUploadIcon)
export const User = glyph(UserIcon)
export const UserPlus = glyph(UserPlusIcon)
export const UserRound = glyph(UserRoundIcon)
export const Users = glyph(UserMultiple03Icon)
export const Wallet = glyph(WalletIcon)
export const Workflow = glyph(WorkflowIcon)
export const Wrench = glyph(WrenchIcon)
export const X = glyph(XIcon)
