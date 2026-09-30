import type { ReactNode, SVGProps } from "react";
import type { PlayerRole } from "../../lib/leaderboard";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function StrokeIcon({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="m6 9 6 6 6-6" />
    </StrokeIcon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="m9 6 6 6-6 6" />
    </StrokeIcon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </StrokeIcon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </StrokeIcon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </StrokeIcon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </StrokeIcon>
  );
}

/** League of Legends position glyphs, drawn on the game's own 34px grid. */
const ROLE_PATHS: Record<PlayerRole, { dim?: string; solid: string }> = {
  TOP: {
    dim: "M21 14h-7v7h7v-7Zm5-3v15H11.014l-4 4H30V7.016Z",
    solid: "M4 4 4.003 28.045 9 23V9h14l5.045-4.997Z",
  },
  JUNGLE: {
    solid: "M25 3c-2.128 3.3-5.147 6.851-6.966 11.469A42.373 42.373 0 0 1 20 20a27.7 27.7 0 0 1 1-3c0-4.977 1.856-8.723 4-14ZM13 20c-1.488-4.487-4.76-6.966-9-9 3.868 3.136 4.422 7.52 5 12l3.743 3.312C14.215 27.917 16.527 30.451 17 31c4.555-9.445-3.366-20.8-8-28 2.67 6.573 4.717 10.342 4 17Zm8 5a15.271 15.271 0 0 1 0 2l4-4c.578-4.48 1.132-8.864 5-12-5.288 2.537-7.866 7.854-9 14Z",
  },
  MIDDLE: {
    dim: "m30 12.968-4.008 4L26 26h-9l-4 4h17ZM16.979 8 21 4H4v16.977L8 17V8h8.981Z",
    solid: "M25 4 4 25v5h5L30 9V4Z",
  },
  BOTTOM: {
    dim: "M13 20h7v-7h-7v7ZM4 4v22.984l3.955-4L8 8h14.986l4-4H4Z",
    solid: "M29.997 5.955 25 11v14H11l-5.045 4.997L30 30Z",
  },
  UTILITY: {
    solid: "M26 13c3.535 0 8-4 8-4H23l-3 3 2 7 5-2-3-4h2ZM22 5l-1.173-2h-7.765L12 5l5 6Zm-5 9-1-1-3 15 4 3 4-3-3-15ZM11 9H0s4.465 4 8 4h2l-3 4 5 2 2-7Z",
  },
  UNKNOWN: {
    solid: "M17 5a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm0 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 0 1 0-19.6Zm-.2 4.3c-2.2 0-3.8 1.3-4 3.3h2.2c.1-.8.8-1.3 1.7-1.3 1 0 1.7.6 1.7 1.4 0 .7-.4 1.1-1.3 1.7-1.1.7-1.6 1.4-1.6 2.6v.5h2.2v-.4c0-.7.3-1.1 1.2-1.6 1.1-.7 1.8-1.5 1.8-2.9 0-2-1.6-3.3-4-3.3Zm-1.3 10.2v2.3h2.4v-2.3Z",
  },
};

export function RoleIcon({ role, size = 13, className }: { role: PlayerRole; size?: number; className?: string }) {
  const paths = ROLE_PATHS[role];
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 34 34" fill="currentColor" aria-hidden="true" focusable="false">
      {paths.dim ? <path opacity=".45" d={paths.dim} /> : null}
      <path d={paths.solid} />
    </svg>
  );
}
