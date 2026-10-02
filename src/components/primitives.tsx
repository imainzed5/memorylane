import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

type SegmentOption<T extends string> = {
  value: T;
  label: ReactNode;
};

type SegmentedControlProps<T extends string> = {
  ariaLabel: string;
  options: SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  stretch?: boolean;
};

/** Segmented control whose selection pill springs between options. */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  size = "md",
  stretch = false,
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const indicator = useSlidingIndicator(containerRef, value, "x");

  return (
    <div
      ref={containerRef}
      className={["segmented", `segmented-${size}`, stretch ? "segmented-stretch" : ""].join(" ").trim()}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      <span className={indicator.ready ? "segmented-indicator is-ready" : "segmented-indicator"} style={indicator.style} aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "segmented-option active" : "segmented-option"}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-indicator-key={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Measures the element tagged `data-indicator-key={activeKey}` inside the container and
 * returns styles for an absolutely positioned pill. Transitions only start after the
 * first measurement so the pill never animates in from the origin.
 */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
  axis: "x" | "y",
) {
  const [rect, setRect] = useState<{ offset: number; size: number; cross: number; crossSize: number } | null>(null);
  const [ready, setReady] = useState(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container || activeKey === null) {
      setRect(null);
      return;
    }

    const target = Array.from(container.querySelectorAll<HTMLElement>("[data-indicator-key]")).find(
      (element) => element.dataset.indicatorKey === activeKey,
    );
    if (!target) {
      setRect(null);
      return;
    }

    setRect(
      axis === "x"
        ? { offset: target.offsetLeft, size: target.offsetWidth, cross: target.offsetTop, crossSize: target.offsetHeight }
        : { offset: target.offsetTop, size: target.offsetHeight, cross: target.offsetLeft, crossSize: target.offsetWidth },
    );
  }, [activeKey, axis, containerRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, measure]);

  useEffect(() => {
    if (rect && !ready) {
      const frame = window.requestAnimationFrame(() => setReady(true));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [rect, ready]);

  const style: React.CSSProperties = rect
    ? axis === "x"
      ? { transform: `translate3d(${rect.offset}px, 0, 0)`, width: rect.size, top: rect.cross, height: rect.crossSize, opacity: 1 }
      : { transform: `translate3d(0, ${rect.offset}px, 0)`, height: rect.size, left: rect.cross, width: rect.crossSize, opacity: 1 }
    : { opacity: 0 };

  return { style, ready };
}

/** Closes a popover on outside pointer-down or Escape (captured before the global shortcut handler). */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onDismiss: () => void,
  { closeOnEscape = true }: { closeOnEscape?: boolean } = {},
) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeOnEscape, isOpen, onDismiss, ref]);
}

type WorkspaceHeaderProps = {
  title: string;
  subtitle?: ReactNode;
  accessory?: ReactNode;
};

export function WorkspaceHeader({ title, subtitle, accessory }: WorkspaceHeaderProps) {
  return (
    <header className="workspace-head">
      <div className="workspace-head-copy">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {accessory ? <div className="workspace-head-accessory">{accessory}</div> : null}
    </header>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
