/**
 * Guards against runaway bot-to-bot chains: maximum hops without a human,
 * and ping-pong detection (A→B→A→B without new human input).
 */

export interface HandoffEdge {
  from: string;
  to: string;
}

export interface ChainCheckInput {
  /** Number of bot-to-bot hops already made in this chain since the last human message. */
  hop: number;
  maxHops: number;
  /** Previous hand-offs in the chain, oldest first. */
  history: readonly HandoffEdge[];
  next: HandoffEdge;
}

export type ChainCheck = { allowed: true } | { allowed: false; reason: string };

export function checkHandoff(input: ChainCheckInput): ChainCheck {
  if (input.next.from === input.next.to) return { allowed: false, reason: 'un bot ne peut pas se transférer une tâche à lui-même' };
  if (input.hop >= input.maxHops) {
    return {
      allowed: false,
      reason: `limite de ${input.maxHops} transferts entre bots sans intervention humaine atteinte`,
    };
  }
  const edges = [...input.history, input.next];
  // Ping-pong: the same pair alternating 4 times in a row (A→B, B→A, A→B, B→A).
  if (edges.length >= 4) {
    const last4 = edges.slice(-4);
    const [a, b, c, d] = last4 as [HandoffEdge, HandoffEdge, HandoffEdge, HandoffEdge];
    const pingPong =
      a.from === c.from && a.to === c.to && b.from === d.from && b.to === d.to && a.from === b.to && a.to === b.from;
    if (pingPong) return { allowed: false, reason: `aller-retour répété entre ${a.from} et ${a.to} détecté` };
  }
  return { allowed: true };
}
