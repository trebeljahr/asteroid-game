export type ShipAction = "fire" | "thrust" | "turnLeft" | "turnRight";

interface ShipInputReceiver {
  clear(): void;
  isActive(action: ShipAction): boolean;
  setActionState(action: ShipAction, active: boolean, sourceId: string): void;
}

interface InputCommand {
  execute(receiver: ShipInputReceiver, active: boolean): void;
}

class SetShipActionCommand implements InputCommand {
  action: ShipAction;
  sourceId: string;

  constructor(action: ShipAction, sourceId: string) {
    this.action = action;
    this.sourceId = sourceId;
  }

  execute(receiver: ShipInputReceiver, active: boolean) {
    receiver.setActionState(this.action, active, this.sourceId);
  }
}

class ShipInputBuffer implements ShipInputReceiver {
  activeSources: Record<ShipAction, Set<string>>;

  constructor() {
    this.activeSources = {
      fire: new Set<string>(),
      thrust: new Set<string>(),
      turnLeft: new Set<string>(),
      turnRight: new Set<string>(),
    };
  }

  clear() {
    for (const action in this.activeSources) {
      this.activeSources[action as ShipAction].clear();
    }
  }

  isActive(action: ShipAction) {
    return this.activeSources[action].size > 0;
  }

  setActionState(action: ShipAction, active: boolean, sourceId: string) {
    if (active) {
      this.activeSources[action].add(sourceId);
      return;
    }

    this.activeSources[action].delete(sourceId);
  }
}

/** Canvas position of the mouse or pen the player aims with. */
export interface AimPointer {
  /** True while the primary button is held down on the canvas. */
  firing: boolean;
  /** performance.now() of the last move or press. */
  movedAt: number;
  x: number;
  y: number;
}

const inputBuffer = new ShipInputBuffer();
const commands = new Map<string, InputCommand>();
const aimPointer: AimPointer = { firing: false, movedAt: 0, x: 0, y: 0 };

/**
 * A click can be shorter than one simulation tick. Hold the trigger at
 * least this long, so every click fires a shot.
 */
const MIN_POINTER_FIRE_MS = 40;

let aimDirection: number | null = null;
let aimPointerPressedAt = 0;
let aimPointerReleaseTimer: number | null = null;
let initialized = false;

const defaultKeyboardBindings: Array<{ action: ShipAction; code: string }> = [
  { action: "thrust", code: "ArrowUp" },
  { action: "thrust", code: "KeyW" },
  { action: "turnLeft", code: "ArrowLeft" },
  { action: "turnLeft", code: "KeyA" },
  { action: "turnRight", code: "ArrowRight" },
  { action: "turnRight", code: "KeyD" },
  { action: "fire", code: "Space" },
];

const isLikelyTouchDevice = () => {
  return window.matchMedia("(pointer: coarse)").matches || window.navigator.maxTouchPoints > 0;
};

const onKeyboardInput = (active: boolean) => {
  return (event: KeyboardEvent) => {
    const causeId = `keyboard:${event.code}`;
    const command = commands.get(causeId);
    if (command === undefined) {
      return;
    }

    event.preventDefault();
    command.execute(inputBuffer, active);
  };
};

const clearInputOnHidden = () => {
  if (!document.hidden) {
    return;
  }
  clearShipInput();
};

const cancelAimPointerRelease = () => {
  if (aimPointerReleaseTimer !== null) {
    window.clearTimeout(aimPointerReleaseTimer);
    aimPointerReleaseTimer = null;
  }
};

// Touch aims with the on-screen stick instead, see mobileControls.
const trackAimPointer = (canvas: HTMLCanvasElement) => {
  const updatePosition = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    aimPointer.x = event.clientX - bounds.left;
    aimPointer.y = event.clientY - bounds.top;
    aimPointer.movedAt = performance.now();
  };

  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") {
      return;
    }
    updatePosition(event);
  });
  // Only presses that land on the canvas fire, so menu clicks never shoot.
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || event.button !== 0) {
      return;
    }
    updatePosition(event);
    cancelAimPointerRelease();
    aimPointer.firing = true;
    aimPointerPressedAt = performance.now();
  });
  window.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch" || event.button !== 0 || !aimPointer.firing) {
      return;
    }
    const remaining = MIN_POINTER_FIRE_MS - (performance.now() - aimPointerPressedAt);
    if (remaining <= 0) {
      aimPointer.firing = false;
      return;
    }
    cancelAimPointerRelease();
    aimPointerReleaseTimer = window.setTimeout(() => {
      aimPointerReleaseTimer = null;
      aimPointer.firing = false;
    }, remaining);
  });
  window.addEventListener("pointercancel", (event) => {
    if (event.pointerType === "touch") {
      return;
    }
    cancelAimPointerRelease();
    aimPointer.firing = false;
  });
};

export const registerActionCause = (causeId: string, action: ShipAction) => {
  commands.set(causeId, new SetShipActionCommand(action, causeId));
};

export const dispatchActionCause = (causeId: string, active: boolean) => {
  const command = commands.get(causeId);
  if (command === undefined) {
    return;
  }
  command.execute(inputBuffer, active);
};

export const clearShipInput = () => {
  inputBuffer.clear();
  cancelAimPointerRelease();
  aimPointer.firing = false;
  aimDirection = null;
};

/** The aiming mouse or pen, or null until one has moved over the page. */
export const getAimPointer = (): Readonly<AimPointer> | null => {
  return aimPointer.movedAt === 0 ? null : aimPointer;
};

/** World angle the touch aim stick points at, or null while it is centered. */
export const getAimDirection = () => {
  return aimDirection;
};

export const setAimDirection = (angle: number | null) => {
  aimDirection = angle;
};

export const initializeShipInput = (canvas: HTMLCanvasElement) => {
  if (initialized) {
    return;
  }

  for (let i = 0; i < defaultKeyboardBindings.length; i++) {
    const binding = defaultKeyboardBindings[i];
    registerActionCause(`keyboard:${binding.code}`, binding.action);
  }

  window.addEventListener("keydown", onKeyboardInput(true));
  window.addEventListener("keyup", onKeyboardInput(false));
  window.addEventListener("blur", clearShipInput);
  trackAimPointer(canvas);
  document.addEventListener("visibilitychange", clearInputOnHidden);
  initialized = true;
};

export const isShipActionActive = (action: ShipAction) => {
  return inputBuffer.isActive(action);
};

export const isMobileDevice = () => {
  return isLikelyTouchDevice() && Math.min(window.innerWidth, window.innerHeight) <= 1200;
};

export const isMobilePortrait = () => {
  return isMobileDevice() && window.innerHeight > window.innerWidth;
};

export const requestLandscapeOrientationLock = () => {
  if (!isMobileDevice()) {
    return;
  }

  const orientationApi = window.screen.orientation as
    | (ScreenOrientation & {
        lock?: (orientation: "landscape") => Promise<void>;
      })
    | undefined;
  if (orientationApi === undefined || typeof orientationApi.lock !== "function") {
    return;
  }

  void orientationApi.lock("landscape").catch(() => {
    // Some browsers only allow this after a user gesture. The rotate prompt remains as a fallback.
  });
};
