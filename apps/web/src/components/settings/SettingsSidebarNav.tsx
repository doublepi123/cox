import { useTranslation } from "../../i18n";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  GlobeIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  FlaskConicalIcon,
  BotIcon,
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
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
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
import { validateSettingsScopeSearch } from "./settingsScope";
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
  layout?: "sidebar" | "bar";
}) {
  const { t, language } = useTranslation();
  const navArea = workspaceAreaProps("settings-nav", 0, t("Settings sections"));
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = validateSettingsScopeSearch(currentSearch);
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const navPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
  const sectionNavigation = useSettingsSectionNavigation(
    navPaths.find((to) => activePath === to || activePath.startsWith(`${to}/`)) ??
      navPaths[0] ??
      "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Below md the nav is an icon rail; searching expands it over the page.
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
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
    if (event.key === "Escape" && (isSearching || layout === "bar")) {
      event.preventDefault();
      event.stopPropagation();
      if (isSearching) clearSearch();
      else setCompactSearchOpen(false);
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

  if (layout === "bar" && !compactSearchOpen) {
    return (
      <nav
        role="navigation"
        aria-label={t("Settings sections")}
        className="shrink-0 border-b bg-sidebar px-3 py-2 text-sidebar-foreground"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 [&_[data-slot=select-trigger]]:h-11 [&_[data-slot=select-trigger]]:min-w-0">
            <Select
              value={
                navPaths.find((to) => activePath === to || activePath.startsWith(`${to}/`)) ?? null
              }
              onValueChange={(value) => {
                const path = navPaths.find((to) => to === value);
                if (path) handleSectionClick(path);
              }}
            >
              <SelectTrigger aria-label={t("Settings sections")}>
                <SelectValue>
                  {(value: SettingsPath | null) =>
                    value ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <SettingsSectionIcon to={value} />
                        <span className="truncate">{t(SETTINGS_SECTION_LABELS[value])}</span>
                      </span>
                    ) : (
                      t("Settings")
                    )
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {SETTINGS_NAV_GROUPS.map((group, index) => (
                  <SelectGroup key={group.heading ?? index}>
                    {group.heading ? <SelectGroupLabel>{t(group.heading)}</SelectGroupLabel> : null}
                    {group.paths.map((to) => (
                      <SelectItem key={to} value={to}>
                        <span className="flex min-h-9 items-center gap-2">
                          <SettingsSectionIcon to={to} />
                          {t(SETTINGS_SECTION_LABELS[to])}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Button
            size="icon-xl"
            variant="ghost-muted"
            aria-label={t("Search settings")}
            onClick={() => setCompactSearchOpen(true)}
          >
            <SearchIcon />
          </Button>
        </div>
      </nav>
    );
  }

  const searchField = (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        !compactSearchOpen && "max-md:hidden",
        layout === "bar" &&
          "h-11 px-0 [&_[data-slot=input]]:min-h-11 max-sm:[&_[data-slot=input]]:text-base",
      )}
    >
      {layout === "bar" ? (
        <Button
          type="button"
          size="icon-xl"
          variant="ghost-muted"
          aria-label={t("Close")}
          onClick={() => {
            clearSearch();
            setCompactSearchOpen(false);
          }}
        >
          <ArrowLeftIcon />
        </Button>
      ) : (
        <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
      )}
      <SidebarInput
        ref={searchInputRef}
        nativeInput
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActiveResultIndex(0);
        }}
        onKeyDown={handleSearchKeyDown}
        autoComplete="off"
        onFocus={() => setCompactSearchOpen(true)}
        onBlur={() => {
          if (!isSearching && layout !== "bar") setCompactSearchOpen(false);
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
        className="min-w-0 flex-1"
      />
      {isSearching ? (
        <Button
          type="button"
          size={layout === "bar" ? "icon-xl" : "icon-micro"}
          variant="ghost-muted"
          aria-label={t("Clear settings search")}
          onClick={() => {
            clearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className={layout === "bar" ? "size-4" : "size-3"} />
        </Button>
      ) : layout !== "bar" ? (
        <Kbd>/</Kbd>
      ) : null}
    </div>
  );

  return (
    <nav
      {...(layout === "bar" ? {} : navArea)}
      role="navigation"
      aria-label={t("Settings sections")}
      className={cn(
        "flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-14",
        layout === "bar" && "[&_[data-slot=sidebar-menu-button]]:min-h-11",
        compactSearchOpen &&
          "max-md:absolute max-md:inset-y-0 max-md:start-0 max-md:z-10 max-md:w-full",
      )}
    >
      <SidebarContent
        className="overflow-x-hidden"
        fixedHeader={layout === "bar" ? <div className="p-2">{searchField}</div> : undefined}
      >
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            {layout === "bar" ? null : searchField}
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {t("No settings found")}
              </p>
            ) : null}
            {layout === "bar" && compactSearchOpen && !isSearching ? (
              <p role="status" className="px-3 py-6 text-sm text-sidebar-muted-foreground">
                {t("Type to search settings")}
              </p>
            ) : isSearching ? (
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
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
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
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div className="flex flex-col gap-4">
                {compactSearchOpen ? null : (
                  <SidebarMenu className="md:hidden">
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label={t("Search settings")}
                        onClick={() => setCompactSearchOpen(true)}
                      >
                        <SearchIcon />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                )}
                <div
                  {...sectionNavigation.containerProps}
                  role="tree"
                  aria-label={t("Settings sections")}
                  className="flex flex-col gap-4"
                >
                  {SETTINGS_NAV_GROUPS.map((group, index) => (
                    <div
                      key={group.heading ?? index}
                      role="group"
                      aria-label={group.heading ? t(group.heading) : undefined}
                      className="flex flex-col gap-1 max-md:border-t max-md:border-sidebar-border max-md:pt-4 max-md:first:border-t-0 max-md:first:pt-0"
                    >
                      {group.heading ? (
                        // The group carries this label; a heading is not a valid tree child.
                        <h3
                          aria-hidden="true"
                          className={cn(
                            "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
                            !compactSearchOpen && "max-md:hidden",
                          )}
                        >
                          {t(group.heading)}
                        </h3>
                      ) : null}
                      <SidebarMenu role="presentation">
                        {group.paths.map((to) => {
                          const Icon = SETTINGS_SECTION_ICONS[to];
                          const isActive = activePath === to || activePath.startsWith(`${to}/`);
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
                                  className={cn("truncate", !compactSearchOpen && "max-md:sr-only")}
                                >
                                  {t(SETTINGS_SECTION_LABELS[to])}
                                </span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}
