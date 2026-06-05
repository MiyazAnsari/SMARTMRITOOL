/**
 * DICOM 3D affine transforms for cross-plane point mapping.
 *
 * Each DICOM series defines a mapping from voxel coordinates (row, col, slice)
 * to 3D patient coordinates (x, y, z in mm) via:
 *   [x,y,z] = IPP + row*dr*rowDir + col*dc*colDir + slice*ds*sliceDir
 *
 * The inverse uses the general 3×3 matrix inverse.  For orthonormal direction
 * vectors (rowDir ⟂ colDir ⟂ sliceDir, all unit length), M⁻¹ = Mᵀ after
 * dividing each row by its spacing.  For oblique acquisitions where sliceDir
 * (from IPP deltas) isn't orthogonal to the image plane, the full inverse
 * is required.
 */

// ── Debug toggle ──────────────────────────────────────────────────────────
const DEBUG_AFFINE = true;
function dbg(...args: any[]) { if (DEBUG_AFFINE) console.debug('[affine]', ...args); }

// ── Vector helpers ────────────────────────────────────────────────────────
function dot(a: number[], b: number[]): number {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}
function norm(v: number[]): number {
  return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
}

export interface DicomAffine {
  ipp: [number, number, number];
  rowDir: [number, number, number];
  colDir: [number, number, number];
  sliceDir: [number, number, number];
  dr: number;
  dc: number;
  ds: number;
}

// ── Extract affine from volume header ─────────────────────────────────────

export function getDicomAffine(header: {
  imageOrientationPatient?: [number, number, number, number, number, number];
  imagePositionPatient?: [number, number, number];
  sliceDirection?: [number, number, number];
  sliceSpacing?: number;
  pixDims?: number[] | [number, number, number, number];
  pixdim?: number[];
}): DicomAffine | null {
  const iop = header.imageOrientationPatient;
  const ipp = header.imagePositionPatient;
  if (!iop || iop.length !== 6 || !ipp || ipp.length !== 3) return null;

  const rowDir: [number, number, number] = [iop[0], iop[1], iop[2]];
  const colDir: [number, number, number] = [iop[3], iop[4], iop[5]];

  let sliceDir: [number, number, number];
  if (header.sliceDirection?.length === 3) {
    sliceDir = [header.sliceDirection[0], header.sliceDirection[1], header.sliceDirection[2]];
  } else {
    // Fallback: cross(row, col), normalized.
    const sx = rowDir[1]*colDir[2] - rowDir[2]*colDir[1];
    const sy = rowDir[2]*colDir[0] - rowDir[0]*colDir[2];
    const sz = rowDir[0]*colDir[1] - rowDir[1]*colDir[0];
    const n = Math.sqrt(sx*sx + sy*sy + sz*sz) || 1;
    sliceDir = [sx/n, sy/n, sz/n];
  }

  const pd = header.pixDims || header.pixdim || [1,1,1,1];
  const dr = Number.isFinite(pd[2]) && pd[2] > 0 ? pd[2] : 1;
  const dc = Number.isFinite(pd[1]) && pd[1] > 0 ? pd[1] : 1;
  const ds = Number.isFinite(header.sliceSpacing) && header.sliceSpacing! > 0
    ? header.sliceSpacing!
    : (Number.isFinite(pd[3]) && pd[3] > 0 ? pd[3] : 1);

  return { ipp: [ipp[0], ipp[1], ipp[2]], rowDir, colDir, sliceDir, dr, dc, ds };
}

// ── Validation ────────────────────────────────────────────────────────────

/** Check affine parameters for common issues. Returns array of warnings. */
export function validateAffine(a: DicomAffine, label: string): string[] {
  const w: string[] = [];

  const rn = norm(a.rowDir);
  const cn = norm(a.colDir);
  const sn = norm(a.sliceDir);
  if (Math.abs(rn - 1) > 0.01) w.push(`${label} rowDir norm=${rn.toFixed(4)} (not unit)`);
  if (Math.abs(cn - 1) > 0.01) w.push(`${label} colDir norm=${cn.toFixed(4)} (not unit)`);
  if (Math.abs(sn - 1) > 0.01) w.push(`${label} sliceDir norm=${sn.toFixed(4)} (not unit)`);

  const rcDot = dot(a.rowDir, a.colDir);
  const rsDot = dot(a.rowDir, a.sliceDir);
  const csDot = dot(a.colDir, a.sliceDir);
  if (Math.abs(rcDot) > 0.01) w.push(`${label} row·col=${rcDot.toFixed(4)} (not orthogonal)`);
  if (Math.abs(rsDot) > 0.01) w.push(`${label} row·slice=${rsDot.toFixed(4)} (not orthogonal) — IPP stacking is oblique`);
  if (Math.abs(csDot) > 0.01) w.push(`${label} col·slice=${csDot.toFixed(4)} (not orthogonal) — IPP stacking is oblique`);

  if (a.dr <= 0) w.push(`${label} dr=${a.dr} (non-positive)`);
  if (a.dc <= 0) w.push(`${label} dc=${a.dc} (non-positive)`);
  if (a.ds <= 0) w.push(`${label} ds=${a.ds} (non-positive)`);

  // Determinant check
  const m00=a.dr*a.rowDir[0], m01=a.dc*a.colDir[0], m02=a.ds*a.sliceDir[0];
  const m10=a.dr*a.rowDir[1], m11=a.dc*a.colDir[1], m12=a.ds*a.sliceDir[1];
  const m20=a.dr*a.rowDir[2], m21=a.dc*a.colDir[2], m22=a.ds*a.sliceDir[2];
  const det = m00*(m11*m22-m12*m21) - m01*(m10*m22-m12*m20) + m02*(m10*m21-m11*m20);
  if (Math.abs(det) < 1e-6) w.push(`${label} det=${det.toExponential(2)} (near-singular)`);

  dbg(`[validate] ${label}: norm r=${rn.toFixed(3)} c=${cn.toFixed(3)} s=${sn.toFixed(3)} | dot r·c=${rcDot.toFixed(4)} r·s=${rsDot.toFixed(4)} c·s=${csDot.toFixed(4)} | det=${det.toFixed(4)}`);

  return w;
}

// ── Round-trip test ──────────────────────────────────────────────────────

/** Test that patientToVoxel(voxelToPatient(v, A), A) ≈ v for sample points. */
export function roundTripTest(a: DicomAffine, label: string, dims: [number, number, number]): string[] {
  const errors: string[] = [];
  const testPoints: [number, number, number][] = [
    [0, 0, 0],
    [dims[0]/2, dims[1]/2, dims[2]/2],
    [dims[0]-1, dims[1]-1, dims[2]-1],
    [dims[0]/4, dims[1]/4, dims[2]/4],
  ];

  for (const v of testPoints) {
    const p = voxelToPatient(v, a);
    const v2 = patientToVoxel(p, a);
    const err = Math.abs(v[0]-v2[0]) + Math.abs(v[1]-v2[1]) + Math.abs(v[2]-v2[2]);
    if (err > 0.1) {
      errors.push(`${label} round-trip [${v.map(x=>x.toFixed(0)).join(',')}] → patient [${p.map(x=>x.toFixed(1)).join(',')}] → voxel [${v2.map(x=>x.toFixed(1)).join(',')}] err=${err.toFixed(2)}`);
      dbg(`[roundtrip FAIL] ${label}:`, { v, p, v2, err });
    } else {
      dbg(`[roundtrip OK] ${label}: [${v.map(x=>x.toFixed(0)).join(',')}] err=${err.toFixed(4)}`);
    }
  }

  return errors;
}

// ── Forward: voxel → patient ─────────────────────────────────────────────

export function voxelToPatient(
  voxel: [number, number, number],
  affine: DicomAffine,
): [number, number, number] {
  const [r, c, s] = voxel;
  return [
    affine.ipp[0] + r*affine.dr*affine.rowDir[0] + c*affine.dc*affine.colDir[0] + s*affine.ds*affine.sliceDir[0],
    affine.ipp[1] + r*affine.dr*affine.rowDir[1] + c*affine.dc*affine.colDir[1] + s*affine.ds*affine.sliceDir[1],
    affine.ipp[2] + r*affine.dr*affine.rowDir[2] + c*affine.dc*affine.colDir[2] + s*affine.ds*affine.sliceDir[2],
  ];
}

// ── Inverse: patient → voxel (general 3×3 inverse) ───────────────────────

export function patientToVoxel(
  patient: [number, number, number],
  affine: DicomAffine,
): [number, number, number] {
  const m00 = affine.dr*affine.rowDir[0], m01 = affine.dc*affine.colDir[0], m02 = affine.ds*affine.sliceDir[0];
  const m10 = affine.dr*affine.rowDir[1], m11 = affine.dc*affine.colDir[1], m12 = affine.ds*affine.sliceDir[1];
  const m20 = affine.dr*affine.rowDir[2], m21 = affine.dc*affine.colDir[2], m22 = affine.ds*affine.sliceDir[2];

  const det = m00*(m11*m22 - m12*m21) - m01*(m10*m22 - m12*m20) + m02*(m10*m21 - m11*m20);

  if (Math.abs(det) < 1e-10) {
    dbg('[patientToVoxel] near-zero determinant — returning [0,0,0]');
    return [0, 0, 0];
  }

  const invDet = 1 / det;
  const dx = patient[0] - affine.ipp[0];
  const dy = patient[1] - affine.ipp[1];
  const dz = patient[2] - affine.ipp[2];

  // Cofactor expansion for inverse
  const n00 = (m11*m22 - m12*m21) * invDet;
  const n01 = (m02*m21 - m01*m22) * invDet;
  const n02 = (m01*m12 - m02*m11) * invDet;
  const n10 = (m12*m20 - m10*m22) * invDet;
  const n11 = (m00*m22 - m02*m20) * invDet;
  const n12 = (m02*m10 - m00*m12) * invDet;
  const n20 = (m10*m21 - m11*m20) * invDet;
  const n21 = (m01*m20 - m00*m21) * invDet;
  const n22 = (m00*m11 - m01*m10) * invDet;

  const row = n00*dx + n01*dy + n02*dz;
  const col = n10*dx + n11*dy + n12*dz;
  const slice = n20*dx + n21*dy + n22*dz;

  dbg(`[patientToVoxel] det=${det.toFixed(4)} | dXYZ=[${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)}] | voxel=[${row.toFixed(1)},${col.toFixed(1)},${slice.toFixed(1)}]`);

  return [row, col, slice];
}

// ── Cross-plane mapping ──────────────────────────────────────────────────

export function mapPoint3D(
  srcImageX: number,
  srcImageY: number,
  srcSlice: number,
  srcAffine: DicomAffine,
  dstAffine: DicomAffine,
): { x: number; y: number; slice: number } | null {
  const srcVoxel: [number, number, number] = [srcImageY, srcImageX, srcSlice];
  dbg(`[mapPoint3D] srcVoxel=[row=${srcImageY.toFixed(1)}, col=${srcImageX.toFixed(1)}, slice=${srcSlice.toFixed(1)}]`);

  const patient = voxelToPatient(srcVoxel, srcAffine);
  dbg(`[mapPoint3D] patient=[${patient.map(v=>v.toFixed(1)).join(', ')}]`);

  const dstVoxel = patientToVoxel(patient, dstAffine);

  return {
    x: dstVoxel[1],
    y: dstVoxel[0],
    slice: dstVoxel[2],
  };
}
