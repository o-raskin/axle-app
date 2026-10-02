/** CPU rasterizers need a smaller pixel budget to keep input and encoder
 * feedback responsive. Keep every lighting pass and the complete CAD geometry;
 * hardware GPUs, including Steam Deck's Radeon, retain the detailed preset. */
export function tumblerGraphicsBudget(rendererName: unknown): { maxPixelRatio: number; shadowMapSize: number; software: boolean } {
  const software = typeof rendererName === "string"
    && /swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|microsoft basic render/i.test(rendererName);
  return software
    ? { maxPixelRatio: 0.25, shadowMapSize: 512, software: true }
    : { maxPixelRatio: 1.5, shadowMapSize: 2048, software: false };
}
