import p5 from "p5";
import { Mover } from "./mover";
import { type CameraBounds, circleIntersectsBounds } from "./utils";

type Vector = p5.Vector;

export let bullets = {} as BulletSystem;
export const resetbullets = (p: p5) => {
  bullets = new BulletSystem(p);
};

class BulletSystem {
  p: p5;
  bullets: Bullet[];
  maxBullets: number;
  constructor(p: p5) {
    this.p = p;
    this.bullets = [];
    this.maxBullets = 250;
  }
  update(cameraBounds?: CameraBounds) {
    this.p.fill(255);
    this.p.stroke(255, 0, 0);
    for (let j = this.bullets.length - 1; j >= 0; j--) {
      const bullet = this.bullets[j];
      if (
        cameraBounds === undefined ||
        circleIntersectsBounds(bullet.pos.x, bullet.pos.y, bullet.size, cameraBounds)
      ) {
        bullet.draw();
      }
      bullet.update();
      if (!bullet.inScreen()) {
        this.bullets.splice(j, 1);
      }
    }
  }
  addBullet(pos: Vector, rotation: number) {
    if (this.bullets.length >= this.maxBullets) {
      this.bullets.shift();
    }
    this.bullets.push(
      new Bullet(
        this.p,
        pos,
        p5.Vector.fromAngle(rotation + this.p.random(-this.p.PI / 20, this.p.PI / 20), 20),
        10,
      ),
    );
  }
}

export class Bullet extends Mover {
  run() {
    this.draw();
    this.update();
  }
}
