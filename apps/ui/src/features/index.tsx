import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { BotDTO, ChannelDTO, MessageDTO, ServerEvent } from '@ant/shared';
import { capabilitiesFeature } from './capabilities';
import { inputsFeature } from './inputs';
import { opsFeature } from './ops';
import { trackingFeature } from './tracking';
import type { FeatureModule, FeatureNavItem, FeatureRoute } from './types';

export type { FeatureModule, FeatureNavItem, FeatureRoute } from './types';

/**
 * The feature modules, in a fixed order (tracking, ops, inputs, capabilities). A function, not a constant: read at
 * render time, it never sees a module that an import cycle has not initialised yet.
 */
export function features(): readonly FeatureModule[] {
  return [trackingFeature, opsFeature, inputsFeature, capabilitiesFeature];
}

export const featureRoutes = (): FeatureRoute[] => features().flatMap((f) => f.routes ?? []);
export const featureBareRoutes = (): FeatureRoute[] => features().flatMap((f) => f.bareRoutes ?? []);

export function featureNav(where: 'rail' | 'more'): FeatureNavItem[] {
  return features()
    .flatMap((f) => f.nav ?? [])
    .filter((n) => (n.placement ?? 'both') === 'both' || n.placement === where);
}

/** Feature handlers of a realtime event; one that throws does not stop the others. */
export function dispatchFeatureEvent(qc: QueryClient, event: ServerEvent): void {
  for (const f of features()) {
    if (!f.onEvent) continue;
    try {
      f.onEvent(qc, event);
    } catch (err) {
      console.error(`[ant] module ${f.name} : événement ${event.type} non traité`, err);
    }
  }
}

/**
 * Isolates one module's contribution: when it throws while rendering, it is logged and replaced by `fallback`
 * (nothing by default) — the shell, the conversation and the other modules keep working. Most slots render outside
 * the screen's own error boundary (rail, banners, effects), where one bug would otherwise blank the whole app.
 */
export class FeatureBoundary extends Component<{ module: string; slot: string; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[ant] module ${this.props.module} : « ${this.props.slot} » n’a pas pu s’afficher`, error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** Every module's components of one slot, in module order, each in its own FeatureBoundary. */
function slot<P extends object>(name: string, pick: (f: FeatureModule) => readonly ComponentType<P>[] | undefined, props: P): ReactNode[] {
  return features().flatMap((f) =>
    (pick(f) ?? []).map((C, i) => (
      <FeatureBoundary key={`${f.name}-${i}`} module={f.name} slot={name}>
        <C {...props} />
      </FeatureBoundary>
    )),
  );
}

// ── Slots: each renders the contributions of every module, in module order ──

export function FeatureBanners() {
  return <>{slot('banners', (f) => f.banners, {})}</>;
}

export function FeatureEffects() {
  return <>{slot('effects', (f) => f.effects, {})}</>;
}

export function FeatureRailActions() {
  return <>{slot('railActions', (f) => f.railActions, {})}</>;
}

export function FeatureMobileMenuActions({ close }: { close: () => void }) {
  return <>{slot('mobileMenuActions', (f) => f.mobileMenuActions, { close })}</>;
}

export function FeatureMessageExtras({ message }: { message: MessageDTO }) {
  return <>{slot('messageExtras', (f) => f.messageExtras, { message })}</>;
}

export function FeatureMessageMenuItems({ message, close }: { message: MessageDTO; close: () => void }) {
  return <>{slot('messageMenuItems', (f) => f.messageMenuItems, { message, close })}</>;
}

export function FeatureConversationTop({ channel }: { channel: ChannelDTO }) {
  return <>{slot('conversationTop', (f) => f.conversationTop, { channel })}</>;
}

export function FeatureHomeCards() {
  return <>{slot('homeCards', (f) => f.homeCards, {})}</>;
}

export function FeatureSettingsSections() {
  return <>{slot('settingsSections', (f) => f.settingsSections, {})}</>;
}

export function FeatureBotPanels({ bot }: { bot: BotDTO }) {
  return <>{slot('botPanels', (f) => f.botPanels, { bot })}</>;
}
