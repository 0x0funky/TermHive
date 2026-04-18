/**
 * Icon set for the TermHive Hive Dashboard redesign.
 * Stroke-based, inherits currentColor. Use <Ic.name size={...} />.
 */

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

const Ic = {
  search: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M7 12.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM11.2 11.2l3 3" />
    </svg>
  ),
  chevR: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M6 3l4 5-4 5" />
    </svg>
  ),
  chevD: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M3 6l5 4 5-4" />
    </svg>
  ),
  plus: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  x: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
  play: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="currentColor" style={p.style}>
      <path d="M5 3.5l7 4.5-7 4.5V3.5z" />
    </svg>
  ),
  stop: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="currentColor" style={p.style}>
      <path d="M4 4h8v8H4z" />
    </svg>
  ),
  restart: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M13 8a5 5 0 11-1.5-3.5M13 3v3h-3" />
    </svg>
  ),
  grid: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h5v5h-5zM8.5 2.5h5v5h-5zM2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z" />
    </svg>
  ),
  single: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h11v11h-11z" />
    </svg>
  ),
  threeup: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2 3h3v10H2zM6.5 3h3v10h-3zM11 3h3v10h-3z" />
    </svg>
  ),
  twoup: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h5v11h-5zM8.5 2.5h5v11h-5z" />
    </svg>
  ),
  focus: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h8v11h-8zM11.5 3h2v3h-2zM11.5 6.5h2v3h-2zM11.5 10h2v3h-2z" />
    </svg>
  ),
  canvas: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2 2.5h5v4H2zM8.5 3.5h5v3h-5zM3 8.5h4v4.5H3zM9 8h5v5h-5z" />
    </svg>
  ),
  panelLeft: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h11v11h-11zM6 2.5v11" />
    </svg>
  ),
  panelLeftOpen: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h11v11h-11zM6 2.5v11M8.5 6l2 2-2 2" />
    </svg>
  ),
  pin: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 1.5v5M5 3.5h6M6.5 6.5L4 12h8L9.5 6.5M8 12v2.5" />
    </svg>
  ),
  splitH: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.2} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h9v9h-9zM7 2.5v9" />
    </svg>
  ),
  splitV: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.2} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 2.5h9v9h-9zM2.5 7h9" />
    </svg>
  ),
  sun: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 11a3 3 0 100-6 3 3 0 000 6zM8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" />
    </svg>
  ),
  moon: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M13 9.5A5.5 5.5 0 116.5 3 4 4 0 0013 9.5z" />
    </svg>
  ),
  bolt: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="currentColor" style={p.style}>
      <path d="M9 1.5L3.5 9h4l-1 5.5L12 7H8l1-5.5z" />
    </svg>
  ),
  terminal: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 3.5h11v9h-11zM4.5 6l2 2-2 2M8 10h3" />
    </svg>
  ),
  message: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2.5 3.5h11v8h-4l-2.5 2.5V11.5h-4.5z" />
    </svg>
  ),
  activity: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M1.5 8h3l2-5 3 10 2-5h3" />
    </svg>
  ),
  book: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M3 3.5a1.5 1.5 0 011.5-1.5H13v11H4.5A1.5 1.5 0 003 14.5v-11zM3 14.5a1.5 1.5 0 011.5-1.5H13" />
    </svg>
  ),
  file: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M4 1.5h5L13 5.5v9H4v-13zM9 1.5V5.5h4" />
    </svg>
  ),
  folder: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M2 3.5h4l1.5 1.5H14v8H2v-9.5z" />
    </svg>
  ),
  hash: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M6 2v12M10 2v12M2 6h12M2 10h12" />
    </svg>
  ),
  user: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 8.5a3 3 0 100-6 3 3 0 000 6zM2 14c0-2.5 2.5-4 6-4s6 1.5 6 4" />
    </svg>
  ),
  arrowR: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  dots: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 2} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
    </svg>
  ),
  dollar: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 2v12M11 5H7a2 2 0 000 4h2a2 2 0 010 4H5" />
    </svg>
  ),
  send: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M14 2L7 9M14 2L9.5 14L7 9L2 6.5L14 2z" />
    </svg>
  ),
  sparkles: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M8 1v5l3 2-3 2v5l-3-5-5 3 5-3-5-3 5 3 3-5z" />
    </svg>
  ),
  menu: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" style={p.style}>
      <path d="M3 5h12M3 9h12M3 13h12" />
    </svg>
  ),
  gear: (p: IconProps = {}) => (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.strokeWidth || 1.5} strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
};

export default Ic;

// OS-aware mod key symbol (for keyboard shortcut hints)
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
