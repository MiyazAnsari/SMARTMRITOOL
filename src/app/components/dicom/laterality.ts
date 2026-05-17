export type Laterality = 'left' | 'right';

export const LATERALITIES: Laterality[] = ['left', 'right'];

const LATERALITY_HINTS: Array<{ pattern: RegExp; laterality: Laterality }> = [
  { pattern: /\bleft\b|left[\s_-]*knee|knee[\s_-]*left|\blk\b|\(\s*l\s*\)/i, laterality: 'left' },
  { pattern: /\bright\b|right[\s_-]*knee|knee[\s_-]*right|\brk\b|\(\s*r\s*\)/i, laterality: 'right' },
];

/** Scan path segments and names for left/right knee hints (not plane names like coronal). */
export function lateralityFromPath(relPath: string): Laterality | null {
  const norm = relPath.replace(/\\/g, '/');
  for (const segment of norm.split('/')) {
    if (!segment) continue;
    for (const { pattern, laterality } of LATERALITY_HINTS) {
      if (pattern.test(segment)) return laterality;
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

/**
 * When laterality is unknown, assign to the knee that does not yet have this plane
 * so bilateral uploads without labels still populate both sides.
 */
export function resolveLateralityForPlane(
  hint: Laterality | null,
  plane: import('./DicomLoader').Plane,
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
