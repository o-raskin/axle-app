import assert from "node:assert/strict";
import test from "node:test";
import { tumblerGraphicsBudget } from "../src/renderer/src/vehicle/tumblerGraphics";

test("CPU graphics reduce raster and shadow work without relying on the operating system", () => {
  const detailed = tumblerGraphicsBudget("ANGLE (AMD, AMD Radeon Graphics, OpenGL 4.6)");
  for (const renderer of ["ANGLE (Google, Vulkan SwiftShader Device (Subzero))",
    "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 128 bits), OpenGL 4.5)", "softpipe", "lavapipe",
    "Software Rasterizer", "Microsoft Basic Render Driver"]) {
    const budget = tumblerGraphicsBudget(renderer);
    assert.equal(budget.software, true);
    assert.ok(budget.maxPixelRatio > 0 && budget.maxPixelRatio ** 2 <= detailed.maxPixelRatio ** 2 / 4);
    assert.ok(budget.shadowMapSize >= 512 && budget.shadowMapSize ** 2 <= detailed.shadowMapSize ** 2 / 4);
  }
});

test("Steam Deck, Apple, NVIDIA and unknown GPUs retain detailed rendering", () => {
  for (const renderer of ["ANGLE (AMD, AMD Radeon Graphics (RADV VANGOGH), OpenGL 4.6)",
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Version 0.0)", "NVIDIA GeForce RTX 4080",
    "Intel Iris Xe", null, undefined, 42]) {
    assert.deepEqual(tumblerGraphicsBudget(renderer), { maxPixelRatio: 1.5, shadowMapSize: 2048, software: false });
  }
});
