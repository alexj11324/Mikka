'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Briefcase, Cat, Code, Heart, Lamp, PenLine, Search, ShieldCheck, Shuffle, Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AGENT_COLORS, isBuiltInAgentRole, type AgentColor, type AgentRole } from '@/lib/agent-roles'
import { cn } from '@/lib/utils'
import { AGENT_EMOJIS, AGENT_ICONS, AVATAR_SWATCHES, EMOJI_CATEGORIES, ICON_CATEGORIES, agentGlyph, type EmojiCategory, type IconCategory } from './agent-icons'
import { AgentAvatar } from './agent-parts'

const CATEGORY_GLYPHS: Record<IconCategory | EmojiCategory, typeof Briefcase> = {
  work: Briefcase, code: Code, writing: PenLine, quality: ShieldCheck,
  faces: Smile, animals: Cat, objects: Lamp, symbols: Heart,
}

/**
 * Icon / emoji picker for a role's avatar, after reUI's EmojiPicker anatomy
 * (search, categories, grid, preview footer) composed from shadcn parts: the
 * reUI registry item needs a licence key this project does not have.
 */
export function AvatarPicker({ role, name, icon, color, onChange }: {
  role: AgentRole
  name: string
  icon: string | null
  color: AgentColor | null
  onChange: (next: { icon: string | null; color: AgentColor | null }) => void
}) {
  const t = useTranslations('Agents.picker')
  const current = agentGlyph(role, icon)
  const [kind, setKind] = useState<'icon' | 'emoji'>('emoji' in current ? 'emoji' : 'icon')
  const [iconCategory, setIconCategory] = useState<IconCategory>(() => AGENT_ICONS.find(item => item.id === icon)?.category ?? 'work')
  const [emojiCategory, setEmojiCategory] = useState<EmojiCategory>(() => AGENT_EMOJIS.find(item => item.char === icon)?.category ?? 'faces')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const icons = AGENT_ICONS.filter(item => needle ? item.keywords.includes(needle) : item.category === iconCategory)
  const emojis = AGENT_EMOJIS.filter(item => needle ? item.keywords.includes(needle) : item.category === emojiCategory)
  const categories = kind === 'icon' ? ICON_CATEGORIES : EMOJI_CATEGORIES
  const category = kind === 'icon' ? iconCategory : emojiCategory
  const chosenLabel = 'icon' in current ? AGENT_ICONS.find(item => item.icon === current.icon)?.id ?? '' : current.emoji

  return <Popover onOpenChange={open => { if (!open) setQuery('') }}>
    <PopoverTrigger render={<Button variant="ghost" className="size-11 shrink-0 rounded-full p-0" aria-label={t('open')} title={t('open')} />}>
      <AgentAvatar role={role} name={name} icon={icon} color={color} size="header" />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-84 gap-0 p-0">
      <PopoverTitle className="sr-only">{t('title')}</PopoverTitle>
      <div className="flex items-center gap-2 p-2 pb-1.5">
        <Tabs value={kind} onValueChange={value => setKind(value as 'icon' | 'emoji')}>
          <TabsList>
            <TabsTrigger value="icon">{t('icons')}</TabsTrigger>
            <TabsTrigger value="emoji">Emoji</TabsTrigger>
          </TabsList>
        </Tabs>
        <InputGroup className="h-8 flex-1">
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} />
        </InputGroup>
      </div>
      {!needle && <Tabs value={category} onValueChange={value => kind === 'icon' ? setIconCategory(value as IconCategory) : setEmojiCategory(value as EmojiCategory)} className="px-2">
        <TabsList variant="line">
          {categories.map(item => { const Glyph = CATEGORY_GLYPHS[item]; return <TabsTrigger key={item} value={item} aria-label={t(`categories.${item}`)} title={t(`categories.${item}`)}><Glyph aria-hidden="true" /></TabsTrigger> })}
        </TabsList>
      </Tabs>}
      <div className="flex flex-col gap-1 p-2">
        <span className="px-1 text-xs font-medium text-muted-foreground">{needle ? t('results') : t(`categories.${category}`)}</span>
        <div className="grid max-h-36 auto-rows-min grid-cols-8 gap-0.5 overflow-y-auto">
          {kind === 'icon'
            ? icons.map(item => <Button key={item.id} type="button" variant="ghost" size="icon" aria-label={item.id} aria-pressed={icon === item.id}
                className={cn(icon === item.id && 'bg-agent-accent/10 text-agent-accent hover:bg-agent-accent/15')} onClick={() => onChange({ icon: item.id, color })}>
                <item.icon data-icon="inline-start" />
              </Button>)
            : emojis.map(item => <Button key={item.char} type="button" variant="ghost" size="icon" aria-label={item.char} aria-pressed={icon === item.char}
                className={cn('text-lg', icon === item.char && 'bg-agent-accent/10 hover:bg-agent-accent/15')} onClick={() => onChange({ icon: item.char, color })}>
                {item.char}
              </Button>)}
          {(kind === 'icon' ? icons : emojis).length === 0 && <span className="col-span-8 px-1 py-4 text-center text-xs text-muted-foreground">{t('noResults')}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t bg-sidebar p-2">
        <AgentAvatar role={role} name={name} icon={icon} color={color} size="preview" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{name || chosenLabel}</span>
        <ToggleGroup aria-label={t('color')} spacing={1} value={[color ?? 'auto']} onValueChange={values => { const next = values[0]; if (next) onChange({ icon, color: next === 'auto' ? null : next as AgentColor }) }}>
          <ToggleGroupItem value="auto" size="sm" aria-label={isBuiltInAgentRole(role) ? t('colorRole') : t('colorAuto')} title={isBuiltInAgentRole(role) ? t('colorRole') : t('colorAuto')}
            className="size-6 min-w-6 rounded-full p-0 aria-pressed:ring-2 aria-pressed:ring-agent-accent"><Shuffle aria-hidden="true" /></ToggleGroupItem>
          {AGENT_COLORS.map(item => <ToggleGroupItem key={item} value={item} size="sm" aria-label={t(`colors.${item}`)} title={t(`colors.${item}`)}
            className="size-6 min-w-6 rounded-full p-0 aria-pressed:ring-2 aria-pressed:ring-agent-accent">
            <span className={cn('size-3.5 rounded-full', AVATAR_SWATCHES[item])} aria-hidden="true" />
          </ToggleGroupItem>)}
        </ToggleGroup>
      </div>
    </PopoverContent>
  </Popover>
}
