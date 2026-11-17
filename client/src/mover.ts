import type p5 from "p5";
import { boardSizeX, boardSizeY, height, width } from "./utils";

type Vector = p5.Vector;

export class Mover {
  p: p5;
  pos: Vector;
  vel: Vector;
  size: number;
  constructor(p: p5, pos: Vector, vel: Vector, r: number) {
    this.p = p;
    this.pos = pos.copy();
    this.vel = vel.copy();
    this.size = r;
  }

  draw() {
    this.p.ellipse(this.pos.x, this.pos.y, this.size, this.size);
  }

  update() {
    this.pos = this.pos.add(this.vel);
  }

  setVel(newVel: Vector) {
    this.vel = newVel.copy();
  }

  inScreen() {
    return (
      this.pos.x >= -this.size - width / 2 - boardSizeX &&
      this.pos.y >= -this.size - height / 2 - boardSizeY &&
      this.pos.x <= boardSizeX + width / 2 + this.size &&
      this.pos.y <= height / 2 + boardSizeY + this.size
    );
  }
}
