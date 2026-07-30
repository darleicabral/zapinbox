/**
 * Canonical icon map. Toda feature importa daqui — não direto de @phosphor-icons/react.
 * ADR-05 (Spec 09 §12). Permite swap futuro sem big-bang refactor.
 *
 * Re-exporting from `@phosphor-icons/react/dist/ssr` so Server Components can
 * render icons without forcing the entire CSR React-context module client-side.
 * Client Components still get fully interactive icons (size/weight/color).
 */

export {
  // navigation (inbox icon = Tray in Phosphor)
  Tray as Inbox,
  // sidebar: ícones mais expressivos que os genéricos (30/07) — WhatsApp usa a
  // própria logo, Contatos vira agenda de contatos, Manuais vira livro.
  AddressBook,
  BookOpen,
  ChartLineUp,
  PlugsConnected,
  QrCode,
  Kanban,
  Users,
  UsersThree,
  Storefront,
  Robot,
  ShieldCheck,
  Gear,
  House,
  // admin platform
  Buildings,
  ChatsCircle,
  ClipboardText,
  Scales,
  Gauge,
  WifiSlash,
  Clock,
  CalendarDots as Calendar,
  CalendarCheck,
  CalendarBlank,
  // health dashboard
  WifiHigh,
  Brain,
  ArrowsClockwise,
  Dot,
  // actions
  PaperPlaneTilt,
  Check,
  Checks,
  X,
  Plus,
  Trash,
  PencilSimple,
  MagnifyingGlass,
  Pause,
  Play,
  Copy,
  Archive,
  // feedback
  CheckCircle,
  Warning,
  WarningOctagon,
  Info,
  CircleNotch,
  // lgpd
  Scales as ScalesSimple,
  Eye,
  ChartBar,
  ClockCountdown,
  // theme
  Sun,
  Moon,
  MonitorPlay,
  // conversation
  ChatCircle,
  WhatsappLogo,
  Phone,
  PhoneCall,
  Paperclip,
  Image as ImageIcon,
  MusicNote,
  FileText,
  Lock,
  Receipt,
  Tag,
  Question,
  Keyboard,
  // import / export
  UploadSimple,
  // misc
  DotsThree,
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  CaretRight,
  ArrowRight,
  SignOut,
} from "@phosphor-icons/react/dist/ssr";
