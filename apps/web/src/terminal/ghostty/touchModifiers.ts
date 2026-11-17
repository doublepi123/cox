export type TerminalModifierState = "off" | "oneshot" | "locked";
export type TerminalModifier = "ctrl" | "alt";

const LEGACY_CONTROL_CODES: Readonly<Record<string, number>> = {
  " ": 0,
  "@": 0,
  "2": 0,
  "3": 27,
  "4": 28,
  "\\": 28,
  "5": 29,
  "]": 29,
  "6": 30,
  "^": 30,
  "~": 30,
  "7": 31,
  "/": 31,
  _: 31,
  "8": 127,
  "?": 127,
};

export class TerminalTouchModifiers {
  private state: Readonly<Record<TerminalModifier, TerminalModifierState>> = {
    ctrl: "off",
    alt: "off",
  };
  private readonly listeners = new Set<() => void>();
  private readonly tappedAt = { ctrl: -Infinity, alt: -Infinity };

  readonly getSnapshot = (): Readonly<Record<TerminalModifier, TerminalModifierState>> =>
    this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  tap(modifier: TerminalModifier, time: number): void {
    const current: TerminalModifierState = this.getSnapshot()[modifier];
    let next: TerminalModifierState;
    switch (current) {
      case "off":
        next = "oneshot";
        break;
      case "oneshot":
        next = time - this.tappedAt[modifier] <= 350 ? "locked" : "off";
        break;
      case "locked":
        next = "off";
        break;
      default:
        current satisfies never;
        return;
    }
    this.tappedAt[modifier] = time;
    this.update({ ...this.state, [modifier]: next });
  }

  get active(): boolean {
    return this.state.ctrl !== "off" || this.state.alt !== "off";
  }

  encode(
    text: string,
    encodeKey?: (character: string, ctrl: boolean, alt: boolean) => string,
  ): string {
    let encoded = "";
    for (const character of text) {
      const ctrl = this.state.ctrl !== "off";
      const alt = this.state.alt !== "off";
      if (encodeKey !== undefined && (ctrl || alt)) {
        encoded += encodeKey(character, ctrl, alt);
      } else {
        const code = character.charCodeAt(0);
        const controlCode = /^[a-hj-ln-z]$/i.test(character)
          ? code & 0x1f
          : LEGACY_CONTROL_CODES[character];
        if (
          ctrl &&
          code >= 32 &&
          code <= 126 &&
          controlCode === undefined &&
          !/^[019]$/.test(character)
        ) {
          encoded += `\x1b[${code};${alt ? 7 : 5}u`;
        } else {
          encoded +=
            (alt ? "\x1b" : "") +
            (ctrl && controlCode !== undefined ? String.fromCharCode(controlCode) : character);
        }
      }
      this.consume();
    }
    return encoded;
  }

  consume(): void {
    if (this.state.ctrl !== "oneshot" && this.state.alt !== "oneshot") return;
    this.update({
      ctrl: this.state.ctrl === "oneshot" ? "off" : this.state.ctrl,
      alt: this.state.alt === "oneshot" ? "off" : this.state.alt,
    });
  }

  private update(state: Readonly<Record<TerminalModifier, TerminalModifierState>>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
