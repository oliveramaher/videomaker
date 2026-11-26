// Safety rules for exploration, enforced in code rather than in the prompt.
// The model can ask for anything; the session refuses what matches here.

const DEFAULT_BLOCKED = [
  /\b(delete|remove|destroy|erase|wipe|purge|archive|deactivate|disable account|close account)\b/i,
  /\b(pay|purchase|buy|checkout|subscribe|upgrade|downgrade|billing|add card|payment)\b/i,
  /\bcancel (my )?(subscription|plan|account|membership)\b/i,
  /\b(send|invite|share|publish|post|tweet|email|notify|submit for review)\b/i,
  /\b(log ?out|sign ?out|switch account)\b/i,
  /\b(reset|change|update) (password|email|2fa|two-factor)\b/i,
  /\b(transfer|withdraw|refund|revoke|rotate (key|token)|regenerate)\b/i,
  /\b(connect|authorize|install) (app|integration|github|slack|google)\b/i,
];

export function createGuard({origin, blocked = DEFAULT_BLOCKED, allowNames = []} = {}) {
  const allowed = new Set(allowNames.map((name) => name.toLowerCase()));
  const allowedOrigins = new Set([new URL(origin).origin]);

  return {
    /** Return a reason string if acting on this element is refused, else null. */
    checkElement(element, action) {
      if (!element) return 'unknown element ref; observe again to get fresh refs';
      if (element.disabled) return 'element is disabled';
      const label = element.name ?? '';
      if (allowed.has(label.toLowerCase())) return null;
      if (action === 'type' && element.type === 'password') return 'typing into password fields is not allowed';
      // Typing into a field is harmless; pressing a button whose name matches is not.
      if (action !== 'type') {
        const rule = blocked.find((pattern) => pattern.test(label));
        if (rule) return `"${label}" looks destructive or outward-facing (matched ${rule})`;
      }
      return null;
    },
    checkUrl(url) {
      try {
        const target = new URL(url);
        if (!['http:', 'https:'].includes(target.protocol)) return `protocol ${target.protocol} is not allowed`;
        if (!allowedOrigins.has(target.origin)) return `${target.origin} is outside the app being explored`;
        if (/\/(log-?out|sign-?out)\b/i.test(target.pathname)) return 'logging out would end the session';
        return null;
      } catch {
        return 'not a valid URL';
      }
    },
    checkKey(key) {
      const allowedKeys = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'];
      return allowedKeys.includes(key) ? null : `key "${key}" is not allowed (use one of ${allowedKeys.join(', ')})`;
    },
  };
}
