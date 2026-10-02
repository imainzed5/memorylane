import { flushSync } from "react-dom";

export const HERO_TRANSITION_NAME = "capture-hero";

type ViewTransitionLike = { finished: Promise<void> };
type DocumentWithViewTransitions = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

type ViewTransitionOptions = {
  /** Tags the transition on <html data-transition> so CSS can scope animations (e.g. "workspace"). */
  kind?: string;
  /** Element in the current view that should morph into the hero target. */
  heroSource?: HTMLElement | null;
  /** Selector for the element in the next view that receives the morph. */
  heroTargetSelector?: string;
};

/**
 * Runs a React state update inside a View Transition when the runtime supports it.
 * With a hero source/target pair, the source element morphs into the target
 * (thumbnail -> viewer, viewer -> Quick Look). Falls back to a plain update.
 */
export function runViewTransition(update: () => void, options: ViewTransitionOptions = {}): void {
  const doc = document as DocumentWithViewTransitions;
  if (typeof doc.startViewTransition !== "function" || prefersReducedMotion()) {
    update();
    return;
  }

  const { heroSource, heroTargetSelector, kind } = options;
  const root = document.documentElement;
  if (kind) {
    root.dataset.transition = kind;
  }
  heroSource?.style.setProperty("view-transition-name", HERO_TRANSITION_NAME);
  let heroTarget: HTMLElement | null = null;

  try {
    const transition = doc.startViewTransition(() => {
      heroSource?.style.removeProperty("view-transition-name");
      flushSync(update);

      if (heroSource && heroTargetSelector) {
        heroTarget = document.querySelector<HTMLElement>(heroTargetSelector);
        heroTarget?.style.setProperty("view-transition-name", HERO_TRANSITION_NAME);
      }
    });

    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        heroTarget?.style.removeProperty("view-transition-name");
        if (kind && root.dataset.transition === kind) {
          delete root.dataset.transition;
        }
      });
  } catch {
    heroSource?.style.removeProperty("view-transition-name");
    delete root.dataset.transition;
    update();
  }
}
