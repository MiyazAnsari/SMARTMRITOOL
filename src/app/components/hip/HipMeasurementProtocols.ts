// Hip X-ray Measurement Protocol
// 10 clinical measurements for AP Pelvis hip X-rays with reference-line reuse.
//
// Measurement list:
//  1. Medial Cortical Thickness (point pair on lesser trochanter guideline)
//  2. Lateral Cortical Thickness (point pair on lesser trochanter guideline)
//  3. Shaft Thickness = auto distance between most medial/lateral of #1 & #2
//  4. Femur Neck Width = shortest distance across narrowest bone points
//  5. Femur Head Diameter = parallel to neck width, at femoral head
//  6. Hip Axis Length = 2 points on guideline through midpoints
//  7. Femoral Neck Axis Length = 2 points: lateral (reuses hip axis lateral) + medial (femur head edge on midpoint guideline)
//  8. Horizontal Offset = auto perpendicular distance from femoral head midpoint to shaft midline
//  9. Vertical Offset = auto perpendicular distance from femoral head midpoint to lesser trochanter guideline
// 10. Femur Neck Angle = auto angle between hip axis length and femur shaft midline
//
// Guideline steps (user draws once, reused):
//  G1. Femur Shaft Midline – collinear line through femur shaft
//  G2. Lesser Trochanter Guideline – perpendicular to G1 at lesser trochanter
//  G3. Femur Neck Width line – shortest distance across narrowest bone
//  G4. Femur Head Diameter line – parallel to G3 at femoral head
//  G5. Guideline Through Midpoints – line through midpoints of G3 & G4

import type {
  MeasurementProtocol,
  ProtocolStep,
  StepResult,
} from '../measurement/MeasurementProtocols';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function toPhysical(
  p: { x: number; y: number },
  pixelSpacing: { x: number; y: number },
  _imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number },
) {
  // Points are image-pixel coordinates — multiply directly by mm-per-pixel.
  return {
    x: p.x * pixelSpacing.x,
    y: p.y * pixelSpacing.y,
  };
}

function distMm(
  a: { x: number; y: number },
  b: { x: number; y: number },
  ps: { x: number; y: number },
  _is?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  // Points are image-pixel coordinates — multiply directly by mm-per-pixel.
  return Math.hypot((a.x - b.x) * ps.x, (a.y - b.y) * ps.y);
}

/** Perpendicular distance from point pt to the infinite line through p1-p2 (mm). */
function perpDistMm(
  pt: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  ps: { x: number; y: number },
  _is?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  // _is is unused — toPhysical now uses image-pixel coords directly.
  const a = toPhysical(pt, ps);
  const b1 = toPhysical(p1, ps);
  const b2 = toPhysical(p2, ps);
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * a.x - dx * a.y + b2.x * b1.y - b2.y * b1.x) / len;
}

/** Midpoint of two points. */
function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Compute the signed angle between two directed lines (in degrees).
 *  line1: p1→p2,  line2: p3→p4.
 *  Returns angle in [0, 180]. For signed rotation, caller adjusts. */
function angleBetweenLinesDeg(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
  ps: { x: number; y: number },
  _is?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  // _is unused — toPhysical uses image-pixel coords directly.
  const a1 = toPhysical(p1, ps);
  const a2 = toPhysical(p2, ps);
  const b1 = toPhysical(p3, ps);
  const b2 = toPhysical(p4, ps);
  const v1x = a2.x - a1.x;
  const v1y = a2.y - a1.y;
  const v2x = b2.x - b1.x;
  const v2y = b2.y - b1.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Compute the signed (CW/CCW) angle from line1→line2 using the cross product.
 *  Positive = counter-clockwise rotation. */
function signedAngleDeg(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
  ps: { x: number; y: number },
  _is?: { x: number; y: number; offsetX?: number; offsetY?: number },
): number {
  // _is unused — toPhysical uses image-pixel coords directly.
  const a1 = toPhysical(p1, ps);
  const a2 = toPhysical(p2, ps);
  const b1 = toPhysical(p3, ps);
  const b2 = toPhysical(p4, ps);
  const v1x = a2.x - a1.x;
  const v1y = a2.y - a1.y;
  const v2x = b2.x - b1.x;
  const v2y = b2.y - b1.y;
  const dot = v1x * v2x + v1y * v2y;
  const cross = v1x * v2y - v1y * v2x;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** Project point onto the infinite line defined by two points (returns fraction t). */
function projectOntoLine(
  pt: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy || 1;
  return ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / len2;
}

// ---------------------------------------------------------------------------
// Protocol steps
// ---------------------------------------------------------------------------

const HIP_PROTOCOL_STEPS: ProtocolStep[] = [
  // ── Step 1: Lesser trochanter guideline (free) ─────────────────────────
  {
    id: 'lesser-trochanter-guideline',
    label: 'Lesser Trochanter Guideline',
    instruction:
      'Use Distance. Draw a line under the lesser trochanter spanning the full femur shaft width.',
    tool: 'distance',
    primitive: 'distance',
  },
  // ── Step 2: Femur shaft midline (AUTO-CREATED) ────────────────────────
  {
    id: 'femur-shaft-midline',
    label: 'Femur Shaft Midline',
    instruction:
      'Auto-created perpendicular to the lesser trochanter guideline through its midpoint.',
    tool: 'distance',
    primitive: 'distance',
  },
  // ── Measurement 1: Medial Cortical Point (1 point on G2) ─────────────
  {
    id: 'medial-cortical-point',
    label: 'Medial Cortical Edge',
    instruction:
      'Use Point. On the lesser trochanter guideline, place a single point at the medial cortical edge.',
    tool: 'point',
    primitive: 'point',
  },
  // ── Measurement 2: Lateral Cortical Point (1 point on G2) ────────────
  {
    id: 'lateral-cortical-point',
    label: 'Lateral Cortical Edge',
    instruction:
      'Use Point. On the lesser trochanter guideline, place a single point at the lateral cortical edge.',
    tool: 'point',
    primitive: 'point',
  },
  // ── Measurement 3: Shaft Thickness (AUTO from steps 3 & 4) ────────────
  // (auto-computed — no user action)
  // ── Measurement 4: Femur Neck Width ───────────────────────────────────
  {
    id: 'femur-neck-width',
    label: 'Femur Neck Width',
    instruction:
      'Use Distance. Draw the shortest line across the narrowest points of the femoral neck bone.',
    tool: 'distance',
    primitive: 'distance',
  },
  // ── Measurement 5: Femur Head Diameter ────────────────────────────────
  {
    id: 'femur-head-diameter',
    label: 'Femur Head Diameter',
    instruction:
      'Use Distance. Draw a line parallel to the femur neck width at the widest part of the femoral head. Extend past the bone edges.',
    tool: 'distance',
    primitive: 'distance',
  },
  // ── Guideline 5: Through midpoints (AUTO-CREATED) ─────────────────────
  {
    id: 'midpoint-guideline',
    label: 'Guideline Through Midpoints',
    instruction:
      'Auto-created when femur neck width and head diameter are completed. Drag endpoints to adjust.',
    tool: 'distance',
    primitive: 'distance',
  },
  // ── Measurement 6: Hip Axis Length — lateral point ───────────────────
  {
    id: 'hip-axis-lateral',
    label: 'Hip Axis — Lateral Edge',
    instruction:
      'Use Point. On the auto-created midpoint guideline, place a single point at the lateral edge of the femur.',
    tool: 'point',
    primitive: 'point',
  },
  // ── Measurement 6b: Hip Axis Length — medial point ────────────────────
  {
    id: 'hip-axis-medial',
    label: 'Hip Axis — Medial Edge',
    instruction:
      'Use Point. On the midpoint guideline, place a single point at the medial edge of the pelvis.',
    tool: 'point',
    primitive: 'point',
  },
  // ── Measurement 7: Femoral Neck Axis Length — medial point (lat reused) ──
  {
    id: 'neck-axis-medial',
    label: 'Neck Axis — Medial Edge',
    instruction:
      'Use Point. On the midpoint guideline, place a single point at the medial edge of the femur head (different from the hip axis medial point on the pelvis).',
    tool: 'point',
    primitive: 'point',
  },
  // ── Measurement 8: Horizontal Offset (AUTO) ───────────────────────────
  // (auto-computed)
  // ── Measurement 9: Vertical Offset (AUTO) ─────────────────────────────
  // (auto-computed)
  // ── Measurement 10: Femur Neck Angle (AUTO) ───────────────────────────
  // (auto-computed)
];

// ---------------------------------------------------------------------------
// Protocol definition
// ---------------------------------------------------------------------------

export const HIP_MEASUREMENT_PROTOCOL: MeasurementProtocol = {
  id: 'hip-measurements',
  label: 'Hip X-ray Measurements',
  description:
    '10-measurement protocol for AP Pelvis hip X-rays. Draw guidelines once; derived values auto-compute. Toggle Left/Right hip for side-specific angle direction.',
  requiredPlane: 'coronal',
  steps: HIP_PROTOCOL_STEPS,

  compute: (results, ps, paramImageScale) => {
    // ── Gather step results ─────────────────────────────────────────────
    const shaftMidline = results['femur-shaft-midline'];
    const ltGuideline = results['lesser-trochanter-guideline'];
    const medialPt = results['medial-cortical-point'];
    const lateralPt = results['lateral-cortical-point'];
    const neckWidth = results['femur-neck-width'];
    const headDiameter = results['femur-head-diameter'];
    const midGuideline = results['midpoint-guideline'];
    const hipAxisLat = results['hip-axis-lateral'];
    const hipAxisMed = results['hip-axis-medial'];
    const neckAxisMed = results['neck-axis-medial'];
    // Backward compat: old combined distance-style results
    const hipAxis = results['hip-axis-length'];
    const neckAxis = results['femoral-neck-axis-length'];

    // Determine the best imageScale (prefer step results over parameter)
    const imageScale =
      shaftMidline?.imageScale ??
      ltGuideline?.imageScale ??
      neckWidth?.imageScale ??
      headDiameter?.imageScale ??
      midGuideline?.imageScale ??
      hipAxisLat?.imageScale ?? hipAxisMed?.imageScale ??
      neckAxisMed?.imageScale ??
      hipAxis?.imageScale ??
      neckAxis?.imageScale ??
      paramImageScale;

    const lines: string[] = [];
    // Store computed geometry for visual overlay rendering
    const derivedGeom: { type: string; points: { x: number; y: number }[] }[] = [];

    // M1 & M2 & M3: Cortical thicknesses + shaft thickness
    // Use t-values to determine which guideline endpoint is medial vs lateral
    // (works regardless of which direction the guideline was drawn)
    if (medialPt && lateralPt && medialPt.points.length >= 1 && lateralPt.points.length >= 1 && ltGuideline && ltGuideline.points.length >= 2) {
      const gp1 = ltGuideline.points[0];
      const gp2 = ltGuideline.points[1];
      const gdx = gp2.x - gp1.x;
      const gdy = gp2.y - gp1.y;
      const tMed = projectOntoLine(medialPt.points[0], gp1, gp2);
      const tLat = projectOntoLine(lateralPt.points[0], gp1, gp2);
      const projMed = { x: gp1.x + gdx * tMed, y: gp1.y + gdy * tMed };
      const projLat = { x: gp1.x + gdx * tLat, y: gp1.y + gdy * tLat };
      const shaftThickness = distMm(projMed, projLat, ps, imageScale);
      if (tMed < tLat) {
        // gp1 is medial, gp2 is lateral
        lines.push(`M1. Medial Cortical Thickness = ${distMm(gp1, projMed, ps, imageScale).toFixed(1)} mm`);
        lines.push(`M2. Lateral Cortical Thickness = ${distMm(gp2, projLat, ps, imageScale).toFixed(1)} mm`);
      } else {
        // gp2 is medial, gp1 is lateral
        lines.push(`M1. Medial Cortical Thickness = ${distMm(gp2, projMed, ps, imageScale).toFixed(1)} mm`);
        lines.push(`M2. Lateral Cortical Thickness = ${distMm(gp1, projLat, ps, imageScale).toFixed(1)} mm`);
      }
      lines.push(`M3. Shaft Thickness = ${shaftThickness.toFixed(1)} mm`);
    }

    // M4: Femur Neck Width
    if (neckWidth && neckWidth.points.length >= 2) {
      const d = distMm(neckWidth.points[0], neckWidth.points[1], ps, imageScale);
      lines.push(`M4. Femur Neck Width = ${d.toFixed(1)} mm`);
    }

    // M5: Femur Head Diameter
    if (headDiameter && headDiameter.points.length >= 2) {
      const d = distMm(headDiameter.points[0], headDiameter.points[1], ps, imageScale);
      lines.push(`M5. Femur Head Diameter = ${d.toFixed(1)} mm`);
    }

    // M6: Hip Axis Length — project two point placements onto the midpoint guideline
    if (hipAxisLat && hipAxisMed && hipAxisLat.points.length >= 1 && hipAxisMed.points.length >= 1 && midGuideline && midGuideline.points.length >= 2) {
      const mg0 = midGuideline.points[0];
      const mg1 = midGuideline.points[1];
      const tLat = projectOntoLine(hipAxisLat.points[0], mg0, mg1);
      const tMed = projectOntoLine(hipAxisMed.points[0], mg0, mg1);
      const gdx = mg1.x - mg0.x;
      const gdy = mg1.y - mg0.y;
      const projLat = { x: mg0.x + gdx * tLat, y: mg0.y + gdy * tLat };
      const projMed = { x: mg0.x + gdx * tMed, y: mg0.y + gdy * tMed };
      const d = distMm(projLat, projMed, ps, imageScale);
      lines.push(`M6. Hip Axis Length = ${d.toFixed(1)} mm`);
    } else if (hipAxis && hipAxis.points.length >= 2 && midGuideline && midGuideline.points.length >= 2) {
      // fallback: old combined distance result
      const mg0 = midGuideline.points[0];
      const mg1 = midGuideline.points[1];
      const t0 = projectOntoLine(hipAxis.points[0], mg0, mg1);
      const t1 = projectOntoLine(hipAxis.points[1], mg0, mg1);
      const gdx = mg1.x - mg0.x;
      const gdy = mg1.y - mg0.y;
      const proj0 = { x: mg0.x + gdx * t0, y: mg0.y + gdy * t0 };
      const proj1 = { x: mg0.x + gdx * t1, y: mg0.y + gdy * t1 };
      const d = distMm(proj0, proj1, ps, imageScale);
      lines.push(`M6. Hip Axis Length = ${d.toFixed(1)} mm`);
    } else if (hipAxis && hipAxis.points.length >= 2) {
      const d = distMm(hipAxis.points[0], hipAxis.points[1], ps, imageScale);
      lines.push(`M6. Hip Axis Length = ${d.toFixed(1)} mm`);
    }

    // M7: Femoral Neck Axis Length — lateral = hip-axis-lat, medial = femur head edge on midpoint guideline
    if (hipAxisLat && neckAxisMed && hipAxisLat.points.length >= 1 && neckAxisMed.points.length >= 1 && midGuideline && midGuideline.points.length >= 2) {
      const mg0 = midGuideline.points[0];
      const mg1 = midGuideline.points[1];
      const tLat = projectOntoLine(hipAxisLat.points[0], mg0, mg1);
      const tMed = projectOntoLine(neckAxisMed.points[0], mg0, mg1);
      const gdx = mg1.x - mg0.x;
      const gdy = mg1.y - mg0.y;
      const projLat = { x: mg0.x + gdx * tLat, y: mg0.y + gdy * tLat };
      const projMed = { x: mg0.x + gdx * tMed, y: mg0.y + gdy * tMed };
      const d = distMm(projLat, projMed, ps, imageScale);
      lines.push(`M7. Femoral Neck Axis Length = ${d.toFixed(1)} mm`);
    } else if (neckAxis && neckAxis.points.length >= 2 && midGuideline && midGuideline.points.length >= 2) {
      const mg0 = midGuideline.points[0];
      const mg1 = midGuideline.points[1];
      const t0 = projectOntoLine(neckAxis.points[0], mg0, mg1);
      const t1 = projectOntoLine(neckAxis.points[1], mg0, mg1);
      const gdx = mg1.x - mg0.x;
      const gdy = mg1.y - mg0.y;
      const proj0 = { x: mg0.x + gdx * t0, y: mg0.y + gdy * t0 };
      const proj1 = { x: mg0.x + gdx * t1, y: mg0.y + gdy * t1 };
      const d = distMm(proj0, proj1, ps, imageScale);
      lines.push(`M7. Femoral Neck Axis Length = ${d.toFixed(1)} mm`);
    } else if (neckAxis && neckAxis.points.length >= 2) {
      const d = distMm(neckAxis.points[0], neckAxis.points[1], ps, imageScale);
      lines.push(`M7. Femoral Neck Axis Length = ${d.toFixed(1)} mm`);
    }

    // M8: Horizontal Offset — perpendicular from femoral head midpoint to shaft midline
    let hOffsetGeom: { x: number; y: number; perp: { x: number; y: number } } | null = null;
    if (headDiameter && shaftMidline && headDiameter.points.length >= 2 && shaftMidline.points.length >= 2) {
      const headMid = midpoint(headDiameter.points[0], headDiameter.points[1]);
      const hOffset = perpDistMm(headMid, shaftMidline.points[0], shaftMidline.points[1], ps, imageScale);
      // Compute perpendicular foot point for visual overlay
      const sx = (imageScale?.x ?? 1) * ps.x;
      const sy = (imageScale?.y ?? 1) * ps.y;
      const sm0 = shaftMidline.points[0];
      const sm1 = shaftMidline.points[1];
      const dx = sm1.x - sm0.x;
      const dy = sm1.y - sm0.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = ((headMid.x - sm0.x) * dx + (headMid.y - sm0.y) * dy) / len2;
      const foot = { x: sm0.x + dx * t, y: sm0.y + dy * t };
      derivedGeom.push({ type: 'horizontal-offset', points: [headMid, foot] });
      lines.push(`M8. Horizontal Offset = ${hOffset.toFixed(1)} mm`);
    }

    // M9: Vertical Offset — perpendicular from femoral head midpoint to lesser trochanter guideline
    let vOffsetGeom: { x: number; y: number; perp: { x: number; y: number } } | null = null;
    if (headDiameter && ltGuideline && headDiameter.points.length >= 2 && ltGuideline.points.length >= 2) {
      const headMid = midpoint(headDiameter.points[0], headDiameter.points[1]);
      const vOffset = perpDistMm(headMid, ltGuideline.points[0], ltGuideline.points[1], ps, imageScale);
      // Compute foot point for visual overlay
      const lt0 = ltGuideline.points[0];
      const lt1 = ltGuideline.points[1];
      const dx = lt1.x - lt0.x;
      const dy = lt1.y - lt0.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = ((headMid.x - lt0.x) * dx + (headMid.y - lt0.y) * dy) / len2;
      const foot = { x: lt0.x + dx * t, y: lt0.y + dy * t };
      derivedGeom.push({ type: 'vertical-offset', points: [headMid, foot] });
      lines.push(`M9. Vertical Offset = ${vOffset.toFixed(1)} mm`);
    }

    // M10: Femur Neck Angle — angle between hip axis (projected) and femur shaft midline
    if (hipAxisLat && hipAxisMed && hipAxisLat.points.length >= 1 && hipAxisMed.points.length >= 1 && shaftMidline && shaftMidline.points.length >= 2 && midGuideline && midGuideline.points.length >= 2) {
      // Project both hip axis points onto the midpoint guideline
      const mg0 = midGuideline.points[0];
      const mg1 = midGuideline.points[1];
      const tLat = projectOntoLine(hipAxisLat.points[0], mg0, mg1);
      const tMed = projectOntoLine(hipAxisMed.points[0], mg0, mg1);
      const gdx = mg1.x - mg0.x;
      const gdy = mg1.y - mg0.y;
      const projLat = { x: mg0.x + gdx * tLat, y: mg0.y + gdy * tLat };
      const projMed = { x: mg0.x + gdx * tMed, y: mg0.y + gdy * tMed };

      // Angle between hip axis (projLat→projMed) and shaft midline (proximal→distal)
      const unsignedAngle = angleBetweenLinesDeg(projLat, projMed, shaftMidline.points[0], shaftMidline.points[1], ps, imageScale);
      const signedAngle = signedAngleDeg(projLat, projMed, shaftMidline.points[0], shaftMidline.points[1], ps, imageScale);
      lines.push(`M10. Femur Neck Angle = ${unsignedAngle.toFixed(1)}° (signed: ${signedAngle.toFixed(1)}°)`);
    } else if (hipAxis && hipAxis.points.length >= 2 && shaftMidline && shaftMidline.points.length >= 2) {
      // Fallback: old combined distance result
      const unsignedAngle = angleBetweenLinesDeg(hipAxis.points[0], hipAxis.points[1], shaftMidline.points[0], shaftMidline.points[1], ps, imageScale);
      const signedAngle = signedAngleDeg(hipAxis.points[0], hipAxis.points[1], shaftMidline.points[0], shaftMidline.points[1], ps, imageScale);
      lines.push(`M10. Femur Neck Angle = ${unsignedAngle.toFixed(1)}° (signed: ${signedAngle.toFixed(1)}°)`);
    }

    if (lines.length === 0) return null;

    return {
      value: 0, // composite — individual values in summary
      unit: '',
      summary: lines.join('\n'),
    };
  },
};
