import p5 from "p5";
import { Mover } from "./mover";
import { type CameraBounds, circleIntersectsBounds, rgba } from "./utils";

type Vector = p5.Vector;

export let explosions = {} as ExplosionSystem;

export const resetExplosions = (p: p5) => {
  explosions = new ExplosionSystem(p);
};

export class ExplosionSystem {
  particles: ExplosionParticle[];
  p: p5;
  constructor(p: p5) {
    this.p = p;
    this.particles = [];
  }

  createExplosion(pos: Vector) {
    for (let i = 0; i < 72; i++) {
      this.particles.push(
        new ExplosionParticle(
          this.p,
          pos,
          this.p.random(-2 * this.p.PI, 2 * this.p.PI),
          this.p.random(0, 10),
        ),
      );
    }
  }

  run(cameraBounds?: CameraBounds) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.run(cameraBounds);
      if (particle.isDead()) {
        this.particles.splice(i, 1);
      }
    }
  }
}

class ExplosionParticle extends Mover {
  p: p5;
  rotation: number;
  lifespan: number;
  redValue: number;
  greenValue: number;
  blueValue: number;
  greenCap: number;
  constructor(p: p5, pos: Vector, rotation: number, r: number) {
    super(p, pos, p5.Vector.fromAngle(rotation, p.random(1, 5)), r);
    this.p = p;
    this.rotation = rotation;
    this.lifespan = 255;
    this.redValue = 100;
    this.greenValue = 200;
    this.blueValue = 255;
    this.greenCap = this.p.random(100, 255);
  }

  show() {
    this.p.push();
    this.p.translate(this.pos.x, this.pos.y);
    this.p.rotate(this.rotation);
    this.p.rect(0, 0, this.size * 2, this.size / 2);
    this.p.pop();
  }

  run(cameraBounds?: CameraBounds) {
    this.update();
    if (
      cameraBounds === undefined ||
      circleIntersectsBounds(this.pos.x, this.pos.y, this.size * 2, cameraBounds)
    ) {
      this.p.fill(rgba(this.redValue, this.greenValue, this.blueValue, this.lifespan));
      this.show();
    }
    this.decay();
  }

  decay() {
    if (this.lifespan > 0) {
      this.lifespan -= 15;
      if (this.blueValue > 60) {
        this.blueValue -= 5;
      }
      if (this.redValue < 255) {
        this.redValue += 20;
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
