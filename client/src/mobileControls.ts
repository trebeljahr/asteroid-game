import { type GameMode, gameStateMachine, getGameState } from "./gameState";
import { handleEscapeKey } from "./gameUiActions";
import {
  clearShipInput,
  dispatchActionCause,
  isMobileDevice,
  isMobilePortrait,
  registerActionCause,
  requestLandscapeOrientationLock,
  type ShipAction,
  setAimDirection,
} from "./input";

interface MobileButtonConfig {
  action: ShipAction;
  causeId: string;
  label: string;
  modes?: GameMode[];
  side: "left" | "right";
  variant?: "accent";
}

const mobileButtons: MobileButtonConfig[] = [
  {
    action: "turnLeft",
    causeId: "mobile:turnLeft",
    label: "Left",
    side: "left",
  },
  {
    action: "turnRight",
    causeId: "mobile:turnRight",
    label: "Right",
    side: "left",
  },
  {
    action: "thrust",
    causeId: "mobile:thrust",
    label: "Boost",
    side: "right",
    variant: "accent",
  },
  {
    action: "fire",
    causeId: "mobile:fire",
    label: "Fire",
    modes: ["horde"],
    side: "right",
  },
];

/** Modes where the aim stick replaces the plain fire button. */
const AIM_STICK_MODES: GameMode[] = ["multiplayer", "battle-royale"];
const AIM_STICK_CAUSE_ID = "mobile:aimStick";
/** Share of the stick's travel the knob must leave the center by before it aims. */
const AIM_STICK_DEADZONE = 0.32;

let initialized = false;

const isSupportedMobileMode = (mode: GameMode | null) => {
  return mode === "singleplayer" || mode === "multiplayer" || mode === "battle-royale";
};

const shouldShowTouchControls = () => {
  const state = getGameState();
  return (
    isMobileDevice() &&
    state.scene.type === "mode" &&
    isSupportedMobileMode(state.scene.mode) &&
    state.overlay === null
  );
};

const syncCauseState = (causeId: string, pointerIds: Set<number>) => {
  dispatchActionCause(causeId, pointerIds.size > 0);
};

const bindButtonPress = (button: HTMLButtonElement, causeId: string) => {
  const pointerIds = new Set<number>();

  const syncPressedState = () => {
    button.classList.toggle("is-pressed", pointerIds.size > 0);
  };

  const releasePointer = (pointerId: number) => {
    pointerIds.delete(pointerId);
    syncCauseState(causeId, pointerIds);
    syncPressedState();
  };

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    requestLandscapeOrientationLock();
    pointerIds.add(event.pointerId);
    button.setPointerCapture(event.pointerId);
    syncCauseState(causeId, pointerIds);
    syncPressedState();
  });

  button.addEventListener("pointerup", (event) => {
    releasePointer(event.pointerId);
  });
  button.addEventListener("pointercancel", (event) => {
    releasePointer(event.pointerId);
  });
  button.addEventListener("lostpointercapture", (event) => {
    releasePointer(event.pointerId);
  });

  return () => {
    pointerIds.clear();
    syncCauseState(causeId, pointerIds);
    syncPressedState();
  };
};

const createActionButton = (config: MobileButtonConfig) => {
  registerActionCause(config.causeId, config.action);

  const button = document.createElement("button");
  button.type = "button";
  button.className = `mobileControlButton${config.variant === "accent" ? " mobileControlButton--accent" : ""}`;
  button.textContent = config.label;
  return {
    button,
    reset: bindButtonPress(button, config.causeId),
  };
};

/**
 * A fire button that also aims. Holding it fires straight ahead, like the
 * button it replaces. Dragging the knob off center turns the shots toward
 * the drag direction, independent of where the ship points.
 */
const createAimStick = () => {
  registerActionCause(AIM_STICK_CAUSE_ID, "fire");

  const stick = document.createElement("div");
  stick.className = "mobileAimStick";

  const knob = document.createElement("div");
  knob.className = "mobileAimStickKnob";
  knob.textContent = "Fire";
  stick.appendChild(knob);

  const hint = document.createElement("span");
  hint.className = "mobileAimStickHint";
  hint.textContent = "Drag to aim";
  knob.appendChild(hint);

  let activePointerId: number | null = null;

  const moveKnob = (event: PointerEvent) => {
    const bounds = stick.getBoundingClientRect();
    const travel = (bounds.width - knob.offsetWidth) / 2;
    const offsetX = event.clientX - (bounds.left + bounds.width / 2);
    const offsetY = event.clientY - (bounds.top + bounds.height / 2);
    const distance = Math.hypot(offsetX, offsetY);
    const reach = distance > travel && distance > 0 ? travel / distance : 1;

    knob.style.transform = `translate(${offsetX * reach}px, ${offsetY * reach}px)`;
    const aiming = distance > travel * AIM_STICK_DEADZONE;
    stick.classList.toggle("is-aiming", aiming);
    // The camera never rotates, so a screen direction is a world direction.
    setAimDirection(aiming ? Math.atan2(offsetY, offsetX) : null);
  };

  const reset = () => {
    activePointerId = null;
    knob.style.transform = "";
    stick.classList.remove("is-pressed", "is-aiming");
    setAimDirection(null);
    dispatchActionCause(AIM_STICK_CAUSE_ID, false);
  };

  const release = (event: PointerEvent) => {
    if (event.pointerId === activePointerId) {
      reset();
    }
  };

  stick.addEventListener("pointerdown", (event) => {
    if (activePointerId !== null) {
      return;
    }
    event.preventDefault();
    requestLandscapeOrientationLock();
    activePointerId = event.pointerId;
    stick.classList.add("is-pressed");
    dispatchActionCause(AIM_STICK_CAUSE_ID, true);
    moveKnob(event);
    // Keep receiving the drag after the finger leaves the stick.
    stick.setPointerCapture(event.pointerId);
  });
  stick.addEventListener("pointermove", (event) => {
    if (event.pointerId === activePointerId) {
      moveKnob(event);
    }
  });
  stick.addEventListener("pointerup", release);
  stick.addEventListener("pointercancel", release);
  stick.addEventListener("lostpointercapture", release);

  return { reset, stick };
};

const createControlsRoot = () => {
  const root = document.createElement("div");
  root.className = "mobileControlsRoot";

  const topBar = document.createElement("div");
  topBar.className = "mobileControlsTopBar";

  const topBarActions = document.createElement("div");
  topBarActions.className = "mobileControlsTopBarActions";

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "mobileMenuButton";
  menuButton.textContent = "Menu";
  menuButton.addEventListener("click", () => {
    handleEscapeKey();
  });
  topBarActions.appendChild(menuButton);

  topBar.appendChild(topBarActions);
  root.appendChild(topBar);

  const bottomRow = document.createElement("div");
  bottomRow.className = "mobileControlsBottomRow";

  const leftCluster = document.createElement("div");
  leftCluster.className = "mobileControlCluster mobileControlCluster--left";

  const rightCluster = document.createElement("div");
  rightCluster.className = "mobileControlCluster mobileControlCluster--right";
  const resetControls: Array<() => void> = [];
  const buttonEntries: Array<{
    button: HTMLButtonElement;
    config: MobileButtonConfig;
    reset: () => void;
  }> = [];

  for (let i = 0; i < mobileButtons.length; i++) {
    const { button, reset } = createActionButton(mobileButtons[i]);
    resetControls.push(reset);
    buttonEntries.push({
      button,
      config: mobileButtons[i],
      reset,
    });
    if (mobileButtons[i].side === "left") {
      leftCluster.appendChild(button);
      continue;
    }
    rightCluster.appendChild(button);
  }

  const aimStick = createAimStick();
  resetControls.push(aimStick.reset);
  rightCluster.appendChild(aimStick.stick);

  bottomRow.append(leftCluster, rightCluster);
  root.appendChild(bottomRow);
  return {
    aimStick,
    buttonEntries,
    resetControls,
    root,
  };
};

const createRotatePrompt = () => {
  const overlay = document.createElement("div");
  overlay.className = "mobileRotatePrompt";

  const card = document.createElement("div");
  card.className = "mobileRotateCard";

  const title = document.createElement("h2");
  title.textContent = "Rotate to landscape";
  card.appendChild(title);

  const copy = document.createElement("p");
  copy.textContent =
    "Asteroids is built for a wide cockpit view. Turn your device sideways to keep flying.";
  card.appendChild(copy);

  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "mobileRotateButton";
  hint.textContent = "Try landscape";
  hint.addEventListener("click", () => {
    requestLandscapeOrientationLock();
  });
  card.appendChild(hint);

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "mobileRotateButton mobileRotateButton--secondary";
  menuButton.textContent = "Open menu";
  menuButton.addEventListener("click", () => {
    handleEscapeKey();
  });
  card.appendChild(menuButton);

  overlay.appendChild(card);
  return {
    overlay,
  };
};

export const initializeMobileControls = () => {
  if (initialized) {
    return;
  }

  const { aimStick, buttonEntries, root: controlsRoot, resetControls } = createControlsRoot();
  const rotatePrompt = createRotatePrompt();

  const syncUi = () => {
    const state = getGameState();
    const showControls = shouldShowTouchControls();
    const showRotatePrompt = showControls && isMobilePortrait();
    const activeMode = state.scene.type === "mode" ? state.scene.mode : null;

    for (let i = 0; i < buttonEntries.length; i++) {
      const { button, config, reset } = buttonEntries[i];
      const isVisible =
        activeMode !== null && (config.modes === undefined || config.modes.includes(activeMode));
      button.hidden = !isVisible;
      if (!isVisible) {
        reset();
      }
    }

    const showAimStick = activeMode !== null && AIM_STICK_MODES.includes(activeMode);
    aimStick.stick.hidden = !showAimStick;
    if (!showAimStick) {
      aimStick.reset();
    }

    controlsRoot.classList.toggle("is-visible", showControls && !showRotatePrompt);
    rotatePrompt.overlay.classList.toggle("is-visible", showRotatePrompt);

    if (!showControls || showRotatePrompt) {
      clearShipInput();
      for (let i = 0; i < resetControls.length; i++) {
        resetControls[i]();
      }
    }
  };

  document.body.append(controlsRoot, rotatePrompt.overlay);
  gameStateMachine.subscribe(() => {
    syncUi();
  });
  window.addEventListener("resize", syncUi);
  window.addEventListener("orientationchange", syncUi);
  window.addEventListener("blur", syncUi);
  syncUi();
  initialized = true;
};
