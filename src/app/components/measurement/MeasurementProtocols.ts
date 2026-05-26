import type { Plane } from '../dicom/DicomLoader';

export type Primitive = 'line' | 'distance' | 'angle' | 'point';

export interface ProtocolStep {
  /** Stable id used to key results inside the workflow state. */
  id: string;
  /** Short title shown in the checklist. */
  label: string;
  /** Longer instruction shown when the step is active. */
  instruction: string;
  /** Geometric primitive the user must draw to complete this step. */
  primitive: Primitive;
}

export interface MeasurementResult {
  /** Final clinical value (e.g. distance in mm, ratio, angle in deg). */
  value: number;
  unit: string;
  /** A human-readable summary, e.g. "TT-TG = 12.4 mm" */
  summary: string;
  /** Optional interpretation hint. */
  interpretation?: string;
}

export interface MeasurementProtocol {
  id: string;
  label: string;
  description: string;
  /** The plane the user should be looking at to take this measurement. */
  requiredPlane: Plane;
  steps: ProtocolStep[];
  /**
   * Given the completed step results (keyed by step id) and pixel spacing in
   * mm/pixel, return the clinical measurement. Returns null if not enough data.
   */
  compute: (
    results: Record<string, StepResult>,
    pixelSpacing: { x: number; y: number },
  ) => MeasurementResult | null;
}

export interface StepResult {
  primitive: Primitive;
  /** Image-coordinate points that define the primitive (in pixels). */
  points: { x: number; y: number }[];
  /** Slice index the primitive was drawn on. */
  slice: number;
}

const toPhysical = (
  p: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
) => ({ x: p.x * pixelSpacing.x, y: p.y * pixelSpacing.y });

const dist = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
) => Math.hypot((a.x - b.x) * pixelSpacing.x, (a.y - b.y) * pixelSpacing.y);

/**
 * Perpendicular distance, in pixels, from a point to a line defined by two
 * points (p1, p2).
 */
function perpDistance(
  pt: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
): number {
  const a = toPhysical(pt, pixelSpacing);
  const b1 = toPhysical(p1, pixelSpacing);
  const b2 = toPhysical(p2, pixelSpacing);
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * a.x - dx * a.y + b2.x * b1.y - b2.y * b1.x) / len;
}

function angleBetweenLines(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
): number {
  const a1 = toPhysical(p1, pixelSpacing);
  const a2 = toPhysical(p2, pixelSpacing);
  const b1 = toPhysical(p3, pixelSpacing);
  const b2 = toPhysical(p4, pixelSpacing);
  const v1x = a2.x - a1.x;
  const v1y = a2.y - a1.y;
  const v2x = b2.x - b1.x;
  const v2y = b2.y - b1.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

const TT_TG: MeasurementProtocol = {
  id: 'tt-tg',
  label: 'TT-TG',
  description:
    'Tibial Tubercle – Trochlear Groove distance measured between the two perpendicular landmarks using the posterior condylar line as reference.',
  requiredPlane: 'axial',
  steps: [
    {
      id: 'condyle-line',
      label: 'Posterior femoral condyle line',
      instruction:
        'Scroll to the slice showing the posterior femoral condyles. Click on "Distance" under Measurement Tools and place a line tangent to both posterior condyles.',
      primitive: 'line',
    },
    {
      id: 'trochlear-groove',
      label: 'Deepest point of trochlear groove',
      instruction:
        'Scroll to the slice showing the trochlear groove. Click on "Perpendicular" and click on the line you just made to create a perpendicular branch. Drag and adjust this branch to the deepest point of the groove.',
      primitive: 'point',
    },
    {
      id: 'tibial-tubercle',
      label: 'Most anterior point of tibial tubercle',
      instruction:
        'Scroll down to the slice showing the tibial tubercle. Click on "Perpendicular" and click on the line you just made to create another perpendicular branch, parallel to the first. Drag and adjust to the most anterior point.',
      primitive: 'point',
    },
  ],
  compute: (results, ps) => {
    const cond = results['condyle-line'];
    const groove = results['trochlear-groove'];
    const tubercle = results['tibial-tubercle'];
    if (!cond || cond.points.length < 2) return null;
    if (!groove || groove.points.length < 1) return null;
    if (!tubercle || tubercle.points.length < 1) return null;

    const [c1, c2] = cond.points;
    const c1p = toPhysical(c1, ps);
    const c2p = toPhysical(c2, ps);
    const dx = c2p.x - c1p.x;
    const dy = c2p.y - c1p.y;
    const len2 = dx * dx + dy * dy || 1;
    const len = Math.sqrt(len2);

    // A perpendicular branch stores [anchor-on-reference-line, actual-landmark].
    // TT-TG is the shortest distance between the two parallel perpendicular
    // branches, measured along the posterior condylar reference axis, so we use
    // the branch anchors (the points on the condylar line).
    const anchorOf = (r: StepResult): { x: number; y: number } => r.points[0] ?? r.points[r.points.length - 1];

    const projectAlongCondyle = (p: { x: number; y: number }): number => {
      const pp = toPhysical(p, ps);
      return ((pp.x - c1p.x) * dx + (pp.y - c1p.y) * dy) / len2;
    };

    const grooveT = projectAlongCondyle(anchorOf(groove));
    const tubercleT = projectAlongCondyle(anchorOf(tubercle));
    const value = Math.abs(tubercleT - grooveT) * len;
    return {
      value,
      unit: 'mm',
      summary: `TT-TG = ${value.toFixed(1)} mm`,
      interpretation:
        value > 20
          ? 'Elevated (>20 mm) — associated with patellar instability.'
          : value > 15
            ? 'Borderline (15–20 mm).'
            : 'Within normal range (<15 mm).',
    };
  },
};

const INSALL_SALVATI: MeasurementProtocol = {
  id: 'insall-salvati',
  label: 'Insall–Salvati',
  description:
    'Patella alta/baja ratio. Measured on a sagittal slice with full patella + tendon visible.',
  requiredPlane: 'sagittal',
  steps: [
    {
      id: 'patella-length',
      label: 'Patella length (LP)',
      instruction:
        'Scroll to the sagittal slice that shows the full patella and tendon. Draw a line along the longest diagonal of the patella.',
      primitive: 'distance',
    },
    {
      id: 'tendon-length',
      label: 'Patellar tendon length (LT)',
      instruction:
        'Draw a line from the lower pole of the patella to the tibial tuberosity attachment.',
      primitive: 'distance',
    },
  ],
  compute: (results, ps) => {
    const lp = results['patella-length'];
    const lt = results['tendon-length'];
    if (!lp || lp.points.length < 2 || !lt || lt.points.length < 2) return null;
    const lpMm = dist(lp.points[0], lp.points[1], ps);
    const ltMm = dist(lt.points[0], lt.points[1], ps);
    if (lpMm === 0) return null;
    const ratio = ltMm / lpMm;
    return {
      value: ratio,
      unit: '',
      summary: `Insall–Salvati = ${ratio.toFixed(2)} (LT ${ltMm.toFixed(
        1,
      )} mm / LP ${lpMm.toFixed(1)} mm)`,
      interpretation:
        ratio > 1.2
          ? 'Patella alta (>1.2).'
          : ratio < 0.8
            ? 'Patella baja (<0.8).'
            : 'Normal (0.8–1.2).',
    };
  },
};

const PATELLAR_TILT: MeasurementProtocol = {
  id: 'patellar-tilt',
  label: 'Patellar Tilt Angle',
  description:
    'Angle between the patellar transverse axis and the posterior femoral condyle line.',
  requiredPlane: 'axial',
  steps: [
    {
      id: 'condyle-line',
      label: 'Posterior femoral condyle line',
      instruction:
        'On the axial slice that shows both posterior condyles, place a line tangent to them.',
      primitive: 'line',
    },
    {
      id: 'patella-axis',
      label: 'Patella transverse axis',
      instruction:
        'Place a line across the widest medial-to-lateral axis of the patella on the same slice.',
      primitive: 'line',
    },
  ],
  compute: (results, ps) => {
    const cond = results['condyle-line'];
    const pat = results['patella-axis'];
    if (!cond || cond.points.length < 2 || !pat || pat.points.length < 2) return null;
    const angle = angleBetweenLines(
      cond.points[0],
      cond.points[1],
      pat.points[0],
      pat.points[1],
      ps,
    );
    // The clinical convention reports the acute angle.
    const acute = angle > 90 ? 180 - angle : angle;
    return {
      value: acute,
      unit: '°',
      summary: `Patellar tilt = ${acute.toFixed(1)}°`,
      interpretation:
        acute > 20
          ? 'Increased tilt (>20°) — abnormal.'
          : acute > 10
            ? 'Borderline (10–20°).'
            : 'Within normal range (<10°).',
    };
  },
};

const SULCUS_ANGLE: MeasurementProtocol = {
  id: 'sulcus-angle',
  label: 'Sulcus Angle',
  description:
    'Angle of the trochlear sulcus on axial slice through the trochlear groove.',
  requiredPlane: 'axial',
  steps: [
    {
      id: 'medial-line',
      label: 'Line from medial condyle peak to sulcus',
      instruction:
        'Click the highest point of the medial condyle, then click the deepest point of the trochlear groove.',
      primitive: 'line',
    },
    {
      id: 'lateral-line',
      label: 'Line from lateral condyle peak to sulcus',
      instruction:
        'Click the highest point of the lateral condyle, then click the same deepest groove point as before.',
      primitive: 'line',
    },
  ],
  compute: (results, ps) => {
    const m = results['medial-line'];
    const l = results['lateral-line'];
    if (!m || m.points.length < 2 || !l || l.points.length < 2) return null;
    const angle = angleBetweenLines(m.points[0], m.points[1], l.points[1], l.points[0], ps);
    return {
      value: angle,
      unit: '°',
      summary: `Sulcus angle = ${angle.toFixed(1)}°`,
      interpretation:
        angle > 145
          ? 'Trochlear dysplasia likely (>145°).'
          : 'Within normal range (<145°).',
    };
  },
};

export const MEASUREMENT_PROTOCOLS: MeasurementProtocol[] = [
  TT_TG,
  INSALL_SALVATI,
  PATELLAR_TILT,
  SULCUS_ANGLE,
];

export function getProtocol(id: string | undefined | null): MeasurementProtocol | null {
  if (!id) return null;
  return MEASUREMENT_PROTOCOLS.find((p) => p.id === id) || null;
}