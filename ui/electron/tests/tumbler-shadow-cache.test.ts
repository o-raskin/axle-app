import assert from "node:assert/strict";
import test from "node:test";
import { TumblerShadowCache, type TumblerShadowPose } from "../src/renderer/src/vehicle/tumblerShadowCache.ts";

function pose(patch: Partial<TumblerShadowPose> = {}): TumblerShadowPose {
  return { steering: 0, wheelRotation: 0, travel: 0, streetEnabled: false, clearance: [1, 1], ...patch };
}

test("a stationary pose reuses the first map indefinitely without a refresh loop", () => {
  const cache = new TumblerShadowCache();
  assert.equal(cache.sample(0, pose()), true);
  for (const time of [0, 32, 100, 1_000, 60_000]) assert.equal(cache.sample(time, pose()), false);
});

test("wheel rolling refreshes the tread silhouette, bounded to ten maps per second", () => {
  const cache = new TumblerShadowCache();
  const refreshed: number[] = [];
  for (let time = 0; time <= 1_000; time += 25) {
    if (cache.sample(time, pose({ wheelRotation: time / 1_000 * 12 }))) refreshed.push(time);
  }
  assert.deepEqual(refreshed, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000]);
});

test("small steering changes accumulate against the rendered map rather than adjacent samples", () => {
  const cache = new TumblerShadowCache();
  cache.sample(0, pose());
  for (const [time, steering] of [[100, 0.01], [200, 0.02], [300, 0.03]]) {
    assert.equal(cache.sample(time, pose({ steering })), false);
  }
  assert.equal(cache.sample(400, pose({ steering: 0.031 })), true);
  assert.equal(cache.sample(500, pose({ steering: 0.04 })), false);
});

test("a throttled movement stays dirty until a later existing frame refreshes it", () => {
  const cache = new TumblerShadowCache();
  cache.sample(0, pose());
  assert.equal(cache.sample(32, pose({ wheelRotation: 0.1 })), false);
  assert.equal(cache.sample(99, pose({ wheelRotation: 0.1 })), false);
  assert.equal(cache.sample(100, pose({ wheelRotation: 0.1 })), true);
  assert.equal(cache.sample(1_000, pose({ wheelRotation: 0.1 })), false);
});

test("forward and reverse street motion update shadows without refreshing subthreshold travel", () => {
  for (const direction of [-1, 1]) {
    const cache = new TumblerShadowCache();
    cache.sample(0, pose({ streetEnabled: true }));
    assert.equal(cache.sample(100, pose({ streetEnabled: true, travel: direction * 0.059 })), false);
    assert.equal(cache.sample(200, pose({ streetEnabled: true, travel: direction * 0.06 })), true);
  }
});

test("camera clearance refreshes either side's changed coverage while reusing unchanged geometry", () => {
  for (const clearance of [[0.95, 1], [1, 0.95]] as const) {
    const cache = new TumblerShadowCache();
    cache.sample(0, pose({ streetEnabled: true }));
    assert.equal(cache.sample(40, pose({ streetEnabled: true, clearance })), false);
    assert.equal(cache.sample(100, pose({ streetEnabled: true, clearance })), true);
    assert.equal(cache.sample(200, pose({ streetEnabled: true, clearance })), false);
  }
});

test("hidden street travel and clearance changes cannot consume shadow passes", () => {
  const cache = new TumblerShadowCache();
  cache.sample(0, pose());
  assert.equal(cache.sample(1_000, pose({ travel: 800, clearance: [0, 0] })), false);
});

test("enabling and disabling city geometry refresh immediately despite movement throttling", () => {
  const cache = new TumblerShadowCache();
  cache.sample(0, pose());
  assert.equal(cache.sample(10, pose({ streetEnabled: true })), true);
  assert.equal(cache.sample(20, pose({ streetEnabled: false })), true);
  assert.equal(cache.sample(30, pose({ wheelRotation: 1 })), false);
  assert.equal(cache.sample(120, pose({ wheelRotation: 1 })), true);
});

test("loading replacement geometry invalidates the map immediately and coalesces duplicate invalidations", () => {
  const cache = new TumblerShadowCache();
  cache.sample(0, pose());
  cache.invalidate();
  cache.invalidate();
  assert.equal(cache.sample(1, pose()), true);
  assert.equal(cache.sample(1, pose()), false);
});

test("nonfinite input cannot poison a cached pose or consume a model invalidation", () => {
  const cache = new TumblerShadowCache();
  for (const invalid of [pose({ steering: NaN }), pose({ wheelRotation: Infinity }),
    pose({ travel: -Infinity }), pose({ clearance: [1, NaN] })]) {
    assert.equal(cache.sample(0, invalid), false);
  }
  assert.equal(cache.sample(NaN, pose()), false);
  assert.equal(cache.sample(0, pose()), true);
  cache.invalidate();
  assert.equal(cache.sample(Infinity, pose()), false);
  assert.equal(cache.sample(1, pose()), true);
});

test("mutating an input tuple cannot change the pose represented by the cached map", () => {
  const cache = new TumblerShadowCache();
  const clearance: [number, number] = [1, 1];
  cache.sample(0, pose({ streetEnabled: true, clearance }));
  clearance[0] = 0;
  assert.equal(cache.sample(100, pose({ streetEnabled: true, clearance })), true);
});
