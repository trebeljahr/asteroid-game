import type React from "react";
import { useEffect, useState } from "react";
import { MULTIPLAYER_SHIP_VARIANTS, type ShipVariant } from "../../shared/src";
import {
  type AccountAchievement,
  type AccountState,
  consumeOldestRecentUnlock,
  getAccountState,
  subscribeToAccount,
} from "./account";
import { playSound } from "./audio";
import { isDebugToolsEnabled } from "./collisionDebug";
import { DONATE_URL } from "./donation";
import { isFullscreenActive, isFullscreenAvailable, toggleFullscreenMode } from "./fullscreen";
import { activateGameMode, restartCurrentMode } from "./gameModeActions";
import { type GameState, gameStateMachine } from "./gameState";
import {
  closeAchievementsMenu,
  closeOptionsMenu,
  openAchievementsMenu,
  openOptionsMenu,
  resumeGameplay,
  returnToMainMenu,
  toggleCollisionDebug,
  toggleNetcodeDebug,
  toggleSoundEnabled,
} from "./gameUiActions";
import { ProjectDonateLink } from "./ProjectDonateLink";
import { formatRunDuration } from "./runSession";
import { getStats, type PersistentStats, subscribeToStats } from "./stats";

const capitalizeWords = (str: string) => {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const ActionButton: React.FC<{
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "ghost";
}> = ({ label, onClick, variant = "primary" }) => (
  <button
    className={`menuButton menuButton--${variant}`}
    onClick={() => {
      playSound("menuConfirm");
      onClick();
    }}
    type="button"
  >
    {label}
  </button>
);

const PanelCloseButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button className="menuPanelClose" onClick={onClick} type="button" aria-label={label}>
    X
  </button>
);

const ShipSelection: React.FC<{ currentVariant: ShipVariant }> = ({ currentVariant }) => (
  <div className="shipSelection">
    <h2 className="shipSelectionLabel">Choose Your Ship</h2>
    <div className="shipGrid">
      {MULTIPLAYER_SHIP_VARIANTS.map((variant) => (
        <button
          key={variant}
          type="button"
          className={`shipItem ${variant === currentVariant ? "is-selected" : ""}`}
          onClick={() => gameStateMachine.send({ type: "SELECT_SHIP", shipVariant: variant })}
        >
          <picture>
            <source srcSet={`/assets/alternatives/ship-alt-${variant}.svg`} type="image/svg+xml" />
            <img
              className="shipImage"
              src={`/assets/alternatives/ship-alt-${variant}.png`}
              alt={capitalizeWords(variant)}
            />
          </picture>
          <span className="shipName">{capitalizeWords(variant)}</span>
        </button>
      ))}
    </div>
  </div>
);

const CreditsSection: React.FC = () => (
  <div className="creditsSection">
    <h2 className="creditsSectionTitle">Credits</h2>
    <p className="creditsLine">
      Made by{" "}
      <a href="https://ricotrebeljahr.de" target="_blank" rel="noopener noreferrer">
        Rico Trebeljahr
      </a>
    </p>
    <p className="creditsLine">
      Icons by{" "}
      <a href="https://www.flaticon.com/authors/freepik" target="_blank" rel="noopener noreferrer">
        Freepik
      </a>{" "}
      and{" "}
      <a
        href="https://www.flaticon.com/authors/smashicons"
        target="_blank"
        rel="noopener noreferrer"
      >
        Smashicons
      </a>{" "}
      from{" "}
      <a href="https://www.flaticon.com/" target="_blank" rel="noopener noreferrer">
        Flaticon
      </a>
    </p>
  </div>
);

const ImpressumSection: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className="creditsSection">
      <button
        type="button"
        className="creditsLine"
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "inherit",
          fontSize: "inherit",
          padding: 0,
        }}
      >
        Imprint {open ? "▾" : "▸"}
      </button>
      {open && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", lineHeight: 1.6, opacity: 0.7 }}>
          <p>Information pursuant to § 5 DDG / § 18 (2) MStV (Germany)</p>
          <p style={{ marginTop: "0.4rem" }}>
            Rico Trebeljahr
            <br />
            c/o Block Services
            <br />
            Stuttgarter Str. 106
            <br />
            70736 Fellbach, Germany
          </p>
          <p style={{ marginTop: "0.4rem" }}>Email: imprint+asteroids@trebeljahr.com</p>
        </div>
      )}
    </div>
  );
};

const useFullscreenState = (): {
  available: boolean;
  active: boolean;
  toggle: () => void;
} => {
  const [active, setActive] = useState(() => isFullscreenActive());
  useEffect(() => {
    const handleChange = () => setActive(isFullscreenActive());
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      document.removeEventListener("webkitfullscreenchange", handleChange);
    };
  }, []);
  return {
    available: isFullscreenAvailable(),
    active,
    toggle: () => {
      toggleFullscreenMode().then((nowActive) => setActive(nowActive));
    },
  };
};

const OptionsPanel: React.FC<{ state: GameState }> = ({ state }) => {
  const fullscreen = useFullscreenState();
  return (
    <section className="menuPanel">
      <h1 className="menuTitle">Options</h1>

      <div className="menuActions">
        <ActionButton
          label={state.settings.soundEnabled ? "Sound: On" : "Sound: Off"}
          onClick={toggleSoundEnabled}
        />
        {fullscreen.available && (
          <ActionButton
            label={fullscreen.active ? "Fullscreen: On" : "Fullscreen: Off"}
            onClick={fullscreen.toggle}
          />
        )}
        {isDebugToolsEnabled() && (
          <ActionButton
            label={
              state.settings.collisionDebugEnabled ? "Collision Debug: On" : "Collision Debug: Off"
            }
            onClick={toggleCollisionDebug}
          />
        )}
        {isDebugToolsEnabled() && (
          <ActionButton
            label={state.settings.netcodeDebugEnabled ? "Netcode Debug: On" : "Netcode Debug: Off"}
            onClick={toggleNetcodeDebug}
          />
        )}
        <ActionButton label="Back" onClick={closeOptionsMenu} variant="secondary" />
      </div>

      <CreditsSection />
      <ImpressumSection />
    </section>
  );
};

const useAccount = (): AccountState => {
  const [account, setAccount] = useState<AccountState>(() => getAccountState());
  useEffect(() => {
    return subscribeToAccount((next) => setAccount(next));
  }, []);
  return account;
};

const AchievementToastLayer: React.FC = () => {
  const [queue, setQueue] = useState<Array<{ achievement: AccountAchievement; id: number }>>([]);
  useEffect(() => {
    let counter = 0;
    const unsub = subscribeToAccount((next) => {
      if (next.recentUnlocks.length === 0) return;
      const unlocked = consumeOldestRecentUnlock();
      if (unlocked === null) return;
      const toastId = ++counter;
      playSound("menuConfirm");
      setQueue((current) => [...current, { achievement: unlocked, id: toastId }]);
      setTimeout(() => {
        setQueue((current) => current.filter((entry) => entry.id !== toastId));
      }, 5200);
    });
    return unsub;
  }, []);
  if (queue.length === 0) return null;
  return (
    <div className="achievementToastStack">
      {queue.map(({ achievement, id }) => (
        <div key={id} className={`achievementToast achievementToast--${achievement.rarity}`}>
          <div className="achievementToastTitle">Achievement unlocked</div>
          <div className="achievementToastName">{achievement.name}</div>
          <div className="achievementToastDescription">{achievement.description}</div>
        </div>
      ))}
    </div>
  );
};

const AchievementsPanel: React.FC = () => {
  const account = useAccount();
  const achievements = account.achievements;
  const unlocked = achievements.filter((entry) => entry.unlockedAt !== null);
  return (
    <section className="menuPanel">
      <h1 className="menuTitle menuTitle--compact">Achievements</h1>
      <PanelCloseButton label="Close achievements" onClick={closeAchievementsMenu} />
      <p className="menuSubtitle">
        {unlocked.length} of {achievements.length} unlocked
      </p>
      {account.status === "offline" && (
        <p className="menuSubtitle" style={{ opacity: 0.7 }}>
          Offline — connect to the server to sync achievements.
        </p>
      )}
      <div className="achievementList">
        {achievements.map((entry) => {
          const isUnlocked = entry.unlockedAt !== null;
          const classes = [
            "achievementRow",
            isUnlocked ? "achievementRow--unlocked" : "achievementRow--locked",
            `achievementRow--${entry.rarity}`,
          ].join(" ");
          const progressLabel =
            entry.progress !== null
              ? `${Math.min(entry.progressValue, entry.progress.target)} / ${entry.progress.target}`
              : isUnlocked
                ? "Unlocked"
                : "Locked";
          const shouldHide = entry.hidden && !isUnlocked;
          return (
            <div key={entry.id} className={classes}>
              <div className="achievementRowHeader">
                <span className="achievementRowName">{shouldHide ? "???" : entry.name}</span>
                <span className="achievementRowStatus">{progressLabel}</span>
              </div>
              <p className="achievementRowDescription">
                {shouldHide ? "Hidden achievement" : entry.description}
              </p>
              {entry.progress !== null && !isUnlocked && (
                <div className="achievementProgressBar">
                  <div
                    className="achievementProgressBarFill"
                    style={{
                      width: `${Math.min(100, (entry.progressValue / entry.progress.target) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="menuActions" style={{ marginTop: "1.4rem" }}>
        <ActionButton label="Back" onClick={closeAchievementsMenu} variant="secondary" />
      </div>
    </section>
  );
};

const useStats = (): PersistentStats => {
  const [stats, setStats] = useState<PersistentStats>(() => getStats());
  useEffect(() => {
    return subscribeToStats((next) => setStats(next));
  }, []);
  return stats;
};

const StatsLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <p className="statsLine">
    <span className="statsLabel">{label}</span>
    <span className="statsValue">{value}</span>
  </p>
);

const MainMenuPanel: React.FC<{ state: GameState }> = ({ state }) => {
  const stats = useStats();
  const bestTimeLabel =
    stats.runBestTimeMs === null ? "—" : formatRunDuration(stats.runBestTimeMs, 2);
  const multiplayerRecordLabel = `${stats.multiplayerWins}W · ${stats.multiplayerLosses}L${stats.multiplayerDraws > 0 ? ` · ${stats.multiplayerDraws}D` : ""}`;

  return (
    <section className="menuPanel">
      <h1 className="menuTitle menuTitle--main-menu">Asteroids</h1>

      <ShipSelection currentVariant={state.settings.shipVariant} />

      <div className="menuStats">
        <StatsLine label="Best run time" value={bestTimeLabel} />
        <StatsLine label="Runs finished" value={String(stats.runCompletionCount)} />
        <StatsLine label="Multiplayer record" value={multiplayerRecordLabel} />
      </div>

      <div className="menuActions">
        <ActionButton label="Singleplayer Mode" onClick={() => activateGameMode("singleplayer")} />
        <ActionButton
          label="Multiplayer Duel"
          onClick={() => activateGameMode("multiplayer")}
          variant="secondary"
        />
        <ActionButton
          label="Battle Royale (20)"
          onClick={() => activateGameMode("battle-royale")}
          variant="secondary"
        />
        <ActionButton label="Achievements" onClick={openAchievementsMenu} variant="ghost" />
        <ActionButton label="Options" onClick={openOptionsMenu} variant="ghost" />
      </div>

      <div className="creditsSection">
        <p className="creditsLine">
          <ProjectDonateLink href={DONATE_URL} target="_blank" rel="noopener noreferrer">
            Donate
          </ProjectDonateLink>
        </p>
      </div>
    </section>
  );
};

const PausePanel: React.FC<{ state: GameState }> = ({ state }) => {
  const modeLabel =
    state.scene.type === "mode"
      ? state.scene.mode === "singleplayer"
        ? "Singleplayer"
        : capitalizeWords(state.scene.mode)
      : "Game";
  return (
    <section className="menuPanel menuPanel--pause">
      <h1 className="menuTitle menuTitle--compact">{modeLabel} Paused</h1>
      <PanelCloseButton label="Close pause menu" onClick={resumeGameplay} />
      <div className="menuActions menuActions--pause">
        <ActionButton label="Resume" onClick={resumeGameplay} />
        <ActionButton label="Achievements" onClick={openAchievementsMenu} variant="secondary" />
        <ActionButton label="Options" onClick={openOptionsMenu} variant="secondary" />
        <ActionButton label="Main Menu" onClick={returnToMainMenu} variant="ghost" />
      </div>
    </section>
  );
};

const ResultPanel: React.FC<{ state: GameState; title: string; subtitle: string }> = ({
  state: _state,
  title,
  subtitle,
}) => (
  <section className="menuPanel">
    <h1 className="menuTitle">{title}</h1>
    <p className="menuSubtitle">{subtitle}</p>

    <div className="menuActions">
      <ActionButton label="Try Again" onClick={restartCurrentMode} />
      <ActionButton label="Options" onClick={openOptionsMenu} variant="secondary" />
      <ActionButton label="Main Menu" onClick={returnToMainMenu} variant="ghost" />
    </div>
  </section>
);

type MenuRockConfig = {
  svgSrc: string;
  pngSrc: string;
  left: string;
  top: string;
  size: string;
  opacity: string;
  duration: string;
  delay: string;
  driftX: string;
  driftY: string;
};

const MenuRock: React.FC<{ config: MenuRockConfig }> = ({ config }) => (
  <picture>
    <source srcSet={config.svgSrc} type="image/svg+xml" />
    <img
      className="menuRock"
      src={config.pngSrc}
      alt=""
      style={{
        // @ts-expect-error
        "--rock-left": config.left,
        "--rock-top": config.top,
        "--rock-size": config.size,
        "--rock-opacity": config.opacity,
        "--rock-duration": config.duration,
        "--rock-delay": config.delay,
        "--rock-drift-x": config.driftX,
        "--rock-drift-y": config.driftY,
      }}
    />
  </picture>
);

const MenuScene: React.FC = () => {
  const menuRocks = [
    {
      svgSrc: "/assets/asteroid1.svg",
      pngSrc: "/assets/asteroid1.png",
      left: "8%",
      top: "10%",
      size: "11rem",
      opacity: "0.38",
      duration: "26s",
      delay: "-7s",
      driftX: "2.5rem",
      driftY: "1.75rem",
    },
    {
      svgSrc: "/assets/asteroid2.svg",
      pngSrc: "/assets/asteroid2.png",
      left: "78%",
      top: "14%",
      size: "9rem",
      opacity: "0.28",
      duration: "22s",
      delay: "-11s",
      driftX: "-1.25rem",
      driftY: "2rem",
    },
    {
      svgSrc: "/assets/asteroid3.svg",
      pngSrc: "/assets/asteroid3.png",
      left: "15%",
      top: "68%",
      size: "13rem",
      opacity: "0.2",
      duration: "31s",
      delay: "-5s",
      driftX: "3rem",
      driftY: "-2.5rem",
    },
    {
      svgSrc: "/assets/asteroid2.svg",
      pngSrc: "/assets/asteroid2.png",
      left: "70%",
      top: "62%",
      size: "15rem",
      opacity: "0.18",
      duration: "34s",
      delay: "-13s",
      driftX: "-2.75rem",
      driftY: "-1.5rem",
    },
    {
      svgSrc: "/assets/asteroid1.svg",
      pngSrc: "/assets/asteroid1.png",
      left: "47%",
      top: "6%",
      size: "7rem",
      opacity: "0.22",
      duration: "19s",
      delay: "-3s",
      driftX: "1.5rem",
      driftY: "2.25rem",
    },
  ];

  return (
    <div className="menuScene">
      <div className="menuBackdrop" aria-hidden="true" />
      <div className="menuGlow" />
      {menuRocks.map((rock) => (
        <MenuRock key={`${rock.svgSrc}-${rock.left}-${rock.top}`} config={rock} />
      ))}
      <div className="menuScenePane" />
    </div>
  );
};

export const App: React.FC = () => {
  const [state, setState] = useState<GameState>(gameStateMachine.getState());

  useEffect(() => {
    return gameStateMachine.subscribe((newState) => {
      setState(newState);
    });
  }, []);

  const shouldShowMenu =
    state.scene.type === "main-menu" || state.scene.type === "result" || state.overlay !== null;
  const overlayTargetsMenu =
    state.overlay !== null &&
    (state.overlay.type === "options" || state.overlay.type === "achievements") &&
    (state.overlay.returnTarget === "main-menu" || state.overlay.returnTarget === "result");
  const shouldShowDecorativeScene =
    state.scene.type === "main-menu" || state.scene.type === "result" || overlayTargetsMenu;
  const overlayTargetsPause =
    state.overlay !== null &&
    (state.overlay.type === "options" || state.overlay.type === "achievements") &&
    state.overlay.returnTarget === "pause";
  const shouldShowGameplayShade = state.overlay?.type === "pause" || overlayTargetsPause;

  useEffect(() => {
    const root = document.getElementById("menu");
    if (!root) return;

    root.classList.toggle("is-active", shouldShowMenu);
    root.classList.toggle("has-scene", shouldShowDecorativeScene);
    root.classList.toggle("has-gameplay-shade", shouldShowGameplayShade);
  }, [shouldShowMenu, shouldShowDecorativeScene, shouldShowGameplayShade]);

  if (!shouldShowMenu) {
    return <AchievementToastLayer />;
  }

  return (
    <>
      {shouldShowDecorativeScene && <MenuScene />}
      <div className="menuContent">
        {state.overlay?.type === "options" && <OptionsPanel state={state} />}
        {state.overlay?.type === "achievements" && <AchievementsPanel />}
        {state.overlay === null && state.scene.type === "main-menu" && (
          <MainMenuPanel state={state} />
        )}
        {state.overlay?.type === "pause" && <PausePanel state={state} />}
        {state.scene.type === "result" && state.overlay === null && (
          <ResultPanel state={state} title={state.scene.title} subtitle={state.scene.subtitle} />
        )}
      </div>
      <AchievementToastLayer />
    </>
  );
};
