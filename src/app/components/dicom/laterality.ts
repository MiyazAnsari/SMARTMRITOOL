export type Laterality = 'left' | 'right';

export const LATERALITIES: Laterality[] = ['left', 'right'];

/** Folder names like LeftKnee / RightKnee (checked after series-style names). */
const LATERALITY_HINTS: Array<{ pattern: RegExp; laterality: Laterality }> = [
  { pattern: /\bleft\b|left[\s_-]*knee|knee[\s_-]*left|\blk\b|\(\s*l\s*\)/i, laterality: 'left' },
  { pattern: /\bright\b|right[\s_-]*knee|knee[\s_-]*right|\brk\b|\(\s*r\s*\)/i, laterality: 'right' },
];

/** Series/folder names like AX_MPR_RIGHT, SAG_IW_TSE_LEFT (not bare "coronal"). */
const SERIES_RIGHT =
  /(?:^|[_\-.])RIGHT(?:$|[_\-.])|(?:^|[_\-.])RK(?:$|[_\-.])|\bRIGHT\s*KNEE\b/i;
const SERIES_LEFT =
  /(?:^|[_\-.])LEFT(?:$|[_\-.])|(?:^|[_\-.])LK(?:$|[_\-.])|\bLEFT\s*KNEE\b/i;

/** Detect laterality from DICOM SeriesDescription and similar labels. */
export function lateralityFromSeriesText(...parts: (string | undefined)[]): Laterality | null {
  const joined = parts.filter(Boolean).join(' ');
  if (!joined) return null;

  const hasRight = SERIES_RIGHT.test(joined);
  const hasLeft = SERIES_LEFT.test(joined);

  if (hasRight && !hasLeft) return 'right';
  if (hasLeft && !hasRight) return 'left';
  return null;
}

/**
 * Scan path segments for knee hints. Deepest segments first so AX_MPR_RIGHT
 * wins over a parent folder named LeftKnee.
 */
export function lateralityFromPath(relPath: string): Laterality | null {
  const norm = relPath.replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const fromSeries = lateralityFromSeriesText(seg);
    if (fromSeries) return fromSeries;
    for (const { pattern, laterality } of LATERALITY_HINTS) {
      if (pattern.test(seg)) return laterality;
    }
  }
  return null;
}

export function lateralityFromDicomTag(value: string | undefined): Laterality | null {
  const v = (value || '').trim().toUpperCase();
  if (v === 'L' || v === 'LEFT') return 'left';
  if (v === 'R' || v === 'RIGHT') return 'right';
  return null;
}

/** Resolve laterality for a volume using series name, then path, then DICOM tag. */
export function detectSeriesLaterality(
  ...parts: (string | undefined | null)[]
): Laterality | null {
  const texts = parts.filter((p): p is string => Boolean(p && p.trim()));

  const fromSeries = lateralityFromSeriesText(texts[0]);
  if (fromSeries) return fromSeries;

  for (const t of texts) {
    const fromPath = lateralityFromPath(t);
    if (fromPath) return fromPath;
  }

  for (const t of texts) {
    const fromTag = lateralityFromDicomTag(t);
    if (fromTag) return fromTag;
  }

  return null;
}

export function lateralityForVolume(vol: {
  seriesDescription?: string;
  laterality?: Laterality;
}): Laterality | null {
  return (
    lateralityFromSeriesText(vol.seriesDescription) ??
    (vol.laterality === 'left' || vol.laterality === 'right' ? vol.laterality : null)
  );
}

/**
 * When laterality is unknown, assign to the knee that does not yet have this plane
 * so bilateral uploads without labels still populate both sides.
 */
export function resolveLateralityForPlane(
  hint: Laterality | null,
  _plane: import('./DicomLoader').Plane,
  occupied: { left: boolean; right: boolean },
): Laterality {
  if (hint) return hint;
  if (!occupied.left) return 'left';
  if (!occupied.right) return 'right';
  return 'right';
}

export function measurementStorageKey(patientKey: string, laterality: Laterality): string {
  return `${patientKey}::${laterality}`;
}
