/**
 * Label mapping for money statuses and rails.
 *
 * The database stores enums; the UI prints sentences. Keeping the mapping in one module means a new
 * payment method added to `00030` fails in exactly one place (a missing translation key) rather than
 * showing `cash_one` to a passenger on three different screens.
 */

import type { BadgeTone } from '@/components/ui/Feedback';
import type { TranslationKey } from '@maak/core';

export function paymentMethodKey(method: string): TranslationKey {
  return `payments.method.${method}` as TranslationKey;
}

export function paymentStatusKey(status: string): TranslationKey {
  return `pay.status.${status}` as TranslationKey;
}

export function refundStatusKey(status: string): TranslationKey {
  return `payments.refundStatus.${status}` as TranslationKey;
}

export function payoutStatusKey(status: string): TranslationKey {
  return `payments.payoutStatus.${status}` as TranslationKey;
}

export function accountStatusKey(status: string): TranslationKey {
  return `payments.accountStatus.${status}` as TranslationKey;
}

export function accountKindKey(kind: string): TranslationKey {
  return `payments.accountKind.${kind}` as TranslationKey;
}

/**
 * Tone is semantic: money that arrived is green, money still being checked is amber, money that was
 * refused is red. Never decorative.
 */
export function paymentTone(status: string): BadgeTone {
  switch (status) {
    case 'confirmed':
    case 'paid':
    case 'active':
    case 'approved':
      return 'success';
    case 'awaiting_proof':
    case 'awaiting_confirmation':
    case 'requested':
    case 'pending_verification':
      return 'warning';
    case 'rejected':
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}
