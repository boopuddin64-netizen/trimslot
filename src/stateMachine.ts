import { AppError } from './errors';

export const STATUSES = [
  'PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED',
] as const;
export type Status = (typeof STATUSES)[number];

/**
 * The ONLY legal booking transitions. Everything that changes `bookings.status` goes through assertTransition().
 *   PENDING_PAYMENT -> CONFIRMED            (payment verified server-side)
 *   PENDING_PAYMENT -> CANCELLED            (customer cancels / hold expires)
 *   CONFIRMED -> ARRIVED                    (I'm Here / Mark Present)
 *   ARRIVED   -> IN_SERVICE -> COMPLETED
 *   CONFIRMED|ARRIVED -> CANCELLED | NO_SHOW | NOT_SERVED
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED'],
  ARRIVED: ['IN_SERVICE', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED'],
  IN_SERVICE: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  NOT_SERVED: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'ILLEGAL_TRANSITION', `This booking cannot go from ${from} to ${to}.`);
  }
}

/** Statuses that occupy the barber's calendar (block slot generation). PENDING_PAYMENT deliberately does NOT: an unpaid attempt reserves nothing. */
export const SLOT_BLOCKING: readonly Status[] = ['CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED'];
/** Statuses that are still "live" in today's queue. */
export const QUEUE_ACTIVE: readonly Status[] = ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'];
export const isTerminal = (s: Status) => TRANSITIONS[s].length === 0;
