import { createRef, useState, type Ref, type CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Button, InlineButton } from "./button";
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "./combobox";
import { Command, CommandInput, CommandItem, CommandList, CommandPanel } from "./command";
import { Dialog, DialogClose, DialogPopup, DialogTitle, DialogTrigger } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { ScrollArea } from "./scroll-area";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

import "~/index.css";

function ModelCombobox({ inputRef }: { inputRef: Ref<HTMLInputElement> }) {
  const [model, setModel] = useState<string | null>("Alpha");
  return (
    <Combobox items={["Alpha", "Beta"]} value={model} onValueChange={setModel}>
      <ComboboxInput
        ref={inputRef}
        aria-label="Model selection"
        showClear
        startAddon={<span aria-hidden>A</span>}
      />
      <ComboboxPopup width="md">
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

describe("semantic control variants", () => {
  it.each([390, 1280])(
    "preserves fixed selection and responsive media navigation placement at %spx",
    async (width) => {
      await page.viewport(width, 800);
      await using screen = await render(
        <div style={{ position: "relative", width: 300, height: 200 }}>
          <Button placement="selection" style={{ left: 80, top: 120 }}>
            Cite
          </Button>
          <Button variant="media-navigation" navigation="previous" aria-label="Previous media">
            Previous
          </Button>
          <Button variant="media-navigation" navigation="next" aria-label="Next media">
            Next
          </Button>
        </div>,
      );
      const selection = screen.getByRole("button", { name: "Cite" }).element();
      expect(getComputedStyle(selection).position).toBe("fixed");
      expect(selection.getBoundingClientRect().left).toBe(80);
      expect(selection.getBoundingClientRect().top).toBe(120);
      const previous = screen.getByRole("button", { name: "Previous media" }).element();
      const next = screen.getByRole("button", { name: "Next media" }).element();
      expect(previous.getBoundingClientRect().left).toBe(0);
      expect(next.getBoundingClientRect().right).toBe(300);
      if (width < 640) {
        expect(previous.getBoundingClientRect().bottom).toBe(200);
        expect(next.getBoundingClientRect().bottom).toBe(200);
      } else {
        expect(
          previous.getBoundingClientRect().top + previous.getBoundingClientRect().height / 2,
        ).toBe(100);
        expect(next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2).toBe(
          100,
        );
      }
    },
  );
  it("keeps menu trigger refs, keyboard activation, and disabled tooltips on the control", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    const selected = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <Menu>
          <span className="inline-flex w-48">
            <MenuTrigger render={<Button ref={buttonRef} fill align="between" />}>
              Actions
            </MenuTrigger>
          </span>
          <MenuPopup width="anchor">
            <Tooltip>
              <TooltipTrigger render={<MenuItem disabled disabledHover />}>
                Unavailable
              </TooltipTrigger>
              <TooltipPopup>Install the provider first</TooltipPopup>
            </Tooltip>
            <MenuItem onClick={selected}>Run action</MenuItem>
          </MenuPopup>
        </Menu>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(buttonRef.current).toBe(trigger.element());
    expect(trigger.element().parentElement?.tagName).toBe("SPAN");
    expect(trigger.element().getBoundingClientRect().width).toBe(192);
    await act(() => buttonRef.current?.focus());
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "Run action" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Unavailable" }).hover();
    await expect.element(page.getByText("Install the provider first")).toBeVisible();
    await page.getByRole("menuitem", { name: "Run action" }).click();
    expect(selected).toHaveBeenCalledOnce();
    await expect.element(trigger).toHaveFocus();
  });

  it.each([390, 1280])(
    "preserves combobox input adornments, refs, clearing, and selection at %spx",
    async (width) => {
      await page.viewport(width, 800);
      const inputRef = createRef<HTMLInputElement>();
      await using screen = await render(<ModelCombobox inputRef={inputRef} />);
      const input = screen.getByRole("combobox", { name: "Model selection" });
      expect(inputRef.current).toBe(input.element());
      expect(
        Number.parseFloat(getComputedStyle(inputRef.current!).paddingInlineStart),
      ).toBeGreaterThanOrEqual(28);
      expect(
        Number.parseFloat(getComputedStyle(inputRef.current!).paddingInlineEnd),
      ).toBeGreaterThanOrEqual(26);
      const clear = screen.container.querySelector<HTMLButtonElement>(
        "[data-slot=combobox-clear]",
      )!;
      expect(clear.tagName).toBe("BUTTON");
      await page.elementLocator(clear).click();
      await expect.element(input).toHaveValue("");
      await input.fill("Beta");
      await page.getByRole("option", { name: "Beta" }).click();
      await expect.element(input).toHaveValue("Beta");
    },
  );

  it("keeps command input metrics and composition events on the native input", async () => {
    await page.viewport(1280, 800);
    const composing = vi.fn();
    const inputRef = createRef<HTMLInputElement>();
    await using screen = await render(
      <div style={{ width: 400, "--command-shell-inset": "12px" } as CSSProperties}>
        <Command>
          <CommandInput ref={inputRef} aria-label="Commands" onCompositionEnd={composing} />
          <CommandPanel sizing="default">
            <CommandList>
              <CommandItem value="hello">Hello</CommandItem>
            </CommandList>
          </CommandPanel>
        </Command>
      </div>,
    );
    expect(inputRef.current).toBe(screen.getByRole("combobox", { name: "Commands" }).element());
    expect(Number.parseFloat(getComputedStyle(inputRef.current!).paddingInlineStart)).toBe(36);
    await act(() => {
      inputRef.current!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      inputRef.current!.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
      );
    });
    expect(composing).toHaveBeenCalledOnce();
  });

  it.each([390, 1280])(
    "keeps dialog width, dismissal, and focus restoration at %spx",
    async (width) => {
      await page.viewport(width, 800);
      const triggerRef = createRef<HTMLButtonElement>();
      await using screen = await render(
        <Dialog>
          <DialogTrigger render={<Button ref={triggerRef} />}>Open editor</DialogTrigger>
          <DialogPopup width="3xl" showCloseButton={false}>
            <DialogTitle>Editor</DialogTitle>
            <Input aria-label="Editor name" />
            <DialogClose render={<Button />}>Close editor</DialogClose>
          </DialogPopup>
        </Dialog>,
      );
      await screen.getByRole("button", { name: "Open editor" }).click();
      const dialog = page.getByRole("dialog", { name: "Editor" });
      await expect.element(dialog).toBeVisible();
      const bounds = dialog.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      if (width > 640)
        await expect.poll(() => dialog.element().getBoundingClientRect().width).toBe(768);
      await page.getByRole("button", { name: "Close editor" }).click();
      await expect.element(screen.getByRole("button", { name: "Open editor" })).toHaveFocus();
      expect(triggerRef.current).toBe(
        screen.getByRole("button", { name: "Open editor" }).element(),
      );
    },
  );

  it("preserves stacked labels, compact switches, loading dimensions, and constrained scrolling", async () => {
    await using screen = await render(
      <div style={{ width: 320 }}>
        <Label htmlFor="stacked-input" layout="stacked">
          Value
          <Input id="stacked-input" />
        </Label>
        <Switch size="compact" aria-label="Start from remote" />
        <div className="flex items-center gap-2">
          <Skeleton width="1.5rem" height="1.5rem" />
          <InlineButton fit>Details</InlineButton>
        </div>
        <ScrollArea preset="picker">
          <div style={{ height: 600 }}>Long content</div>
        </ScrollArea>
      </div>,
    );
    const input = screen.getByRole("textbox", { name: "Value" });
    expect(getComputedStyle(input.element().closest("label")!).flexDirection).toBe("column");
    expect(
      screen.getByRole("switch", { name: "Start from remote" }).element().getBoundingClientRect()
        .height,
    ).toBe(14);
    const skeleton = screen.container.querySelector("[data-slot=skeleton]")!;
    expect(skeleton.getBoundingClientRect().width).toBe(24);
    expect(skeleton.getBoundingClientRect().height).toBe(24);
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    expect(viewport.clientHeight).toBeLessThanOrEqual(256);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    await act(() => {
      viewport.scrollTop = 100;
    });
    expect(viewport.scrollTop).toBe(100);
  });
});
