import { useTranslation } from "../../i18n";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  GlobeIcon,
  ArchiveIcon,
  FlaskConicalIcon,
  BotIcon,
  Layers3Icon,
  CalendarClockIcon,
  FileDiffIcon,
  FolderTreeIcon,
  GitBranchIcon,
  InfoIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  KeyRoundIcon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  revealSettingsSearchTarget,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { useSettingsSectionNavigation } from "./useSettingsSectionNavigation";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/browser": GlobeIcon,
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": WrenchIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/chat": MessageSquareTextIcon,
  "/settings/diffs": FileDiffIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/providers": BotIcon,
  "/settings/model-services": Layers3Icon,
  "/settings/threads": MessagesSquareIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/worktrees": FolderTreeIcon,
  "/settings/access": ShieldCheckIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/labs": FlaskConicalIcon,
  "/settings/about": InfoIcon,
  "/settings/archived": ArchiveIcon,
};

// Detail pages without a nav entry highlight the page that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/maintenance",
  "/settings/open-source-licenses": "/settings/about",
};

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

export function SettingsSidebarNav({
  pathname,
  layout = "sidebar",
}: {
  pathname: string;
  layout?: "sidebar" | "menu";
}) {
  const { t, language } = useTranslation();
  const isMenuLayout = layout === "menu";
  const navArea = workspaceAreaProps("settings-nav", 0, t("Settings sections"));
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const navPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
  const sectionNavigation = useSettingsSectionNavigation(
    navPaths.find((to) => activePath === to || activePath.startsWith(`${to}/`)) ??
      navPaths[0] ??
      "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Below md the sidebar is an icon rail; searching expands it over the page.
  // The phone menu layout keeps labels visible and starts with search closed.
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems();
  const results = searchSettings(query, searchableItems, language);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the find and slash search shortcuts
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      setCompactSearchOpen(true);
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the search input DOM node after the compact search opens
  useEffect(() => {
    if (compactSearchOpen) searchInputRef.current?.focus();
  }, [compactSearchOpen]);

  const handleSectionClick = (to: SettingsPath) => {
    setCompactSearchOpen(false);
    void navigate({
      to,
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    setCompactSearchOpen(false);
    const targetId = item.targetId ?? item.id;
    revealSettingsSearchTarget(targetId);
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  const showLabels = isMenuLayout || compactSearchOpen;
  const searchField = (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        !isMenuLayout && !compactSearchOpen && "max-md:hidden",
        isMenuLayout &&
          "h-11 rounded-lg bg-sidebar-row-hover px-3 [&_[data-slot=input]]:min-h-11 max-sm:[&_[data-slot=input]]:text-base",
      )}
    >
      <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
      {/* Native search inputs clear on Escape even during IME composition. */}
      <div className="min-w-0 flex-1">
        <SidebarInput
          ref={searchInputRef}
          nativeInput
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveResultIndex(0);
          }}
          onKeyDown={handleSearchKeyDown}
          autoComplete="off"
          onFocus={() => setCompactSearchOpen(true)}
          onBlur={() => {
            if (!isSearching && !isMenuLayout) setCompactSearchOpen(false);
          }}
          placeholder={t("Search")}
          aria-label={t("Search settings")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearching && hasResults}
          aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
          aria-activedescendant={
            isSearching && results[activeResultIndex]
              ? `settings-search-result-${results[activeResultIndex].id}`
              : undefined
          }
        />
      </div>
      {isSearching ? (
        <Button
          type="button"
          size={isMenuLayout ? "icon-xl" : "icon-micro"}
          variant="ghost-muted"
          aria-label={t("Clear settings search")}
          onClick={() => {
            clearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className={isMenuLayout ? "size-4" : "size-3"} />
        </Button>
      ) : !isMenuLayout ? (
        <Kbd>/</Kbd>
      ) : null}
    </div>
  );

  return (
    <nav
      {...(isMenuLayout ? {} : navArea)}
      role="navigation"
      aria-label={t("Settings sections")}
      className={cn(
        "flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-14",
        isMenuLayout &&
          "w-full max-md:w-full border-e-0 [&_[data-slot=sidebar-menu-button]]:min-h-11",
        !isMenuLayout &&
          compactSearchOpen &&
          "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10 max-md:w-full",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden">
        <SidebarContent
          fixedHeader={isMenuLayout ? <div className="border-b p-3">{searchField}</div> : undefined}
        >
          <SidebarGroup>
            <div className={cn("flex flex-col gap-2", isMenuLayout && "px-1 pt-2")}>
              {isMenuLayout ? null : searchField}
              {isSearching && results.length === 0 ? (
                <p
                  role="status"
                  className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
                >
                  {t("No settings found")}
                </p>
              ) : null}
              {isSearching ? (
                <SidebarMenu
                  id={hasResults ? "settings-search-results" : undefined}
                  role={hasResults ? "listbox" : undefined}
                  aria-label={hasResults ? t("Settings search results") : undefined}
                >
                  {results.map((item, index) => (
                    <SidebarMenuItem
                      key={item.id}
                      role="presentation"
                      ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                    >
                      <button
                        type="button"
                        id={`settings-search-result-${item.id}`}
                        role="option"
                        aria-selected={index === activeResultIndex}
                        tabIndex={-1}
                        data-active={index === activeResultIndex}
                        className="flex min-h-11 w-full cursor-pointer items-start gap-[var(--sidebar-control-gap)] overflow-hidden rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-2 text-left text-xs text-sidebar-muted-foreground/80 outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected [&>svg]:size-4 [&>svg]:shrink-0"
                        onMouseMove={() => setActiveResultIndex(index)}
                        onClick={() => handleSearchResultClick(item)}
                      >
                        <SettingsSectionIcon to={item.to} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-sidebar-foreground">
                            {t(item.title)}
                          </span>
                          <span className="block truncate text-2xs text-sidebar-muted-foreground/75 max-sm:text-xs">
                            {t(SETTINGS_SECTION_LABELS[item.to])}
                          </span>
                        </span>
                      </button>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              ) : (
                <div className="flex flex-col gap-4">
                  {!isMenuLayout && !compactSearchOpen ? (
                    <div className="md:hidden">
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            aria-label={t("Search settings")}
                            onClick={() => setCompactSearchOpen(true)}
                          >
                            <SearchIcon />
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </div>
                  ) : null}
                  <div
                    {...sectionNavigation.containerProps}
                    role="tree"
                    aria-label={t("Settings sections")}
                    className="flex flex-col gap-4"
                  >
                    {SETTINGS_NAV_GROUPS.filter((group) => group.paths.length > 0).map(
                      (group, index) => (
                        <div
                          key={group.heading ?? index}
                          role="group"
                          aria-label={group.heading ? t(group.heading) : undefined}
                          className={cn(
                            "flex flex-col gap-1",
                            !isMenuLayout &&
                              "max-md:border-t max-md:border-sidebar-border max-md:pt-4 max-md:first:border-t-0 max-md:first:pt-0",
                            isMenuLayout && index > 0 && "border-t border-sidebar-border pt-4",
                          )}
                        >
                          {group.heading ? (
                            // The group carries this label; a heading is not a valid tree child.
                            <h3
                              aria-hidden="true"
                              className={cn(
                                "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
                                !showLabels && "max-md:hidden",
                              )}
                            >
                              {t(group.heading)}
                            </h3>
                          ) : null}
                          <SidebarMenu role="presentation">
                            {group.paths.map((to) => {
                              const Icon = SETTINGS_SECTION_ICONS[to];
                              const isActive =
                                !isMenuLayout &&
                                (activePath === to || activePath.startsWith(`${to}/`));
                              return (
                                <SidebarMenuItem key={to} role="presentation">
                                  <SidebarMenuButton
                                    data-settings-section={to}
                                    role="treeitem"
                                    tabIndex={sectionNavigation.tabIndexFor(to)}
                                    aria-selected={isActive}
                                    aria-current={isActive ? "page" : undefined}
                                    isActive={isActive}
                                    onClick={() => handleSectionClick(to)}
                                  >
                                    <Icon />
                                    <span
                                      className={cn("truncate", !showLabels && "max-md:sr-only")}
                                    >
                                      {t(SETTINGS_SECTION_LABELS[to])}
                                    </span>
                                  </SidebarMenuButton>
                                </SidebarMenuItem>
                              );
                            })}
                          </SidebarMenu>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </SidebarGroup>
        </SidebarContent>
      </div>
    </nav>
  );
}
