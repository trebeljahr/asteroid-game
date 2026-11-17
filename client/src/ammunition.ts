import type p5 from "p5";
import { assets } from "./sketch";
import { randomSpawnPoint } from "./utils";

type Vector = p5.Vector;

export let ammunition = {} as AmmunitionPackages;

interface AmmunitionConfig {
  initialPackages: number;
  spawnEnabled: boolean;
}

const defaultConfig: AmmunitionConfig = {
  initialPackages: 50,
  spawnEnabled: true,
};

export const resetAmmunition = (p: p5, config: Partial<AmmunitionConfig> = {}) => {
  ammunition = new AmmunitionPackages(p, {
    ...defaultConfig,
    ...config,
  });
};

class AmmunitionPackages {
  ammunitionPackages: Ammunition[];
  p: p5;
  spawnEnabled: boolean;
  constructor(p: p5, config: AmmunitionConfig) {
    this.p = p;
    this.spawnEnabled = config.spawnEnabled;
    this.ammunitionPackages = [];
    this.addAmmunitionPackages(config.initialPackages);
  }

  addAmmunitionPackages(amount: number) {
    for (let i = 0; i < amount; i++) {
      const possibleSizes = [150, 150, 150, 150, 150, 200, 200, 250];
      this.ammunitionPackages.push(
        new Ammunition(this.p, randomSpawnPoint(this.p), this.p.random(possibleSizes)),
      );
    }
  }

  run() {
    if (this.spawnEnabled && this.p.frameCount % 240 === 0) {
      this.addAmmunitionPackages(1);
    }
    for (let i = this.ammunitionPackages.length - 1; i >= 0; i--) {
      const heart = this.ammunitionPackages[i];
      heart.draw();
    }
  }
}

export class Ammunition {
  p: p5;
  pos: Vector;
  size: number;
  amount: number;
  constructor(p: p5, pos: Vector, size: number) {
    this.pos = pos.copy();
    this.size = size / 3;
    this.p = p;
    this.amount = size;
  }

  draw() {
    this.p.rectMode(this.p.CENTER);
    this.p.fill("rgb(200, 240, 255)");
    this.p.imageMode(this.p.CENTER);
    this.p.ellipse(this.pos.x, this.pos.y, this.size, this.size);
    this.p.image(assets.ammoAsset, this.pos.x, this.pos.y, this.size / 1.5, this.size / 1.5);
  }
}
