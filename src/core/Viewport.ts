export type SurfacePoint = { x: number; y: number };
export type SurfaceSize = { w: number; h: number };

/** A portrait host is presented as a clockwise-rotated logical landscape. */
export function isRotatedLandscape(
  physicalWidth = window.innerWidth,
  physicalHeight = window.innerHeight,
): boolean {
  return physicalHeight >= physicalWidth;
}

export function surfaceSize(
  physicalWidth = window.innerWidth,
  physicalHeight = window.innerHeight,
): SurfaceSize {
  return isRotatedLandscape(physicalWidth, physicalHeight)
    ? { w: physicalHeight, h: physicalWidth }
    : { w: physicalWidth, h: physicalHeight };
}

/**
 * Convert physical WebView pointer coordinates into the rotated game surface.
 *
 * The body turns clockwise in portrait, therefore logical right is physical
 * down and logical down is physical left.
 */
export function clientToSurface(
  clientX: number,
  clientY: number,
  physicalWidth = window.innerWidth,
  physicalHeight = window.innerHeight,
): SurfacePoint {
  return isRotatedLandscape(physicalWidth, physicalHeight)
    ? { x: clientY, y: physicalWidth - clientX }
    : { x: clientX, y: clientY };
}
