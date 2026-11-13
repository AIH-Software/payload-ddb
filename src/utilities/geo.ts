/**
 * Geometry for Payload's point-field operators (`near`, `within`,
 * `intersects`), evaluated in JS because DynamoDB has no geospatial
 * functions.
 *
 * Points are `[longitude, latitude]` pairs — the shape Payload hands a
 * document-style adapter and the shape we store. A GeoJSON `Point` object is
 * accepted too. Distances are great-circle metres; polygon tests are planar
 * ray casts over lng/lat, which is exact enough for the bounding shapes these
 * operators are used with but is not geodesic.
 */

type Position = [number, number]

const EARTH_RADIUS_METERS = 6_371_008.8

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toNumber(value: unknown): null | number {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Read a stored or supplied point: `[lng, lat]` or `{ type: 'Point', coordinates }`. */
export function asPosition(value: unknown): null | Position {
  const pair =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { coordinates?: unknown }).coordinates
      : value
  if (!Array.isArray(pair) || pair.length < 2) return null
  const lng = toNumber(pair[0])
  const lat = toNumber(pair[1])
  return lng === null || lat === null ? null : [lng, lat]
}

export function distanceInMeters(a: Position, b: Position): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRadians(b[1] - a[1])
  const dLng = toRadians(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a[1])) * Math.cos(toRadians(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type NearQuery = { center: Position; maxDistance: null | number; minDistance: null | number }

/**
 * Parse a `near` operand: `'lng,lat,maxDistance,minDistance'` or the same as
 * an array. Distances are metres and optional. Returns `null` when the
 * centre isn't a usable coordinate pair.
 */
export function parseNear(operand: unknown): NearQuery | null {
  const parts = typeof operand === 'string' ? operand.split(',') : operand
  if (!Array.isArray(parts)) return null
  const lng = toNumber(parts[0])
  const lat = toNumber(parts[1])
  if (lng === null || lat === null) return null
  return {
    center: [lng, lat],
    maxDistance: toNumber(parts[2]),
    minDistance: toNumber(parts[3]),
  }
}

export function matchesNear(value: unknown, operand: unknown): boolean {
  const point = asPosition(value)
  const query = parseNear(operand)
  if (!point || !query) return false
  const distance = distanceInMeters(point, query.center)
  if (query.maxDistance !== null && distance > query.maxDistance) return false
  if (query.minDistance !== null && distance < query.minDistance) return false
  return true
}

function inRing(point: Position, ring: unknown): boolean {
  if (!Array.isArray(ring)) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = asPosition(ring[i])
    const b = asPosition(ring[j])
    if (!a || !b) continue
    const crosses =
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    if (crosses) inside = !inside
  }
  return inside
}

/** First ring is the outline; any further rings are holes. */
function inPolygon(point: Position, rings: unknown): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false
  if (!inRing(point, rings[0])) return false
  return !rings.slice(1).some((hole) => inRing(point, hole))
}

/** `within`: the stored point lies inside a GeoJSON `Polygon` / `MultiPolygon`. */
export function matchesWithin(value: unknown, operand: unknown): boolean {
  const point = asPosition(value)
  if (!point || !operand || typeof operand !== 'object') return false
  const { type, coordinates } = operand as { coordinates?: unknown; type?: unknown }
  if (type === 'Polygon') return inPolygon(point, coordinates)
  if (type === 'MultiPolygon') {
    return Array.isArray(coordinates) && coordinates.some((rings) => inPolygon(point, rings))
  }
  return false
}

/**
 * `intersects`: for a stored point that means "is this point" against a
 * GeoJSON `Point`, and "lies inside" against a polygon.
 */
export function matchesIntersects(value: unknown, operand: unknown): boolean {
  const point = asPosition(value)
  if (!point || !operand || typeof operand !== 'object') return false
  if ((operand as { type?: unknown }).type === 'Point') {
    const other = asPosition(operand)
    return other !== null && other[0] === point[0] && other[1] === point[1]
  }
  return matchesWithin(value, operand)
}
