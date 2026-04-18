/**
 * Deterministic agent identity helpers — turn an agent into a stable hue and
 * monogram for visual distinction in the UI. Uses CSS agent-hue variables
 * when the agent name matches a well-known role, otherwise hashes the name
 * into an oklch hue.
 */

const NAMED_HUES: Record<string, string> = {
  frontend: 'var(--h-frontend)',
  backend:  'var(--h-backend)',
  qa:       'var(--h-qa)',
  test:     'var(--h-qa)',
  docs:     'var(--h-docs)',
  doc:      'var(--h-docs)',
  wiki:     'var(--h-docs)',
  devops:   'var(--h-devops)',
  infra:    'var(--h-devops)',
  design:   'oklch(66% 0.14 290)',
  ml:       'oklch(66% 0.14 190)',
  ai:       'oklch(66% 0.14 190)',
  architect:'oklch(68% 0.10 240)',
  reporter: 'oklch(70% 0.12 100)',
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function agentHue(name: string): string {
  const key = name.trim().toLowerCase();
  if (NAMED_HUES[key]) return NAMED_HUES[key];
  // Fallback: hash name → hue
  const hue = hashStr(key) % 360;
  return `oklch(66% 0.12 ${hue})`;
}

export function agentInitials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const p = parts[0];
    if (p.length <= 2) return p.toUpperCase();
    return (p[0] + p[p.length - 1]).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
