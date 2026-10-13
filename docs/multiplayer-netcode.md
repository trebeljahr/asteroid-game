# Multiplayer Netcode Guide

This document explains the multiplayer networking architecture used in the asteroid game, the problems it solves, and how the implementation works.

## Background Reading

The implementation is based on well-established patterns from the game networking community:

- [Valve Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) — the foundational document on authoritative servers, client-side prediction, and lag compensation
- [Gabriel Gambetta: Fast-Paced Multiplayer](https://www.gabrielgambetta.com/client-server-game-architecture.html) — a four-part series that breaks down the concepts with interactive demos:
  - [Part 1: Client-Server Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html)
  - [Part 2: Client-Side Prediction and Server Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)
  - [Part 3: Entity Interpolation](https://www.gabrielgambetta.com/entity-interpolation.html)
  - [Part 4: Lag Compensation](https://www.gabrielgambetta.com/lag-compensation.html)
  - [Live Demo with Source Code](https://www.gabrielgambetta.com/client-side-prediction-live-demo.html)
- [Web Game Dev: Prediction & Reconciliation](https://www.webgamedev.com/backend/prediction-reconciliation) — web-specific considerations

## Architecture Overview

```
Browser (Client)                          Server (Node.js)
┌─────────────────────┐                   ┌─────────────────────┐
│                     │                   │                     │
│  Input (keyboard)   │                   │  Authoritative      │
│       │             │   Socket.io       │  Game State         │
│       v             │                   │       │             │
│  Prediction Tick ───┼──── input ───────>│  Server Tick Loop   │
│  Loop (16.67ms)     │    (throttled)    │  (16.67ms)          │
│       │             │                   │       │             │
│       v             │                   │       v             │
│  Predicted State    │<── snapshot ──────│  Broadcast Snapshot  │
│       │             │    (every 2       │  (every 2 ticks)    │
│       v             │     ticks)        │                     │
│  Reconciliation     │                   │                     │
│       │             │                   │                     │
│       v             │                   │                     │
│  Render (rAF)       │                   │                     │
│                     │                   │                     │
└─────────────────────┘                   └─────────────────────┘
```

### Server Authority

The server is the single source of truth for all game state. It runs a fixed-rate simulation at 60 ticks per second (`TICK_INTERVAL_MS = 1000/60 ≈ 16.67ms`). Every tick:

1. Applies each player's latest input to their state via `stepPlayerState()`
2. Advances bullet positions and checks collisions
3. Spawns/removes asteroids, ammo, and health pickups
4. Checks win/loss conditions

Every 2 ticks (~33ms), the server broadcasts a `match:snapshot` to both players containing the full authoritative state of all players and bullets.

**File:** `server/src/multiplayerService.ts` — `tickMatches()` method

### The Latency Problem

Without any client-side tricks, the flow for a player pressing "thrust" would be:

1. Client sends input to server (~50ms network latency)
2. Server processes input on next tick (~16ms)
3. Server sends snapshot back (~50ms network latency)
4. Client renders new position

**Total: ~116ms delay** between pressing a key and seeing movement. This feels terrible for a fast-paced game.

## Client-Side Prediction

The solution is to **predict locally** — run the same physics simulation on the client so the player sees immediate feedback, then correct when the server's authoritative state arrives.

### The Prediction Tick Loop

The client runs its own fixed-rate simulation at the same tick rate as the server (16.67ms), using `setInterval`. This is critical — the client and server must tick at the same rate for reconciliation to work.

Each tick of the prediction loop:

1. Reads the current input state (keyboard/touch)
2. Assigns an incrementing sequence number (`inputSeq`)
3. Buffers the input (for reconciliation replay later)
4. Steps the local physics: `stepPlayerState(predictedSelf, input, arena)`
5. Sends the input to the server (throttled to avoid flooding)

```typescript
private predictionTick() {
  // ... validation ...

  const seq = ++this.inputSeqCounter;
  const currentInput: ShipInputState = {
    fire: isShipActionActive("fire"),
    inputSeq: seq,
    thrust: isShipActionActive("thrust"),
    turnLeft: isShipActionActive("turnLeft"),
    turnRight: isShipActionActive("turnRight"),
  };

  // Buffer for reconciliation
  this.inputBuffer.push({ seq, input: currentInput });

  // Step local prediction
  stepPlayerState(this.predictedSelf, currentInput, match.arena);

  // Send to server (throttled)
  if (inputChanged || timerElapsed) {
    this.socket.emit("match:input", currentInput);
  }
}
```

**File:** `client/src/multiplayerSession.ts` — `predictionTick()` method

### Why Fixed Tick Rate Matters

Earlier attempts used the render frame rate (requestAnimationFrame, ~60fps but variable) for stepping physics. This failed because:

- The client might step 63 times between two server snapshots
- The server stepped exactly 60 times in the same period
- On reconciliation, replaying the input buffer produced a different number of steps
- The predicted position snapped backward, creating visible jitter

With a fixed `setInterval` at the same rate as the server, both sides step physics the same number of times for the same time period.

### Rendering

The render loop (`draw()`, called by p5.js via requestAnimationFrame) simply reads `predictedSelf` and draws it. No extrapolation, no interpolation — the tick loop at 60fps keeps the predicted state current enough that the render loop always has a recent position to draw.

## Server Reconciliation

When a server snapshot arrives, the client must reconcile its prediction with the authoritative state. This is where the input buffer and sequence numbers come in.

### Sequence Numbers

Each input sent to the server carries an `inputSeq` number. The server tracks the last `inputSeq` it processed for each player and includes it in the snapshot as `lastInputSeq`.

```typescript
// shared/src/multiplayerCore.ts
export interface ShipInputState {
  aimAngle?: number | null;  // see "Aiming" below
  fire: boolean;
  inputSeq: number;   // <-- sequence number
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
}

export interface MatchPlayerSnapshot {
  // ... position, velocity, health, etc.
  lastInputSeq: number;  // <-- server acknowledges this
}
```

### The Reconciliation Algorithm

When a snapshot arrives with the server's authoritative state for the local player:

1. **Accept the server state** as the new base: `predictedSelf = serverState`
2. **Discard acknowledged inputs**: remove all buffered inputs with `seq <= lastInputSeq`
3. **Replay unacknowledged inputs**: step `predictedSelf` forward once per remaining buffer entry

```typescript
private reconcilePredictedSelf(serverState, arena) {
  // 1. Accept server state
  this.predictedSelf = { ...serverState, fireCooldownTicks: 0 };

  // 2. Discard acknowledged inputs
  this.inputBuffer = this.inputBuffer.filter(
    (entry) => entry.seq > serverState.lastInputSeq
  );

  // 3. Replay unacknowledged inputs
  for (const entry of this.inputBuffer) {
    if (this.predictedSelf.health > 0) {
      stepPlayerState(this.predictedSelf, entry.input, arena);
    }
  }
}
```

### Why This Works

After reconciliation, the predicted state represents: "where the server says I am" + "the effect of inputs the server hasn't processed yet." This is exactly where the player should be rendered.

If the client's prediction was perfect (same physics, same input timing), the reconciled position matches where `predictedSelf` already was — no visible change. If there was a discrepancy (collision with another player, server-side event), the position corrects smoothly because it only jumps by the delta between predicted and actual, which is typically small.

### What the Server Tracks

The server stores the latest `inputSeq` it received from each player:

```typescript
// server/src/multiplayerService.ts
private updatePlayerInput(socketId: string, payload: ShipInputState) {
  // ...
  participant.input = payload;
  participant.state.lastInputSeq = payload.inputSeq;
}
```

This `lastInputSeq` is included in every snapshot via `snapshotPlayerState()`, telling the client "I've processed your inputs up to this number."

## Entity Interpolation (Opponent)

The opponent player is **not** predicted — the client doesn't know what inputs they're pressing. Instead, the opponent is rendered using **extrapolation** from the last server snapshot:

```typescript
const opponentPlayer = projectPlayerSnapshot(
  opponentSnapshot, predictedTicks, match.arena
);
```

`projectPlayerSnapshot` linearly extends the opponent's position using their velocity: `position + velocity * ticks`. This covers the gap between snapshots (~33ms) and network latency.

**File:** `shared/src/multiplayerCore.ts` — `projectPlayerSnapshot()`

## Network Optimization

### Throttled Sends

The prediction tick loop runs at 60fps, but not every tick needs to send input over the network. The client throttles sends:

- **On input change** (key down/up): send immediately
- **Heartbeat**: send at least every `LOCAL_INPUT_PUSH_INTERVAL_MS` (33ms) even if unchanged

Between sends, the server continues using the last received input — since input is boolean states (thrust on/off), not deltas, this is correct.

### Snapshot Rate

The server sends snapshots every 2 ticks (~33ms, 30 snapshots/second) rather than every tick. This halves bandwidth while the client's prediction loop fills the gaps.

## Physics Determinism

The prediction system relies on `stepPlayerState()` producing identical results on client and server given the same inputs. The physics is deterministic:

- Fixed timestep (no variable deltaTime)
- Deterministic math (thrust, drag, speed cap, wall bounce)
- No random elements in movement

```typescript
export const stepPlayerState = (state, input, arena) => {
  // Turn
  state.angle += (Number(input.turnRight) - Number(input.turnLeft)) * PLAYER_TURN_SPEED;

  // Thrust
  if (input.thrust) {
    state.vx += Math.cos(state.angle) * PLAYER_THRUST;
    state.vy += Math.sin(state.angle) * PLAYER_THRUST;
  }

  // Drag
  state.vx *= PLAYER_DRAG;
  state.vy *= PLAYER_DRAG;

  // Speed cap
  const speed = Math.hypot(state.vx, state.vy);
  if (speed > PLAYER_MAX_SPEED) {
    const scale = PLAYER_MAX_SPEED / speed;
    state.vx *= scale;
    state.vy *= scale;
  }

  // Move + wall bounce
  state.x = clamp(state.x + state.vx, -xLimit, xLimit);
  state.y = clamp(state.y + state.vy, -yLimit, yLimit);
};
```

**File:** `shared/src/multiplayerCore.ts` — `stepPlayerState()`

## Aiming

A shot does not have to follow the ship's heading. Each input can carry an `aimAngle`, a world-space angle in radians, and the server fires along it:

```typescript
// server, once per fired shot
createRuntimeBulletState(state, bulletId, resolveFireAngle(state, input));
```

`resolveFireAngle()` falls back to the ship's heading when `aimAngle` is absent, null or not finite. That keeps the fire key and clients that predate aiming working: they send no angle and shoot straight ahead.

The client picks the angle from the input device:

| Input | Shot |
|-------|------|
| Space | Straight ahead, no `aimAngle` |
| Left mouse button on the canvas | At the cursor |
| Touch aim stick, held at its center | Straight ahead, no `aimAngle` |
| Touch aim stick, dragged | Along the drag direction |

A bullet keeps part of the ship's velocity (`BULLET_INHERITED_VELOCITY`), so a shot fired straight at the cursor would drift off it while the ship moves sideways. `solveAimAngle()` on the client corrects for that: it returns the angle whose resulting bullet velocity points at the target.

The muzzle follows an ellipse around the hull (`getMuzzleOffset()`), so an aimed shot leaves from the flank instead of from inside the ship.

**Files:** `shared/src/multiplayerCore.ts` — `resolveFireAngle()`, `solveAimAngle()`, `getMuzzleOffset()`; `client/src/input.ts` — pointer and stick aim state

### Predicted shot feedback

Bullets stay server-authoritative, but waiting a round trip for any response to the trigger feels dead. The client mirrors the server's fire rule (cooldown and ammo) in `predictLocalShot()` and plays the muzzle flash, the sound and the ammo count at once. It records the input sequence of each predicted shot. Reconciliation subtracts the shots the server has not processed yet from the server's ammo count, so the HUD does not flicker back up.

Muzzle flashes for other pilots and all impact effects come from comparing bullet ids between two snapshots: a new id is a shot, a missing id is an impact. A snapshot does not say what a bullet hit, so `resolveBulletImpact()` traces the vanished bullet along its path to find out.

**Files:** `client/src/multiplayerSession.ts` — `predictLocalShot()`, `playBulletEffects()`, `resolveBulletImpact()`; `client/src/weaponEffects.ts` — bolt, muzzle flash, impact and reticle drawing

## What's NOT Predicted

The client only predicts its own **movement** (position, velocity, angle). These remain server-authoritative and are taken directly from snapshots:

- Health and damage
- Ammo count (the client only subtracts its own unacknowledged shots)
- Bullet creation and collisions
- Asteroid/pickup spawning and collection
- Match phase transitions
- Other player's state

## Common Pitfalls (Lessons Learned)

### 1. Don't step at the render frame rate

Stepping physics in `requestAnimationFrame` (variable rate) while buffering at a fixed rate creates a mismatch during reconciliation replay. Always use a fixed-rate simulation loop.

### 2. Don't override velocity from server

Snapping velocity to the server value every snapshot creates oscillation — the local simulation applies thrust/drag and gets one velocity, then the server overrides it, then next frame local simulation diverges again.

### 3. Don't blend/interpolate predicted position toward server

Blending approaches (lerp 30% toward server each snapshot) fight with the prediction and create micro-jitter. The Valve/Gambetta approach of "accept + replay" produces cleaner results.

### 4. Buffer every tick, not every send

If you only buffer inputs when they're sent over the network (e.g., every 33ms), but the simulation ticks at 16.67ms, reconciliation replays fewer steps than the prediction accumulated. This causes snaps backward.

## File Reference

| File | Role |
|------|------|
| `shared/src/multiplayerCore.ts` | Physics, types, constants shared between client and server |
| `server/src/multiplayerService.ts` | Authoritative game simulation, snapshot broadcasting |
| `client/src/multiplayerSession.ts` | Prediction tick loop, reconciliation, rendering |
| `client/src/input.ts` | Keyboard/touch/pointer input capture |
| `client/src/weaponEffects.ts` | Client-only shot visuals |
