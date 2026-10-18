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
│  Input (keys, touch)│                   │  Authoritative      │
│       │             │   Socket.io       │  Game State         │
│       v             │   (WebSocket)     │       │             │
│  Prediction tick ───┼──── input ───────>│  Input buffer       │
│  (60 per second)    │   (every tick)    │  (per player)       │
│       │             │                   │       │             │
│       v             │                   │       v             │
│  Predicted ship     │                   │  Server tick        │
│       │             │                   │  (60 per second)    │
│       v             │                   │       │             │
│  Reconciliation  <──┼──── snapshot ─────│  Snapshot           │
│       │             │   (every 2 ticks) │  (every 2 ticks)    │
│       v             │                   │                     │
│  Server timeline    │                   │                     │
│       │             │                   │                     │
│       v             │                   │                     │
│  Render (rAF)       │                   │                     │
│                     │                   │                     │
└─────────────────────┘                   └─────────────────────┘
```

Three rules hold the design together:

1. **One input, one ship step.** The client steps its ship once per input it sends. The server steps that ship once per input it receives, and never on its own. Both sides therefore run the same steps, and the server confirms the predicted ship instead of correcting it.
2. **One world step per server tick.** Bullets, collisions and spawns follow the server clock alone. No player's packets can speed them up or slow them down.
3. **Draw on a clock, not on packet arrival.** Packets arrive unevenly. Everything on screen is placed by a steady clock, so a late packet does not become a jump.

### Server Authority

The server is the single source of truth for all game state. It runs the simulation at 60 ticks per second (`TICK_INTERVAL_MS = 1000/60 ≈ 16.67ms`). Every tick:

1. Each ship consumes its due inputs from that player's input buffer, one `stepPlayerState()` per input
2. Bullets advance one step and collisions are checked
3. Asteroids, ammo and health pickups spawn or disappear
4. Win and loss conditions are checked

Every 2 ticks (~33ms), the server broadcasts a `match:snapshot` (`br:snapshot` in battle royale) with the authoritative state of all players. Each snapshot carries `sequence`, the server tick it describes.

Everything else goes out as world events (`match:world-events`, `br:world-events`) on the tick it happens: asteroids, pickups and bullets spawning and being removed. Each payload carries `sequence`, the tick of its events, and `worldVersion`, which counts payloads. A client that re-attaches after a reconnect or a handoff gets the whole world, bullets included, in `match:resumed`.

**Files:** `server/src/realtime/matchHost.ts` — tick loop and `playerStepsForTick()`; `server/src/multiplayerService.ts` and `server/src/battleRoyaleService.ts` — `stepActive()`

### The tick rate has to be real

`setInterval(1000 / 60)` does not run 60 times per second. Browsers round the delay down to 16 ms (62.5 Hz). Node rounds it up and adds the time each callback starts late. A client and a server that both "tick at 16.67 ms" then run at different speeds, and the faster one produces inputs or ticks the other cannot match.

Both sides use `FixedStepClock` instead. It counts elapsed time and returns the number of ticks that became due, so the rate is exact on average however unevenly the timer fires. After a stall it runs a bounded number of catch-up ticks and drops the rest.

**File:** `shared/src/fixedTimestep.ts`

### The Latency Problem

Without any client-side tricks, the flow for a player pressing "thrust" would be:

1. Client sends input to server (~50ms network latency)
2. Server processes input on next tick (~16ms)
3. Server sends snapshot back (~50ms network latency)
4. Client renders new position

**Total: ~116ms delay** between pressing a key and seeing movement. This feels terrible for a fast-paced game.

## Client-Side Prediction

The solution is to **predict locally** — run the same physics simulation on the client so the player sees immediate feedback, then check it against the server's authoritative state.

### The Prediction Tick

Each prediction tick:

1. Reads the current input state (keyboard/touch)
2. Assigns an incrementing sequence number (`inputSeq`)
3. Buffers the input (for reconciliation replay later)
4. Steps the local physics: `stepPlayerState(predictedSelf, input, arena)`
5. Sends the input to the server

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

  // Every tick's input goes to the server: one input, one ship step.
  this.socket.emit("match:input", currentInput);
}
```

`pumpPrediction()` decides how many ticks are due. It runs from a short timer and from the draw loop, and both ask the same `FixedStepClock`. The timer keeps inputs flowing while the display is slow or the tab is hidden. The draw loop makes a due tick run right before its frame.

**File:** `client/src/multiplayerSession.ts` — `pumpPrediction()`, `predictionTick()`

## The Server's Input Buffer

The network delivers inputs unevenly: none on one tick, two on the next. If the server applied them as they arrive, the ship would stutter on every other player's screen. If it repeated the last input when none arrived, it would make a step the client never predicted, and the client would be corrected.

So each player's queue works as a jitter buffer. The ship takes one input per tick, and the few inputs left waiting cover the ticks on which nothing arrives. The buffer finds its own depth:

| Situation | What the server does |
|-----------|----------------------|
| An input is waiting | The ship takes one and steps once |
| Nothing is waiting | The ship pauses for one tick. From then on one more input stays in the buffer |
| The buffer stayed deeper than the jitter needed for a second | The ship takes one extra input, which removes one tick of delay |
| A stall left a backlog | The ship takes up to 3 inputs per tick until at most 4 wait |
| Inputs arrive faster than real time | The surplus is discarded and acknowledged |
| No input for half a second, or the player is disconnected | The ship drifts with neutral controls |

The last-but-one row is the speed limit. A ship earns 1.05 inputs per server tick and can save up 30. A client that sends inputs faster gains nothing: the server discards what the budget does not cover and reports the discarded sequence number, so the client stops predicting those steps.

The buffer adds delay only to what other players see of this ship, and only as much as the connection's jitter requires: nothing on a steady link, up to 4 ticks (67ms) on a rough one. The player's own ship is predicted and does not wait for it.

**File:** `server/src/realtime/inputPacing.ts` — `takeInputsForTick()`

## Server Reconciliation

When a server snapshot arrives, the client checks its prediction against the authoritative state. This is where the input buffer and sequence numbers come in.

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

1. **Accept the server state** as the new base
2. **Discard acknowledged inputs**: remove all buffered inputs with `seq <= lastInputSeq`
3. **Replay unacknowledged inputs**: step the ship forward once per remaining buffer entry

```typescript
// client/src/netcode/reconcile.ts
export const replayPendingInputs = (serverState, pending, arena) => {
  const state = { ...serverState, fireCooldownTicks: 0 };
  const unconfirmed = pending.filter((entry) => entry.seq > serverState.lastInputSeq);

  for (const entry of unconfirmed) {
    stepPlayerState(state, entry.input, arena);
  }

  return { state, pending: unconfirmed /* ... */ };
};
```

### Why This Works

After reconciliation, the predicted state represents: "where the server says I am" + "the effect of inputs the server hasn't processed yet."

The server made exactly one step per acknowledged input, so the replay lands on the ship the client had already predicted. In the simulated duel the correction is zero at every snapshot, on a 5ms link and on an 80ms link with 30ms of jitter. A real correction happens only when the server knows something the client could not: a collision with another ship, or inputs it discarded.

### What the Server Tracks

A ship's `lastInputSeq` is the highest input the server applied or discarded for it:

```typescript
// server, once per ship step
participant.input = input;
participant.state.lastInputSeq = Math.max(participant.state.lastInputSeq, input.inputSeq);
stepPlayerState(participant.state, participant.input, arena);
```

`snapshotPlayerState()` copies it into every snapshot, telling the client "I've processed your inputs up to this number."

## Rendering

The simulation moves in ticks and the network delivers in bursts. The screen must show neither.

### The Player's Own Ship

`RenderSmoother` does two things for the predicted ship:

- **Between ticks.** A display does not refresh in step with the simulation. Some frames would show no new tick and others two, which reads as stutter, and the camera follows the ship, so the whole world would stutter with it. The ship is drawn between its last two tick positions, by how far the clock is into the next tick.
- **After a correction.** When reconciliation does move the ship, the drawn ship stays where it was and the difference fades out with a 60ms half-life. A difference above 260px is a real teleport and is shown as one.

The simulation always holds the corrected state. Only the drawing is smoothed.

**File:** `client/src/netcode/renderSmoother.ts`

### Other Ships

The client does not know what other players are pressing, so it cannot predict them. It draws them from snapshots, and the question is which moment to draw.

`ServerTimeline` estimates a steady server clock from the fastest recent snapshot arrivals. It then draws a moment slightly behind that clock: one snapshot interval, plus as much as the measured jitter needs (33ms on a steady link, at most 100ms). Two snapshots usually surround that moment, so a remote ship moves between positions the server really reported. When the newest snapshot is older than the drawn moment, the ship is projected forward along its velocity for up to 8 ticks and then holds.

The clock never jumps. When the estimate changes, the timeline runs up to 10% fast or slow until it has caught up.

**Files:** `client/src/netcode/serverTimeline.ts`, `client/src/netcode/remoteEntities.ts` — `sampleRemotePlayers()`

### Bullets

Snapshots carry no bullets. A bullet flies in a straight line at a fixed speed, so the server sends it twice: a `bullet-spawned` event with the bullet as it left the muzzle, and a `bullet-removed` event with the cause (`asteroid`, `ship`, `edge` or `expired`). The server moves a bullet one step on the tick it is fired, so the muzzle position is where it was on the tick before.

`BulletTracker` keeps each bullet with the tick its position belongs to, and places it at any tick from there. Bullets are drawn at the current server tick, with no interpolation delay, and at most 8 ticks past the newest snapshot. During a countdown, when a restored match waits for its players, the server holds bullets still, so each countdown snapshot re-anchors them.

**Files:** `client/src/netcode/bulletTracker.ts`; `client/src/netcode/remoteEntities.ts` — `sampleBullets()`

## Network Notes

### One Input per Tick

The client sends every tick's input, about 60 small messages per second. Sending only on change would break the first rule: the server could no longer tell how many steps the client made.

### Snapshot Rate

The server sends snapshots every 2 ticks (~33ms, 30 snapshots/second) rather than every tick. This halves bandwidth. Prediction fills the gaps for the player's own ship and the timeline fills them for everything else.

### Wire Format

The server sends msgpack (`socket.io-msgpack-parser`), about a third smaller than JSON for snapshots. Clients send JSON. Their messages are small, and the msgpack decoder trusts the lengths a frame declares, so the server never decodes msgpack from a client. `wireParser.ts` on each side pairs the two parsers.

The client sends `MULTIPLAYER_PROTOCOL_VERSION` in the handshake. The server refuses any other version, and the client then asks the player to reload. Raise the version whenever an older client could no longer play against the server. The deploy activates the new client only after the new server is up.

**Files:** `server/src/realtime/wireParser.ts`, `client/src/netcode/wireParser.ts`, `server/src/server.ts` — handshake check

### WebSocket Means TCP

A lost packet stalls everything behind it until it is sent again, often for 200ms or more. Then the queued messages arrive together. The design expects this: the input buffer works a backlog off within its budget, and the timeline carries remote ships forward for a moment and then holds them.

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

Muzzle flashes for other pilots and all impact effects come from the bullet events: a `bullet-spawned` event is a shot, a `bullet-removed` event is an impact where the bullet was on that tick, of the kind its cause names.

**Files:** `client/src/multiplayerSession.ts` — `predictLocalShot()`, `applyBulletEvents()`; `client/src/weaponEffects.ts` — bolt, muzzle flash, impact and reticle drawing

## What's NOT Predicted

The client only predicts its own **movement** (position, velocity, angle). These remain server-authoritative and are taken directly from snapshots:

- Health and damage
- Ammo count (the client only subtracts its own unacknowledged shots)
- Bullet creation and collisions
- Asteroid/pickup spawning and collection
- Match phase transitions
- Other player's state

## Measuring It

Feel is hard to argue about, so the netcode is measured.

`server/test/netcodeHarness.ts` plays a duel in virtual time: the real server simulation, two clients built from the real client netcode modules, and a simulated network with latency, jitter and stalls. Timers and the clock are mocked, so a run is exact and repeatable on any machine. It reports what a player would see:

- how far the server moved the predicted ship at each snapshot
- how far each drawn frame strays from steady motion, for the own ship and for the opponent
- how many inputs the server applied to a ship per snapshot
- how far the bullets the client rebuilt from world events are from the server's, at each snapshot (zero: same bullets, same places)

`server/test/duelNetcode.test.ts` turns those into requirements. The numbers below are one pilot's view of a 20-second duel over a link with 40ms latency each way and 0 to 15ms of jitter, both ships circling at about 4px per tick:

| | Before these rules | Now |
|---|---|---|
| Server corrections of the own ship above 0.5px | 14.7 per second, up to 18.7px | none |
| Own-ship frames more than 1px off steady motion | 16.7 per second | none |
| Opponent frames more than 1px off steady motion | 23.1 per second | none (largest 0.82px) |
| Inputs applied per snapshot interval (2 is even) | 1, 2 or 3 | always 2 |

For a look at a live match, dev builds have two tools, both opt-in with `?debug=1`:

- The netcode overlay (Settings → Netcode Debug) graphs the correction distance, the input buffer and the server queue depth.
- `?debug=1&lag=60&jitter=20` delays this client's inputs and everything it receives by 60ms plus up to 20ms, each way. Two windows on one machine then behave like two players on a real network.

## Common Pitfalls (Lessons Learned)

### 1. Don't trust a timer for the tick rate

`setInterval(1000 / 60)` runs at 62.5 Hz in a browser and below 60 Hz in Node. Count elapsed time and derive the ticks from it.

### 2. Don't step at the render frame rate

Stepping physics once per `requestAnimationFrame` ties the simulation to the display: a 144 Hz screen would fly the ship 2.4 times as fast as a 60 Hz one. Run fixed ticks and draw between them.

### 3. Don't let input arrival drive the world

An earlier version ran one full world step per queued input, to drain bursts. One player's bunched packets then moved the other ship and every bullet several steps in one tick, and the whole match ran at the speed of the fastest sender.

### 4. Don't repeat the last input when none arrived

It looks harmless, but it is a ship step the client never made. When the late input arrives the server steps again, the ship is one step ahead of the prediction, and the client is corrected. Let the ship wait and let the input buffer absorb the jitter.

### 5. Don't blend the simulation toward the server

Blending the predicted state itself (lerp 30% toward the server each snapshot) fights the prediction and creates micro-jitter. Accept the server state and replay. Smoothing belongs in the drawing only, where it cannot feed back into the simulation.

### 6. Don't override velocity from the server without replaying

Snapping velocity to the server value every snapshot creates oscillation: the local simulation applies thrust and drag and gets one velocity, the server overrides it with an older one, and the next tick diverges again.

### 7. Buffer every tick, not every send

If you only buffer inputs when they are sent, but the simulation ticks more often, reconciliation replays fewer steps than the prediction made. This causes snaps backward.

### 8. Don't place remote things by packet arrival time

Projecting a ship forward from the moment its snapshot arrived turns every late or early packet into a jump. Place it by the server tick the snapshot carries.

## File Reference

| File | Role |
|------|------|
| `shared/src/multiplayerCore.ts` | Physics, types, constants shared between client and server |
| `shared/src/fixedTimestep.ts` | The clock that turns elapsed time into ticks |
| `server/src/realtime/matchHost.ts` | Server tick loop, seats, which ship steps are due |
| `server/src/realtime/inputPacing.ts` | Per-player input buffer and speed limit |
| `server/src/multiplayerService.ts` | Authoritative duel simulation, snapshot broadcasting |
| `client/src/multiplayerSession.ts` | Socket handling, prediction tick, drawing |
| `client/src/netcode/reconcile.ts` | Replay of unconfirmed inputs |
| `client/src/netcode/renderSmoother.ts` | Smooth drawing of the predicted ship |
| `client/src/netcode/serverTimeline.ts` | Which server moment to draw |
| `client/src/netcode/remoteEntities.ts` | Other ships and bullets at that moment |
| `client/src/netcode/bulletTracker.ts` | Bullets rebuilt from spawn and removal events |
| `server/src/realtime/wireParser.ts`, `client/src/netcode/wireParser.ts` | msgpack from the server, JSON from clients |
| `client/src/input.ts` | Keyboard/touch/pointer input capture |
| `client/src/weaponEffects.ts` | Client-only shot visuals |
| `server/test/netcodeHarness.ts` | The simulated duel used to measure all of this |
