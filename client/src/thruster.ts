import p5 from "p5";
import { Mover } from "./mover";
import { rgba } from "./utils";

type Vector = p5.Vector;

export class ThrusterExhaustSystem {
  p: p5;
  pos: Vector;
  rotation: number;
  particles: ExhaustParticle[];
  constructor(p: p5, pos: Vector, rotation: number) {
    this.p = p;
    this.pos = pos.copy();
    this.rotation = rotation;
    this.particles = [];
  }

  fire(amount: number) {
    for (let i = 0; i < amount; i++) {
      this.particles.push(
        new ExhaustParticle(
          this.p,
          this.pos,
          p5.Vector.fromAngle(
            this.rotation + this.p.random(-this.p.PI / 10, this.p.PI / 10),
            this.p.random(5, 10),
          ),
          10,
        ),
      );
    }
  }

  updatePos(pos: Vector, rotation: number) {
    this.pos = pos.copy();
    this.rotation = rotation;
  }

  run() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.run();
      if (particle.isDead()) {
        this.particles.splice(i, 1);
      }
    }
  }
}

class ExhaustParticle extends Mover {
  p: p5;
  lifespan: number;
  redValue: number;
  greenValue: number;
  blueValue: number;
  greenCap: number;
  constructor(p: p5, pos: Vector, vel: Vector, r: number) {
    super(p, pos, vel, r);
    this.p = p;
    this.lifespan = 255;
    this.redValue = 100;
    this.greenValue = 200;
    this.blueValue = 255;
    this.greenCap = this.p.random(100, 255);
  }

  run() {
    this.update();
    this.p.fill(rgba(this.redValue, this.greenValue, this.blueValue, this.lifespan));
    this.draw();
    this.decay();
  }

  decay() {
    if (this.lifespan > 0) {
      this.lifespan -= 15;
      if (this.blueValue > 60) {
        this.blueValue -= 10;
      }
      if (this.redValue < 255) {
        this.redValue += 30;
      }
      if (this.greenValue < this.greenCap) {
        this.greenValue += 10;
      }
    }
  }

  isDead() {
    return this.lifespan === 0;
  }
}
