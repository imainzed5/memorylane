import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy, Scissors, TextSelect, type LucideIcon } from "lucide-react";
import { ICON_STROKE_WIDTH } from "../constants";
import type { CaptureRecord } from "../types";
import { Kbd } from "./primitives";

export type ContextMenuAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export type ContextMenuEntry = ContextMenuAction | { id: string; separator: true };

export type CaptureMenuSurface = "viewer" | "filmstrip" | "gallery" | "review";

/** Built in App.tsx so every surface offers the same capture actions. */
export type CaptureMenuBuilder = (
  capture: CaptureRecord,
  options: {
    surface: CaptureMenuSurface;
    source: HTMLElement | null;
    /** Lets surfaces that keep their own copy of the capture (the gallery) apply the change. */
    onChange?: (patch: Partial<CaptureRecord>) => void;
  },
) => ContextMenuEntry[];

type MenuTrigger = Pick<MouseEvent, "clientX" | "clientY" | "target"> & { preventDefault: () => void };

type OpenContextMenu = (event: MenuTrigger, items: ContextMenuEntry[], label?: string) => void;

const ContextMenuContext = createContext<OpenContextMenu>(() => undefined);

/** Returns `open(event, items, label?)`. Call it from an `onContextMenu` handler. */
export function useContextMenu(): OpenContextMenu {
  return useContext(ContextMenuContext);
}

type MenuState = {
  key: number;
  x: number;
  y: number;
  items: ContextMenuEntry[];
  label: string;
  fromKeyboard: boolean;
  returnFocus: HTMLElement | null;
};

const VIEWPORT_MARGIN = 8;

function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
  return !("separator" in entry);
}

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);

function editableTarget(target: EventTarget | null): EditableTarget | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  if (target instanceof HTMLTextAreaElement) {
    return target;
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) ? target : null;
  }
  const editable = target.closest<HTMLElement>("[contenteditable]:not([contenteditable='false'])");
  return editable?.isContentEditable ? editable : null;
}

/**
 * Replaces the WebView's browser menu (Back, Refresh, Print, Inspect…) everywhere in the app.
 * Components open their own menus through `useContextMenu`; text fields get a themed
 * Cut / Copy / Paste menu, and right-clicking anywhere else does nothing.
 * In dev builds, Shift + right-click still shows the browser menu for Inspect.
 */
export function ContextMenuProvider({ children, onMessage }: { children: ReactNode; onMessage: (message: string) => void }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const keyRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const open = useCallback<OpenContextMenu>((event, items, label = "Context menu") => {
    event.preventDefault();
    if (!items.some(isAction)) {
      return;
    }

    // Keyboard-invoked menus (Shift F10, Menu key) report no pointer, so anchor to the element.
    const pointerType = "pointerType" in event ? (event as unknown as PointerEvent).pointerType : "mouse";
    const fromKeyboard = pointerType === "" || (event.clientX === 0 && event.clientY === 0);
    let { clientX: x, clientY: y } = event;
    if (fromKeyboard && event.target instanceof Element) {
      const rect = event.target.getBoundingClientRect();
      x = rect.left + Math.min(rect.width / 2, 24);
      y = rect.top + Math.min(rect.height / 2, 24);
    }

    keyRef.current += 1;
    setMenu({
      key: keyRef.current,
      x,
      y,
      items,
      label,
      fromKeyboard,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, []);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (import.meta.env.DEV && event.shiftKey) {
        return;
      }
      event.preventDefault();

      const field = editableTarget(event.target);
      if (field) {
        open(event, buildEditMenu(field, (message) => onMessageRef.current(message)), "Edit");
        return;
      }

      const selection = window.getSelection();
      const selectedText = selection && !selection.isCollapsed ? selection.toString() : "";
      if (selectedText.trim().length > 0) {
        open(
          event,
          [
            {
              id: "copy-selection",
              label: "Copy",
              icon: Copy,
              shortcut: "Ctrl C",
              onSelect: () => {
                void writeClipboardText(selectedText).catch(() => onMessageRef.current("Unable to copy from this runtime."));
              },
            },
          ],
          "Edit",
        );
      }
    };

    // Bubble phase, after React's root listener: component handlers get the first chance.
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [open]);

  useEffect(() => {
    if (!import.meta.env.PROD) {
      return;
    }
    // Browser accelerators that reload, print, save or navigate the WebView break the app.
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;
      const blocked =
        key === "f5" ||
        key === "f3" ||
        key === "browserback" ||
        key === "browserforward" ||
        (event.altKey && (key === "arrowleft" || key === "arrowright")) ||
        (ctrl && ["r", "p", "s", "u", "f", "g"].includes(key));
      if (blocked) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const menuRef = useRef(menu);
  menuRef.current = menu;
  const close = useCallback((restoreFocus: boolean) => {
    const returnFocus = menuRef.current?.returnFocus;
    setMenu(null);
    if (restoreFocus && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  }, []);

  return (
    <ContextMenuContext.Provider value={open}>
      {children}
      {menu ? createPortal(<ContextMenu key={menu.key} menu={menu} onClose={close} />, document.body) : null}
    </ContextMenuContext.Provider>
  );
}

type ContextMenuProps = {
  menu: MenuState;
  onClose: (restoreFocus: boolean) => void;
};

function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const actionIndexes = useMemo(
    () => menu.items.flatMap((entry, index) => (isAction(entry) && !entry.disabled ? [index] : [])),
    [menu.items],
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(menu.fromKeyboard ? actionIndexes[0] ?? null : null);
  const [placement, setPlacement] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    const flipX = menu.x + width > window.innerWidth - VIEWPORT_MARGIN;
    const flipY = menu.y + height > window.innerHeight - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, flipX ? menu.x - width : menu.x);
    const top = Math.max(VIEWPORT_MARGIN, flipY ? menu.y - height : menu.y);
    setPlacement({ left, top, origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}` });
  }, [menu.x, menu.y]);

  // Focus only once placed: the measuring pass is visibility:hidden, which cannot take focus.
  const isPlaced = placement !== null;
  useLayoutEffect(() => {
    if (isPlaced) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [isPlaced]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) {
        onClose(false);
      }
    };
    // Wheel, not scroll: selecting a filmstrip thumb scrolls it programmatically while opening.
    const onWheel = (event: Event) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) {
        onClose(false);
      }
    };
    const onBlur = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onBlur);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const activate = (entry: ContextMenuAction) => {
    if (entry.disabled) {
      return;
    }
    onClose(true);
    entry.onSelect();
  };

  const move = (step: number) => {
    if (actionIndexes.length === 0) {
      return;
    }
    const position = activeIndex === null ? (step > 0 ? -1 : actionIndexes.length) : actionIndexes.indexOf(activeIndex);
    const next = (position + step + actionIndexes.length) % actionIndexes.length;
    setActiveIndex(actionIndexes[next]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Keep the app's single-key shortcuts from firing behind the menu.
    event.stopPropagation();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(actionIndexes[0] ?? null);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(actionIndexes[actionIndexes.length - 1] ?? null);
        return;
      case "Enter":
      case " ": {
        event.preventDefault();
        const entry = activeIndex === null ? null : menu.items[activeIndex];
        if (entry && isAction(entry)) {
          activate(entry);
        }
        return;
      }
      case "Escape":
        event.preventDefault();
        onClose(true);
        return;
      case "Tab":
        event.preventDefault();
        onClose(true);
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // Type-ahead: jump to the next item starting with that letter.
          const letter = event.key.toLowerCase();
          const start = activeIndex === null ? -1 : actionIndexes.indexOf(activeIndex);
          for (let offset = 1; offset <= actionIndexes.length; offset += 1) {
            const index = actionIndexes[(start + offset) % actionIndexes.length];
            const entry = menu.items[index];
            if (isAction(entry) && entry.label.toLowerCase().startsWith(letter)) {
              setActiveIndex(index);
              break;
            }
          }
        }
    }
  };

  const activeId = activeIndex === null ? undefined : `context-menu-item-${menu.key}-${activeIndex}`;

  return (
    <div
      ref={ref}
      className="context-menu popover"
      role="menu"
      aria-label={menu.label}
      aria-activedescendant={activeId}
      tabIndex={-1}
      style={
        placement
          ? { left: placement.left, top: placement.top, transformOrigin: placement.origin }
          : { left: menu.x, top: menu.y, visibility: "hidden" }
      }
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      onPointerLeave={() => setActiveIndex(null)}
    >
      {menu.items.map((entry, index) => {
        if (!isAction(entry)) {
          return <div key={entry.id} className="menu-separator" role="separator" />;
        }
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            id={`context-menu-item-${menu.key}-${index}`}
            className={[
              "menu-item",
              "menu-item-roving",
              entry.danger ? "menu-item-danger" : "",
              index === activeIndex ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            aria-disabled={entry.disabled || undefined}
            onPointerMove={() => {
              if (!entry.disabled && activeIndex !== index) {
                setActiveIndex(index);
              }
            }}
            onClick={() => activate(entry)}
          >
            {Icon ? <Icon className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" /> : <span aria-hidden="true" />}
            <span>{entry.label}</span>
            {entry.shortcut ? <Kbd>{entry.shortcut}</Kbd> : null}
          </button>
        );
      })}
    </div>
  );
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("copy failed");
  }
}

function buildEditMenu(field: EditableTarget, onMessage: (message: string) => void): ContextMenuEntry[] {
  const isTextControl = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
  const readOnly = isTextControl ? field.readOnly || field.disabled : false;
  const isPassword = field instanceof HTMLInputElement && field.type === "password";

  // The menu takes focus, so remember the caret/selection and put it back before acting.
  let range: [number, number] | null = null;
  if (isTextControl) {
    try {
      range = [field.selectionStart ?? 0, field.selectionEnd ?? 0];
    } catch {
      range = null; // number inputs do not expose a selection
    }
  }
  const domRange = !isTextControl && window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
  const hasSelection = isTextControl
    ? range !== null && range[0] !== range[1]
    : Boolean(domRange && !domRange.collapsed);

  const restore = () => {
    field.focus({ preventScroll: true });
    if (isTextControl && range) {
      try {
        field.setSelectionRange(range[0], range[1]);
      } catch {
        // ignore inputs without selection support
      }
    } else if (domRange) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(domRange);
    }
  };

  const run = (command: "cut" | "copy" | "selectAll") => () => {
    restore();
    document.execCommand(command);
  };

  return [
    { id: "cut", label: "Cut", icon: Scissors, shortcut: "Ctrl X", disabled: readOnly || isPassword || !hasSelection, onSelect: run("cut") },
    { id: "copy", label: "Copy", icon: Copy, shortcut: "Ctrl C", disabled: isPassword || !hasSelection, onSelect: run("copy") },
    {
      id: "paste",
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: "Ctrl V",
      disabled: readOnly,
      onSelect: () => {
        void (async () => {
          try {
            const text = await navigator.clipboard.readText();
            restore();
            // insertText keeps the field's undo history and fires React's onChange.
            document.execCommand("insertText", false, text);
          } catch {
            restore();
            if (!document.execCommand("paste")) {
              onMessage("Press Ctrl V to paste here.");
            }
          }
        })();
      },
    },
    { id: "edit-separator", separator: true },
    { id: "select-all", label: "Select All", icon: TextSelect, shortcut: "Ctrl A", onSelect: run("selectAll") },
  ];
}
