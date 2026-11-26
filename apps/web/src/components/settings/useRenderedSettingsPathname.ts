import { useLocation, useMatches } from "@tanstack/react-router";

// useLocation switches as soon as a navigation starts, while <Outlet> keeps the old page until
// the next route's lazy chunk loads. Chrome that frames the page must follow the committed match.
export function useRenderedSettingsPathname(): string {
  const pathname = useMatches({
    select: (matches) => (matches.length > 1 ? matches.at(-1)?.pathname : undefined),
  });
  const fallback = useLocation({
    select: (location) => (pathname === undefined ? location.pathname : ""),
  });
  return pathname ?? fallback;
}
