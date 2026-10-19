/**
 * A small software rasterizer for the floating microphone button.
 *
 * Everything is drawn from signed distance fields: a shape is a function `(x, y) => distance`, and
 * `fillShape` turns that distance into coverage. That gives antialiased edges from a handful of lines
 * of maths and, more importantly, keeps the whole button free of any drawing dependency — the tool
 * stays a two-package install (koffi + sherpa-onnx-node).
 *
 * Pixels are 32-bit premultiplied BGRA, top-down, which is exactly the layout
 * `UpdateLayeredWindow` expects for a per-pixel-alpha window (see src/win32-gui.mjs), so the buffer
 * produced here can be copied straight into the DIB section.
 */

/** Colour as `[red, green, blue, alpha]`, each 0-255, alpha straight (not premultiplied). */
export const BUTTON_STATES = ['idle', 'hover', 'recording', 'transcribing']

/** Palette, chosen to stay readable over both light and dark application backgrounds. */
const PALETTE = {
  idle: [86, 98, 122, 255],
  hover: [104, 118, 146, 255],
  recording: [229, 72, 77, 255],
  transcribing: [217, 164, 65, 255],
  glyph: [255, 255, 255, 255],
  shadow: [8, 10, 16, 90],
}

/**
 * Create an empty (fully transparent) canvas.
 * @param {number} width - canvas width in pixels.
 * @param {number} height - canvas height in pixels.
 * @returns {{width: number, height: number, pixels: Uint8ClampedArray}} the canvas.
 */
export function createCanvas(width, height) {
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) }
}

/**
 * Blend one straight-alpha colour into a premultiplied BGRA canvas.
 * @param {{width: number, height: number, pixels: Uint8ClampedArray}} canvas - target canvas.
 * @param {number} x - pixel column.
 * @param {number} y - pixel row.
 * @param {number} coverage - 0-1 coverage of this pixel.
 * @param {number[]} color - `[r, g, b, a]`.
 * @returns {void}
 */
function blend(canvas, x, y, coverage, color) {
  const alpha = (color[3] / 255) * coverage
  if (alpha <= 0) return
  const index = (y * canvas.width + x) * 4
  const pixels = canvas.pixels
  const inverse = 1 - alpha
  pixels[index] = color[2] * alpha + pixels[index] * inverse
  pixels[index + 1] = color[1] * alpha + pixels[index + 1] * inverse
  pixels[index + 2] = color[0] * alpha + pixels[index + 2] * inverse
  pixels[index + 3] = 255 * alpha + pixels[index + 3] * inverse
}

/**
 * Paint every pixel of the canvas through a signed-distance function.
 * Coverage ramps over one pixel, so edges are antialiased.
 * @param {{width: number, height: number, pixels: Uint8ClampedArray}} canvas - target canvas.
 * @param {(x: number, y: number) => number} sdf - signed distance in pixels; negative inside.
 * @param {number[]} color - `[r, g, b, a]`.
 * @param {{alphaScale?: number, bounds?: {x0: number, y0: number, x1: number, y1: number}}} [options]
 *   `alphaScale` scales the colour's alpha (used for the soft shadow), `bounds` limits the scan.
 * @returns {void}
 */
export function fillShape(canvas, sdf, color, options = {}) {
  const alphaScale = options.alphaScale ?? 1
  const tinted = alphaScale === 1 ? color : [color[0], color[1], color[2], color[3] * alphaScale]
  const x0 = Math.max(0, Math.floor(options.bounds?.x0 ?? 0))
  const y0 = Math.max(0, Math.floor(options.bounds?.y0 ?? 0))
  const x1 = Math.min(canvas.width, Math.ceil(options.bounds?.x1 ?? canvas.width))
  const y1 = Math.min(canvas.height, Math.ceil(options.bounds?.y1 ?? canvas.height))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      // Sample at the pixel centre; the distance is already in pixel units.
      const coverage = Math.min(1, Math.max(0, 0.5 - sdf(x + 0.5, y + 0.5)))
      if (coverage > 0) blend(canvas, x, y, coverage, tinted)
    }
  }
}

/**
 * Signed distance to an axis-aligned rounded rectangle.
 * @param {number} x - left edge.
 * @param {number} y - top edge.
 * @param {number} width - rectangle width.
 * @param {number} height - rectangle height.
 * @param {number} radius - corner radius.
 * @returns {(px: number, py: number) => number} distance function.
 */
export function roundRectSdf(x, y, width, height, radius) {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const centreX = x + halfWidth
  const centreY = y + halfHeight
  const corner = Math.min(radius, halfWidth, halfHeight)
  return (px, py) => {
    const dx = Math.abs(px - centreX) - (halfWidth - corner)
    const dy = Math.abs(py - centreY) - (halfHeight - corner)
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
    return outside + Math.min(Math.max(dx, dy), 0) - corner
  }
}

/**
 * Signed distance to a circle.
 * @param {number} cx - centre x.
 * @param {number} cy - centre y.
 * @param {number} radius - radius.
 * @returns {(px: number, py: number) => number} distance function.
 */
export function circleSdf(cx, cy, radius) {
  return (px, py) => Math.hypot(px - cx, py - cy) - radius
}

/**
 * Signed distance to the line segment between two points, minus a radius (a capsule).
 * @param {number} x1 - start x.
 * @param {number} y1 - start y.
 * @param {number} x2 - end x.
 * @param {number} y2 - end y.
 * @param {number} radius - half thickness.
 * @returns {(px: number, py: number) => number} distance function.
 */
export function capsuleSdf(x1, y1, x2, y2, radius) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  return (px, py) => {
    let t = lengthSquared === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSquared
    t = Math.min(1, Math.max(0, t))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - radius
  }
}

/**
 * Signed distance to a ring arc, built from the distance to its sampled centreline.
 * @param {number} cx - centre x.
 * @param {number} cy - centre y.
 * @param {number} radius - arc radius.
 * @param {number} thickness - stroke thickness.
 * @param {number} fromDeg - start angle; 0 is east and angles grow clockwise (screen y is down).
 * @param {number} toDeg - end angle.
 * @param {number} [steps] - centreline samples.
 * @returns {(px: number, py: number) => number} distance function.
 */
export function arcSdf(cx, cy, radius, thickness, fromDeg, toDeg, steps = 48) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
  }
  return strokeSdf(points, thickness / 2)
}

/**
 * Signed distance to a polyline stroke.
 * @param {number[][]} points - `[x, y]` pairs.
 * @param {number} radius - half thickness.
 * @param {boolean} [closed] - whether to stroke the closing segment.
 * @returns {(px: number, py: number) => number} distance function.
 */
export function strokeSdf(points, radius, closed = false) {
  const segments = []
  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push(capsuleSdf(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], radius))
  }
  if (closed && points.length > 2) {
    const first = points[0]
    const last = points[points.length - 1]
    segments.push(capsuleSdf(last[0], last[1], first[0], first[1], radius))
  }
  return (px, py) => {
    let best = Infinity
    for (const segment of segments) {
      const distance = segment(px, py)
      if (distance < best) best = distance
    }
    return best
  }
}

/**
 * Mix two colours, used for hover and disabled tints.
 * @param {number[]} from - `[r, g, b, a]`.
 * @param {number[]} to - `[r, g, b, a]`.
 * @param {number} amount - 0 keeps `from`, 1 gives `to`.
 * @returns {number[]} mixed colour.
 */
export function mixColor(from, to, amount) {
  return from.map((channel, index) => channel + (to[index] - channel) * amount)
}

/**
 * Draw the microphone glyph inside a box.
 * @param {{width: number, height: number, pixels: Uint8ClampedArray}} canvas - target canvas.
 * @param {{x: number, y: number, width: number, height: number}} box - bounding box.
 * @param {number[]} color - glyph colour.
 * @returns {void}
 */
function drawMicrophone(canvas, box, color) {
  // The glyph is authored on a 24x24 grid and scaled into the box.
  const scaleX = box.width / 24
  const scaleY = box.height / 24
  const at = (x, y) => [box.x + x * scaleX, box.y + y * scaleY]
  const thickness = Math.max(1, 2 * Math.min(scaleX, scaleY))

  const [capsuleTopX, capsuleTopY] = at(12, 5)
  const [capsuleBottomX, capsuleBottomY] = at(12, 11.5)
  fillShape(canvas, capsuleSdf(capsuleTopX, capsuleTopY, capsuleBottomX, capsuleBottomY, 3 * scaleX), color)

  const [arcX, arcY] = at(12, 11)
  fillShape(canvas, arcSdf(arcX, arcY, 6.4 * scaleX, thickness, 15, 165), color)

  const [stemTopX, stemTopY] = at(12, 17.6)
  const [stemBottomX, stemBottomY] = at(12, 20.2)
  fillShape(canvas, capsuleSdf(stemTopX, stemTopY, stemBottomX, stemBottomY, thickness / 2), color)

  const [baseLeftX, baseLeftY] = at(8.6, 20.2)
  const [baseRightX, baseRightY] = at(15.4, 20.2)
  fillShape(canvas, capsuleSdf(baseLeftX, baseLeftY, baseRightX, baseRightY, thickness / 2), color)
}

/**
 * Render one button frame.
 *
 * States: `idle` and `hover` show the microphone on a slate disc, `recording` turns it red with a
 * white ring, and `transcribing` shows three dots on amber while the recognizer runs. A soft shadow
 * is baked in so the button stays visible over white documents and dark editors alike.
 *
 * @param {{size?: number, state?: string, scale?: number, shadow?: boolean}} [options] - frame options.
 * @returns {{width: number, height: number, margin: number, pixels: Buffer}} a premultiplied BGRA
 *   frame; `margin` is the transparent shadow border around the button itself, which a caller needs in
 *   order to line the visible disc up with a screen coordinate.
 */
export function renderButton(options = {}) {
  const size = Math.max(16, Math.round(options.size ?? 46))
  const state = BUTTON_STATES.includes(options.state) ? options.state : 'idle'
  const shadow = options.shadow !== false
  const margin = shadow ? Math.max(2, Math.round(size * 0.1)) : 0
  const canvas = createCanvas(size + margin * 2, size + margin * 2)
  const colour = PALETTE[state] ?? PALETTE.idle

  if (shadow) {
    // Three concentric passes approximate a blur closely enough at this size.
    for (const step of [{ grow: 0, alpha: 0.55 }, { grow: -1, alpha: 0.35 }, { grow: -2, alpha: 0.2 }]) {
      fillShape(canvas, roundRectSdf(margin + step.grow, margin + step.grow + 1, size - step.grow * 2, size - step.grow * 2, size * 0.32), PALETTE.shadow, {
        alphaScale: step.alpha,
      })
    }
  }

  const body = roundRectSdf(margin, margin, size, size, size * 0.32)
  fillShape(canvas, body, colour)
  // A one-pixel inner highlight separates the button from same-coloured backgrounds.
  fillShape(canvas, (x, y) => Math.abs(body(x, y) + 1) - 0.6, mixColor(colour, [255, 255, 255, 255], 0.35))

  if (state === 'transcribing') {
    const dotRadius = Math.max(1.6, size * 0.055)
    const dotY = margin + size / 2
    for (const offset of [-1, 0, 1]) {
      const dotX = margin + size / 2 + offset * dotRadius * 2.6
      fillShape(canvas, circleSdf(dotX, dotY, dotRadius), PALETTE.glyph)
    }
  } else {
    const glyphBox = {
      x: margin + size * 0.28,
      y: margin + size * 0.24,
      width: size * 0.44,
      height: size * 0.44,
    }
    drawMicrophone(canvas, glyphBox, state === 'recording' ? PALETTE.glyph : mixColor(PALETTE.glyph, colour, 0.12))
    if (state === 'recording') {
      fillShape(canvas, (x, y) => Math.abs(body(x, y) + 2.5) - (Math.max(1, size * 0.035) / 2), mixColor(PALETTE.glyph, colour, 0.25))
    }
  }

  return { width: canvas.width, height: canvas.height, margin, pixels: Buffer.from(canvas.pixels.buffer) }
}
