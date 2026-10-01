import type { ReactElement } from "react";

export type IconName = "arrow" | "bluetooth" | "check" | "chevron" | "close" | "controller" | "exit" | "help" | "pause" | "power" | "settings" | "tool" | "vehicle" | "warning";
const paths: Record<IconName, ReactElement> = {
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  bluetooth: <><path d="m7 7 10 10-5 4V3l5 4L7 17" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  exit: <><path d="M9 4H4v16h5m4-12 4 4-4 4m-5-4h12" /></>,
  controller: <><path d="M8 7h8c3 0 4 3 5 9 .5 3-2 4-4 1l-1-1H8l-1 1c-2 3-4.5 2-4-1 1-6 2-9 5-9Z"/><path d="M7 10v4m-2-2h4m6-1h.01M18 13h.01" /></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .5-1.5 1-1.5 2m0 3h.01" /></>,
  pause: <><path d="M9 5v14M15 5v14" /></>,
  power: <><path d="M12 3v8m-5-6a8 8 0 1 0 10 0"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  tool: <><path d="m14 6 4 4 3-3a6 6 0 0 1-8 7l-6 6a2 2 0 0 1-3-3l6-6a6 6 0 0 1 7-8l-3 3Z"/></>,
  vehicle: <><path d="m3 15 1-6h4l2-4h6l3 4h2v6H3Z"/><circle cx="7" cy="16" r="2"/><circle cx="17" cy="16" r="2"/><path d="M10 9h8"/></>,
  warning: <><path d="m10.2 4-8 14a1.3 1.3 0 0 0 1 2h17.6a1.3 1.3 0 0 0 1-2l-8-14a2 2 0 0 0-3.6 0Z"/><path d="M12 9v4m0 3h.01"/></>
};
export function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}
