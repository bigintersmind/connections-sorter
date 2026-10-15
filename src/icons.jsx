// The app's six icons, drawn inline so they come from the same place on every
// platform. Libre Franklin doesn't carry symbols like ⋯ ✕ ↑ ↗, so a text
// character renders from whatever font the OS falls back to, with its own
// weight and baseline — and Android and Windows each fall back to a different
// font again. An SVG is the same 16-unit drawing everywhere.
//
// Each is 1em square and drawn in `currentColor`, so it takes the size and
// color of the text it sits in, and each is `aria-hidden`: every one of them
// is decoration next to a visible label or an `aria-label` that already says
// what the control does (see the "Accessibility contracts" in CLAUDE.md).
// `.icon` in index.css handles the baseline alignment; `.icon-before` /
// `.icon-after` add the gap that the old strings carried as a literal space.

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

// `{...rest}` goes FIRST so a caller's props can't clobber the fixed ones:
// `aria-hidden` and `focusable` are the accessibility contract above, not a
// default to be overridden, and the geometry is what makes every icon the same
// 1em drawing. `className` is destructured out of `rest`, so it still merges
// with `.icon` rather than replacing it.
function Icon({ className = "", children, ...rest }) {
  return (
    <svg
      {...rest}
      className={`icon ${className}`.trim()}
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Three dots: the overflow ("More options") trigger. */
export function MoreIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="2.75" cy="8" r="1.75" fill="currentColor" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" />
      <circle cx="13.25" cy="8" r="1.75" fill="currentColor" />
    </Icon>
  );
}

/** A cross: dismiss the notice bar. */
export function CloseIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" {...STROKE} />
    </Icon>
  );
}

/** A closed padlock: the row is locked. */
export function LockIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="7.5" width="10" height="6.5" rx="1.5" {...STROKE} />
      <path d="M5.5 7.5V5.25a2.5 2.5 0 0 1 5 0V7.5" {...STROKE} />
    </Icon>
  );
}

/** An open padlock: the row is not locked yet. The same arch as LockIcon's,
 *  lifted a unit (its left leg lengthened so it still meets the body), with no
 *  right leg: the stroke ends where the arc comes down on the right, 3.25 units
 *  above the body. At 15px it is that gap, and the lopsided shackle, that read
 *  as "open". */
export function LockOpenIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="7.5" width="10" height="6.5" rx="1.5" {...STROKE} />
      <path d="M5.5 7.5V4.25a2.5 2.5 0 0 1 5 0" {...STROKE} />
    </Icon>
  );
}

/** An up arrow: points at the picked-up tile above the hint line. */
export function ArrowUpIcon(props) {
  return (
    <Icon {...props}>
      <path d="M8 13V3M4 7l4-4 4 4" {...STROKE} />
    </Icon>
  );
}

/** A north-east arrow: the link leaves the site. */
export function ExternalIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4.5 11.5l7-7M6 4.5h5.5V10" {...STROKE} />
    </Icon>
  );
}
