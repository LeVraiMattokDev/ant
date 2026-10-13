import type { ComponentType, ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { BotDTO, ChannelDTO, MessageDTO, ServerEvent } from '@ant/shared';

export interface FeatureRoute {
  /** Absolute path, e.g. "/suivi" (params allowed: "/contenus/:draftId"). */
  path: string;
  /** Usually a lazy screen: `const Page = lazy(() => import('./Page'))`, then `<Page />` (Suspense is provided). */
  element: ReactNode;
}

export interface FeatureNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Hook returning the badge count (0 = none). Called inside its own component, so it may use queries. */
  useBadge?: () => number;
  /** Desktop icon rail, mobile « Plus » menu, or both (default). */
  placement?: 'rail' | 'more' | 'both';
}

/**
 * A feature module of the web app (docs/ARCHITECTURE.md « Évolutions »). Each team fills in its own
 * `features/<module>/index.tsx`; the shell, the screens and the realtime dispatcher render every module's
 * contributions through features/index.tsx, so no team edits App.tsx, IconRail, MobileTabBar, AppShell, Home,
 * Settings, BotDetail, Conversation, MessageItem or ws-dispatch. Components render null when they have nothing to show.
 * Those files import the registry: a module may use their exports inside components, never at module level (import cycle).
 */
export interface FeatureModule {
  readonly name: string;
  /** Screens inside the app shell (rail, conversation list, banners). */
  routes?: readonly FeatureRoute[];
  /** Full-screen screens without the shell (guides), still behind the session. */
  bareRoutes?: readonly FeatureRoute[];
  /** Entries of the desktop rail (after the built-in ones) and of the mobile « Plus » menu. */
  nav?: readonly FeatureNavItem[];
  /** Bottom of the desktop rail, above Réglages (e.g. « Tout arrêter »). Rail buttons are 40×40 icon buttons. */
  railActions?: readonly ComponentType[];
  /** Items of the mobile « Plus » menu, after the navigation; call `close()` before navigating or opening a dialog. */
  mobileMenuActions?: readonly ComponentType<{ close: () => void }>[];
  /** Banners above every screen, after « Bots en pause ». */
  banners?: readonly ComponentType[];
  /** Components without UI mounted once in the shell (presence reporter, onboarding redirect). Must render null. */
  effects?: readonly ComponentType[];
  /** Every realtime event, after the core cache update (new event types are only handled here). */
  onEvent?: (qc: QueryClient, event: ServerEvent) => void;
  /** Under a message (attachments, draft card), for user, bot and system messages. */
  messageExtras?: readonly ComponentType<{ message: MessageDTO }>[];
  /** Items of a message's « ··· » menu (use MenuItem from components/Popover). */
  messageMenuItems?: readonly ComponentType<{ message: MessageDTO; close: () => void }>[];
  /** Under a conversation's header (e.g. « À venir »). */
  conversationTop?: readonly ComponentType<{ channel: ChannelDTO }>[];
  /** Cards of the dashboard (Accueil), right column, before « Quota ». */
  homeCards?: readonly ComponentType[];
  /** Sections of Réglages, after the built-in ones (use SettingsSection). */
  settingsSections?: readonly ComponentType[];
  /** Side panels of a bot's page, after the built-in ones. */
  botPanels?: readonly ComponentType<{ bot: BotDTO }>[];
}
