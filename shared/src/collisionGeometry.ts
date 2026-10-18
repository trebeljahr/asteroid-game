export interface Point2D {
  x: number;
  y: number;
}

export interface CollisionAabb {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

export type NormalizedCollisionPoint = readonly [number, number];

export interface NormalizedCollisionShape {
  bounds: CollisionAabb;
  loops: ReadonlyArray<ReadonlyArray<NormalizedCollisionPoint>>;
}

export interface TransformedCollisionShape {
  aabb: CollisionAabb;
  loops: Point2D[][];
}

const EPSILON = 1e-6;

const subtractPoints = (first: Point2D, second: Point2D) => {
  return {
    x: first.x - second.x,
    y: first.y - second.y,
  };
};

const crossProduct = (first: Point2D, second: Point2D) => {
  return first.x * second.y - first.y * second.x;
};

const pointInLoop = (x: number, y: number, loop: readonly Point2D[]) => {
  let inside = false;

  for (
    let index = 0, previousIndex = loop.length - 1;
    index < loop.length;
    previousIndex = index++
  ) {
    const current = loop[index];
    const previous = loop[previousIndex];
    const crossesY = current.y > y !== previous.y > y;

    if (
      crossesY &&
      x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
    ) {
      inside = !inside;
    }
  }

  return inside;
};

const pointInShape = (x: number, y: number, shape: TransformedCollisionShape) => {
  let inside = false;

  for (let loopIndex = 0; loopIndex < shape.loops.length; loopIndex++) {
    if (pointInLoop(x, y, shape.loops[loopIndex])) {
      inside = !inside;
    }
  }

  return inside;
};

const distanceToSegmentSquare = (pointX: number, pointY: number, start: Point2D, end: Point2D) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquare = dx * dx + dy * dy;

  if (lengthSquare <= EPSILON) {
    const deltaX = pointX - start.x;
    const deltaY = pointY - start.y;
    return deltaX * deltaX + deltaY * deltaY;
  }

  const projection = Math.max(
    0,
    Math.min(1, ((pointX - start.x) * dx + (pointY - start.y) * dy) / lengthSquare),
  );
  const nearestX = start.x + dx * projection;
  const nearestY = start.y + dy * projection;
  const deltaX = pointX - nearestX;
  const deltaY = pointY - nearestY;
  return deltaX * deltaX + deltaY * deltaY;
};

const segmentBoundingBoxesOverlap = (
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
) => {
  return !(
    Math.max(firstStart.x, firstEnd.x) < Math.min(secondStart.x, secondEnd.x) - EPSILON ||
    Math.max(secondStart.x, secondEnd.x) < Math.min(firstStart.x, firstEnd.x) - EPSILON ||
    Math.max(firstStart.y, firstEnd.y) < Math.min(secondStart.y, secondEnd.y) - EPSILON ||
    Math.max(secondStart.y, secondEnd.y) < Math.min(firstStart.y, firstEnd.y) - EPSILON
  );
};

const orientation = (first: Point2D, second: Point2D, third: Point2D) => {
  return crossProduct(subtractPoints(second, first), subtractPoints(third, first));
};

const pointOnSegment = (point: Point2D, start: Point2D, end: Point2D) => {
  return (
    Math.min(start.x, end.x) - EPSILON <= point.x &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    Math.min(start.y, end.y) - EPSILON <= point.y &&
    point.y <= Math.max(start.y, end.y) + EPSILON &&
    Math.abs(orientation(start, end, point)) <= EPSILON
  );
};

const segmentsIntersect = (
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
) => {
  if (!segmentBoundingBoxesOverlap(firstStart, firstEnd, secondStart, secondEnd)) {
    return false;
  }

  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);

  if (Math.abs(firstOrientation) <= EPSILON && pointOnSegment(secondStart, firstStart, firstEnd)) {
    return true;
  }
  if (Math.abs(secondOrientation) <= EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd)) {
    return true;
  }
  if (Math.abs(thirdOrientation) <= EPSILON && pointOnSegment(firstStart, secondStart, secondEnd)) {
    return true;
  }
  if (Math.abs(fourthOrientation) <= EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd)) {
    return true;
  }

  return (
    firstOrientation > 0 !== secondOrientation > 0 && thirdOrientation > 0 !== fourthOrientation > 0
  );
};

export const aabbsOverlap = (first: CollisionAabb, second: CollisionAabb) => {
  return !(
    first.maxX < second.minX ||
    second.maxX < first.minX ||
    first.maxY < second.minY ||
    second.maxY < first.minY
  );
};

export const circleIntersectsAabb = (
  x: number,
  y: number,
  diameter: number,
  aabb: CollisionAabb,
) => {
  const radius = diameter / 2;
  const nearestX = Math.max(aabb.minX, Math.min(x, aabb.maxX));
  const nearestY = Math.max(aabb.minY, Math.min(y, aabb.maxY));
  const deltaX = x - nearestX;
  const deltaY = y - nearestY;

  return deltaX * deltaX + deltaY * deltaY <= radius * radius;
};

export const getCollisionShapeBoundingDiameter = (
  shape: NormalizedCollisionShape,
  width: number,
  height: number,
) => {
  let maxDistanceSquare = 0;

  for (let loopIndex = 0; loopIndex < shape.loops.length; loopIndex++) {
    const loop = shape.loops[loopIndex];
    for (let pointIndex = 0; pointIndex < loop.length; pointIndex++) {
      const [normalizedX, normalizedY] = loop[pointIndex];
      const x = normalizedX * width;
      const y = normalizedY * height;
      maxDistanceSquare = Math.max(maxDistanceSquare, x * x + y * y);
    }
  }

  return Math.sqrt(maxDistanceSquare) * 2;
};

export const transformCollisionShape = (
  shape: NormalizedCollisionShape,
  centerX: number,
  centerY: number,
  angle: number,
  width: number,
  height: number,
): TransformedCollisionShape => {
  const target: TransformedCollisionShape = {
    aabb: {
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
    },
    loops: [],
  };
  return transformCollisionShapeInto(target, shape, centerX, centerY, angle, width, height);
};

/**
 * Same result as transformCollisionShape, written into `target` so a
 * caller that transforms the same shape every tick allocates nothing.
 * Points are reused while the loop sizes match.
 */
export const transformCollisionShapeInto = (
  target: TransformedCollisionShape,
  shape: NormalizedCollisionShape,
  centerX: number,
  centerY: number,
  angle: number,
  width: number,
  height: number,
) => {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const loops = target.loops;
  if (loops.length !== shape.loops.length) {
    loops.length = 0;
  }

  for (let loopIndex = 0; loopIndex < shape.loops.length; loopIndex++) {
    const source = shape.loops[loopIndex];
    let loop = loops[loopIndex];
    if (loop === undefined || loop.length !== source.length) {
      loop = [];
      for (let pointIndex = 0; pointIndex < source.length; pointIndex++) {
        loop.push({ x: 0, y: 0 });
      }
      loops[loopIndex] = loop;
    }

    for (let pointIndex = 0; pointIndex < source.length; pointIndex++) {
      const normalized = source[pointIndex];
      const localX = normalized[0] * width;
      const localY = normalized[1] * height;
      const worldX = centerX + localX * cosine - localY * sine;
      const worldY = centerY + localX * sine + localY * cosine;
      minX = Math.min(minX, worldX);
      minY = Math.min(minY, worldY);
      maxX = Math.max(maxX, worldX);
      maxY = Math.max(maxY, worldY);
      const point = loop[pointIndex];
      point.x = worldX;
      point.y = worldY;
    }
  }

  target.aabb.maxX = maxX;
  target.aabb.maxY = maxY;
  target.aabb.minX = minX;
  target.aabb.minY = minY;
  return target;
};

export const circleOverlapsCollisionShape = (
  x: number,
  y: number,
  diameter: number,
  shape: TransformedCollisionShape,
) => {
  if (!circleIntersectsAabb(x, y, diameter, shape.aabb)) {
    return false;
  }

  if (pointInShape(x, y, shape)) {
    return true;
  }

  const radiusSquare = (diameter / 2) * (diameter / 2);
  for (let loopIndex = 0; loopIndex < shape.loops.length; loopIndex++) {
    const loop = shape.loops[loopIndex];

    for (let pointIndex = 0; pointIndex < loop.length; pointIndex++) {
      const current = loop[pointIndex];
      const next = loop[(pointIndex + 1) % loop.length];
      if (distanceToSegmentSquare(x, y, current, next) <= radiusSquare) {
        return true;
      }
    }
  }

  return false;
};

export const collisionShapesOverlap = (
  first: TransformedCollisionShape,
  second: TransformedCollisionShape,
) => {
  if (!aabbsOverlap(first.aabb, second.aabb)) {
    return false;
  }

  for (let firstLoopIndex = 0; firstLoopIndex < first.loops.length; firstLoopIndex++) {
    const firstLoop = first.loops[firstLoopIndex];

    for (let firstPointIndex = 0; firstPointIndex < firstLoop.length; firstPointIndex++) {
      const firstStart = firstLoop[firstPointIndex];
      const firstEnd = firstLoop[(firstPointIndex + 1) % firstLoop.length];

      for (let secondLoopIndex = 0; secondLoopIndex < second.loops.length; secondLoopIndex++) {
        const secondLoop = second.loops[secondLoopIndex];

        for (let secondPointIndex = 0; secondPointIndex < secondLoop.length; secondPointIndex++) {
          const secondStart = secondLoop[secondPointIndex];
          const secondEnd = secondLoop[(secondPointIndex + 1) % secondLoop.length];

          if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
            return true;
          }
        }
      }
    }
  }

  for (let loopIndex = 0; loopIndex < first.loops.length; loopIndex++) {
    const loop = first.loops[loopIndex];
    if (loop.length > 0 && pointInShape(loop[0].x, loop[0].y, second)) {
      return true;
    }
  }

  for (let loopIndex = 0; loopIndex < second.loops.length; loopIndex++) {
    const loop = second.loops[loopIndex];
    if (loop.length > 0 && pointInShape(loop[0].x, loop[0].y, first)) {
      return true;
    }
  }

  return false;
};

export const getAabbVertices = (aabb: CollisionAabb): Point2D[] => {
  return [
    { x: aabb.minX, y: aabb.minY },
    { x: aabb.maxX, y: aabb.minY },
    { x: aabb.maxX, y: aabb.maxY },
    { x: aabb.minX, y: aabb.maxY },
  ];
};
