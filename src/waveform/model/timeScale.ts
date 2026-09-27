// @index waveform-time — VCD timescale 解析、tick↔物理时间换算、自适应时间文本与刻度步长（宿主与 Webview 共用，纯函数）

export type TimeUnit = 's' | 'ms' | 'us' | 'ns' | 'ps' | 'fs';

export interface TimeScale {
  /** VCD allows 1, 10 or 100 of a unit per tick. */
  readonly magnitude: number;
  readonly unit: TimeUnit;
  /** Duration of one tick in femtoseconds (exact for every legal VCD timescale). */
  readonly femtoseconds: number;
}

const unitFemtoseconds: Readonly<Record<TimeUnit, number>> = {
  s: 1e15,
  ms: 1e12,
  us: 1e9,
  ns: 1e6,
  ps: 1e3,
  fs: 1
};

/** Largest-first so adaptive formatting picks the biggest unit that keeps values ≥ 1. */
const displayUnits: readonly TimeUnit[] = ['s', 'ms', 'us', 'ns', 'ps', 'fs'];

export const defaultTimeScale: TimeScale = { magnitude: 1, unit: 'ps', femtoseconds: 1e3 };

export function timeUnitFemtoseconds(unit: TimeUnit): number {
  return unitFemtoseconds[unit];
}

export function isTimeUnit(value: string): value is TimeUnit {
  return Object.prototype.hasOwnProperty.call(unitFemtoseconds, value);
}

/** Parse `$timescale` bodies and `$printtimescale` operands such as `1ps`, `10 ns` or `100 fs`. */
export function parseTimeScale(text: string): TimeScale | undefined {
  const match = /^\s*(1|10|100)\s*(s|ms|us|ns|ps|fs)\s*$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const magnitude = Number(match[1]);
  const unit = match[2].toLowerCase() as TimeUnit;
  return { magnitude, unit, femtoseconds: magnitude * unitFemtoseconds[unit] };
}

export function unitLabel(unit: TimeUnit): string {
  return unit === 'us' ? 'µs' : unit;
}

/** Pick the largest unit in which a duration of `femtoseconds` is at least 1. */
export function displayUnitFor(femtoseconds: number): TimeUnit {
  const magnitude = Math.abs(femtoseconds);
  if (magnitude === 0) {
    return 'ns';
  }
  for (const unit of displayUnits) {
    if (magnitude >= unitFemtoseconds[unit]) {
      return unit;
    }
  }
  return 'fs';
}

/**
 * Format a tick count as physical time. Values keep at most `maximumFractionDigits`
 * decimals with trailing zeros trimmed, so exact edges read as `474 ns` and
 * sub-unit positions as `474.5 ns`.
 *
 * Without an explicit unit, a larger unit is used only when it is exact and not
 * longer: `10000 ns` becomes `10 µs`, but `12345 ns` stays as written.
 */
export function formatTicks(
  ticks: number,
  scale: TimeScale,
  options: { unit?: TimeUnit; maximumFractionDigits?: number } = {}
): string {
  const femtoseconds = ticks * scale.femtoseconds;
  const digits = options.maximumFractionDigits ?? 3;
  if (options.unit) {
    return formatIn(femtoseconds, options.unit, digits);
  }
  const largest = displayUnitFor(femtoseconds);
  let best = formatIn(femtoseconds, largest, digits);
  let bestExact = isExactIn(femtoseconds, largest, digits);
  for (let index = displayUnits.indexOf(largest) + 1; index < displayUnits.length; index++) {
    const unit = displayUnits[index];
    if (!isExactIn(femtoseconds, unit, digits)) {
      continue;
    }
    const text = formatIn(femtoseconds, unit, digits);
    if (!bestExact || text.length < best.length) {
      best = text;
      bestExact = true;
    }
    if (Number.isInteger(femtoseconds / unitFemtoseconds[unit])) {
      break; // Smaller units only append zeros.
    }
  }
  return best;
}

function formatIn(femtoseconds: number, unit: TimeUnit, maximumFractionDigits: number): string {
  return `${formatNumber(femtoseconds / unitFemtoseconds[unit], maximumFractionDigits)} ${unitLabel(unit)}`;
}

/** Whether `maximumFractionDigits` decimals represent the duration in `unit` without rounding. */
function isExactIn(femtoseconds: number, unit: TimeUnit, maximumFractionDigits: number): boolean {
  const scaled = (femtoseconds / unitFemtoseconds[unit]) * 10 ** maximumFractionDigits;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-6 + 1e-12 * Math.abs(scaled);
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const fixed = value.toFixed(Math.max(0, Math.min(maximumFractionDigits, 12)));
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export interface TickStep {
  /** Major tick distance in ticks (an integer ≥ 1). */
  readonly major: number;
  /** Minor subdivisions between two major ticks. */
  readonly minorCount: number;
  /** Unit shared by every label along the ruler. */
  readonly unit: TimeUnit;
}

/**
 * Choose a 1/2/5×10ⁿ ruler step whose major ticks are at least `minimumPixels`
 * apart. Steps are whole ticks because the dump cannot resolve anything finer.
 */
export function chooseTickStep(ticksPerPixel: number, minimumPixels: number, scale: TimeScale): TickStep {
  const minimumTicks = Math.max(1, ticksPerPixel * minimumPixels);
  let exponent = Math.floor(Math.log10(minimumTicks));
  let major = Number.POSITIVE_INFINITY;
  let minorCount = 5;
  for (; exponent < 20 && !Number.isFinite(major); exponent++) {
    const base = 10 ** exponent;
    for (const factor of [1, 2, 5]) {
      const candidate = factor * base;
      if (candidate >= minimumTicks && Number.isInteger(candidate)) {
        major = candidate;
        minorCount = factor === 2 ? 4 : 5;
        break;
      }
    }
  }
  if (!Number.isFinite(major)) {
    major = Math.ceil(minimumTicks);
  }
  return { major, minorCount: major >= minorCount ? minorCount : 1, unit: displayUnitFor(major * scale.femtoseconds) };
}

/** Number of ticks equivalent to `amount` of `unit` (may be fractional for coarse dumps). */
export function ticksFromPhysical(amount: number, unit: TimeUnit, scale: TimeScale): number {
  return (amount * unitFemtoseconds[unit]) / scale.femtoseconds;
}
