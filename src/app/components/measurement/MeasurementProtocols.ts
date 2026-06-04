import type { Plane } from '../dicom/DicomLoader';

export type Primitive = 'line' | 'distance' | 'angle' | 'point';
export type WorkflowTool = 'none' | 'distance' | 'angle' | 'line' | 'point';

export interface ProtocolStep {
  /** Stable id used to key results inside the workflow state. */
  id: string;
  /** Short title shown in the checklist. */
  label: string;
  /** Longer instruction shown when the step is active. */
  instruction: string;
  /** Bottom toolbar tool that should be highlighted for this step. */
  tool: WorkflowTool;
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
   * Given the completed step results (keyed by step id), pixel spacing in
   * mm/image-pixel, and optionally the CSS→image-pixel scale factor, return
   * the clinical measurement. Returns null if not enough data.
   */
  compute: (
    results: Record<string, StepResult>,
    pixelSpacing: { x: number; y: number },
    imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
  ) => MeasurementResult | null;
}

export interface StepResult {
  primitive: Primitive;
  /** CSS-pixel coordinate points from the viewport overlay (NOT image pixels). */
  points: { x: number; y: number }[];
  /** Slice index the primitive was drawn on. */
  slice: number;
  /** CSS→image-pixel scale factor at the moment these points were captured/remapped.
   *  Stored atomically with points so protocol `compute` always has the correct
   *  conversion regardless of display-size change timing. */
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
}

const toPhysical = (
  p: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
) => ({
  x: (p.x - (imageScale?.offsetX ?? 0)) * (imageScale?.x ?? 1) * pixelSpacing.x,
  y: (p.y - (imageScale?.offsetY ?? 0)) * (imageScale?.y ?? 1) * pixelSpacing.y,
});

const dist = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
) => {
  const sx = (imageScale?.x ?? 1) * pixelSpacing.x;
  const sy = (imageScale?.y ?? 1) * pixelSpacing.y;
  return Math.hypot((a.x - b.x) * sx, (a.y - b.y) * sy);
};

/**
 * Perpendicular distance, in mm, from a point to a line defined by two points.
 */
function perpDistance(
  pt: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  const a = toPhysical(pt, pixelSpacing, imageScale);
  const b1 = toPhysical(p1, pixelSpacing, imageScale);
  const b2 = toPhysical(p2, pixelSpacing, imageScale);
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
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  const a1 = toPhysical(p1, pixelSpacing, imageScale);
  const a2 = toPhysical(p2, pixelSpacing, imageScale);
  const b1 = toPhysical(p3, pixelSpacing, imageScale);
  const b2 = toPhysical(p4, pixelSpacing, imageScale);
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
        'Use Distance. On the slice with both posterior condyles, draw a tangent line.',
      tool: 'distance',
      primitive: 'line',
    },
    {
      id: 'trochlear-groove',
      label: 'Deepest point of trochlear groove',
      instruction:
        'Use Select. Click the condyle line, then drag the branch to the deepest trochlear groove point.',
      tool: 'none',
      primitive: 'point',
    },
    {
      id: 'tibial-tubercle',
      label: 'Most anterior point of tibial tubercle',
      instruction:
        'Use Select. Add the second branch from the condyle line, then drag it to the most anterior tibial tubercle point.',
      tool: 'none',
      primitive: 'point',
    },
  ],
  compute: (results, ps, paramImageScale) => {
    const cond = results['condyle-line'];
    const groove = results['trochlear-groove'];
    const tubercle = results['tibial-tubercle'];
    if (!cond || cond.points.length < 2) return null;
    if (!groove || groove.points.length < 1) return null;
    if (!tubercle || tubercle.points.length < 1) return null;

    // Prefer per-StepResult imageScale (atomically stored with points)
    // over the separately-threaded parameter.
    const imageScale = cond.imageScale ?? groove.imageScale ?? tubercle.imageScale ?? paramImageScale;

    const [c1, c2] = cond.points;
    const c1p = toPhysical(c1, ps, imageScale);
    const c2p = toPhysical(c2, ps, imageScale);
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
      const pp = toPhysical(p, ps, imageScale);
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
        'Use Distance. Draw a line along the longest patellar axis.',
      tool: 'distance',
      primitive: 'distance',
    },
    {
      id: 'tendon-length',
      label: 'Patellar tendon length (LT)',
      instruction:
        'Use Distance. Draw a line from the lower patellar pole to the tibial tuberosity.',
      tool: 'distance',
      primitive: 'distance',
    },
  ],
  compute: (results, ps, paramImageScale) => {
    const lp = results['patella-length'];
    const lt = results['tendon-length'];
    if (!lp || lp.points.length < 2 || !lt || lt.points.length < 2) return null;
    const imageScale = lp.imageScale ?? lt.imageScale ?? paramImageScale;
    const lpMm = dist(lp.points[0], lp.points[1], ps, imageScale);
    const ltMm = dist(lt.points[0], lt.points[1], ps, imageScale);
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
        'Use Distance. Draw a tangent line across both posterior condyles.',
      tool: 'distance',
      primitive: 'line',
    },
    {
      id: 'patella-axis',
      label: 'Patella transverse axis',
      instruction:
        'Use Distance. Draw a line across the widest patellar width.',
      tool: 'distance',
      primitive: 'line',
    },
  ],
  compute: (results, ps, paramImageScale) => {
    const cond = results['condyle-line'];
    const pat = results['patella-axis'];
    if (!cond || cond.points.length < 2 || !pat || pat.points.length < 2) return null;
    const imageScale = cond.imageScale ?? pat.imageScale ?? paramImageScale;
    const angle = angleBetweenLines(
      cond.points[0],
      cond.points[1],
      pat.points[0],
      pat.points[1],
      ps,
      imageScale,
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
        'Use Distance. Click the medial condyle peak, then the deepest trochlear groove point.',
      tool: 'distance',
      primitive: 'line',
    },
    {
      id: 'lateral-line',
      label: 'Line from lateral condyle peak to sulcus',
      instruction:
        'Use Distance. Click the lateral condyle peak, then the same groove point.',
      tool: 'distance',
      primitive: 'line',
    },
  ],
  compute: (results, ps, paramImageScale) => {
    const m = results['medial-line'];
    const l = results['lateral-line'];
    if (!m || m.points.length < 2 || !l || l.points.length < 2) return null;
    const imageScale = m.imageScale ?? l.imageScale ?? paramImageScale;
    // Both lines share the groove point as their second endpoint (points[1]).
    // Vectors groove→condyle naturally point posteriorly in similar directions
    // and yield an acute angle; the clinical sulcus angle is the supplement
    // (the obtuse angle opening posteriorly between the trochlear facets).
    const raw = angleBetweenLines(m.points[1], m.points[0], l.points[1], l.points[0], ps, imageScale);
    const angle = raw < 90 ? 180 - raw : raw;
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