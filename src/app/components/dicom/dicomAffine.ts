/**
 * DICOM 3D affine transforms for cross-plane point mapping.
 *
 * Each DICOM series defines a mapping from voxel coordinates (row, col, slice)
 * to 3D patient coordinates (x, y, z in mm) via:
 *   [x,y,z] = IPP + row*dr*rowDir + col*dc*colDir + slice*ds*sliceDir
 */

export interface DicomAffine {
  /** ImagePositionPatient of first slice (mm). */
  ipp: [number, number, number];
  /** Row direction cosines (3 values). */
  rowDir: [number, number, number];
  /** Column direction cosines (3 values). */
  colDir: [number, number, number];
  /** Slice (through-plane) direction cosines (3 values). */
  sliceDir: [number, number, number];
  /** Row spacing (mm). */
  dr: number;
  /** Column spacing (mm). */
  dc: number;
  /** Slice spacing (mm). */
  ds: number;
}

/** Extract the affine from a DicomVolume-like header. */
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

  // Slice direction = cross(rowDir, colDir), normalized.
  let sliceDir: [number, number, number];
  if (header.sliceDirection?.length === 3) {
    sliceDir = [header.sliceDirection[0], header.sliceDirection[1], header.sliceDirection[2]];
  } else {
    const sx = rowDir[1] * colDir[2] - rowDir[2] * colDir[1];
    const sy = rowDir[2] * colDir[0] - rowDir[0] * colDir[2];
    const sz = rowDir[0] * colDir[1] - rowDir[1] * colDir[0];
    const n = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    sliceDir = [sx / n, sy / n, sz / n];
  }

  const pd = header.pixDims || header.pixdim || [1, 1, 1, 1];
  const dr = Number.isFinite(pd[2]) && pd[2] > 0 ? pd[2] : 1; // row spacing
  const dc = Number.isFinite(pd[1]) && pd[1] > 0 ? pd[1] : 1; // col spacing
  const ds = Number.isFinite(header.sliceSpacing) && header.sliceSpacing! > 0
    ? header.sliceSpacing!
    : (Number.isFinite(pd[3]) && pd[3] > 0 ? pd[3] : 1);

  return { ipp: [ipp[0], ipp[1], ipp[2]], rowDir, colDir, sliceDir, dr, dc, ds };
}

/**
 * Convert a voxel coordinate [row, col, slice] to 3D patient mm.
 * Row = image Y, col = image X, slice = through-plane index.
 */
export function voxelToPatient(
  voxel: [number, number, number],
  affine: DicomAffine,
): [number, number, number] {
  const [r, c, s] = voxel;
  return [
    affine.ipp[0] + r * affine.dr * affine.rowDir[0] + c * affine.dc * affine.colDir[0] + s * affine.ds * affine.sliceDir[0],
    affine.ipp[1] + r * affine.dr * affine.rowDir[1] + c * affine.dc * affine.colDir[1] + s * affine.ds * affine.sliceDir[1],
    affine.ipp[2] + r * affine.dr * affine.rowDir[2] + c * affine.dc * affine.colDir[2] + s * affine.ds * affine.sliceDir[2],
  ];
}

/**
 * Invert the affine to map patient mm → voxel coordinate [row, col, slice].
 * Uses the pseudo-inverse of the 3×3 direction*spacing matrix.
 */
export function patientToVoxel(
  patient: [number, number, number],
  affine: DicomAffine,
): [number, number, number] {
  // Build the 3×3 matrix M where M * [r,c,s]^T + IPP = patient
  // So M * [r,c,s]^T = patient - IPP
  // [r,c,s]^T = M^-1 * (patient - IPP)
  const m00 = affine.dr * affine.rowDir[0];
  const m01 = affine.dc * affine.colDir[0];
  const m02 = affine.ds * affine.sliceDir[0];
  const m10 = affine.dr * affine.rowDir[1];
  const m11 = affine.dc * affine.colDir[1];
  const m12 = affine.ds * affine.sliceDir[1];
  const m20 = affine.dr * affine.rowDir[2];
  const m21 = affine.dc * affine.colDir[2];
  const m22 = affine.ds * affine.sliceDir[2];

  // Determinant of 3×3 matrix
  const det =
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20);

  if (Math.abs(det) < 1e-10) return [0, 0, 0]; // degenerate

  const invDet = 1 / det;
  const dx = patient[0] - affine.ipp[0];
  const dy = patient[1] - affine.ipp[1];
  const dz = patient[2] - affine.ipp[2];

  // Inverse matrix
  const n00 = (m11 * m22 - m12 * m21) * invDet;
  const n01 = (m02 * m21 - m01 * m22) * invDet;
  const n02 = (m01 * m12 - m02 * m11) * invDet;
  const n10 = (m12 * m20 - m10 * m22) * invDet;
  const n11 = (m00 * m22 - m02 * m20) * invDet;
  const n12 = (m02 * m10 - m00 * m12) * invDet;
  const n20 = (m10 * m21 - m11 * m20) * invDet;
  const n21 = (m01 * m20 - m00 * m21) * invDet;
  const n22 = (m00 * m11 - m01 * m10) * invDet;

  return [
    n00 * dx + n01 * dy + n02 * dz,  // row
    n10 * dx + n11 * dy + n12 * dz,  // col
    n20 * dx + n21 * dy + n22 * dz,  // slice
  ];
}

/**
 * Map a point from one plane's image coordinates to another plane's
 * image coordinates using 3D patient space.
 *
 * @param srcImageY - Y position in the source image (pixels, 0=top)
 * @param srcImageX - X position in the source image (pixels, 0=left)
 * @param srcSlice - slice index in the source volume
 * @param srcAffine - affine of the source series
 * @param dstAffine - affine of the destination series
 * @param dstDims - [cols, rows, slices] of the destination volume
 * @returns [dstImageX, dstImageY, dstSlice] in destination image coordinates
 */
export function mapPoint3D(
  srcImageX: number,
  srcImageY: number,
  srcSlice: number,
  srcAffine: DicomAffine,
  dstAffine: DicomAffine,
): { x: number; y: number; slice: number } | null {
  // Source: image (row=y, col=x) → voxel (row, col, slice)
  const srcVoxel: [number, number, number] = [srcImageY, srcImageX, srcSlice];
  const patient = voxelToPatient(srcVoxel, srcAffine);
  const dstVoxel = patientToVoxel(patient, dstAffine);

  return {
    x: dstVoxel[1],  // column
    y: dstVoxel[0],  // row
    slice: dstVoxel[2],
  };
}
