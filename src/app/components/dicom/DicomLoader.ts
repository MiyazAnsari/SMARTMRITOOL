// @ts-ignore - dicom-parser ships its own .d.ts but JS module shape varies
import dicomParser from 'dicom-parser';
import { lateralityFromDicomTag, type Laterality } from './laterality';

export type Plane = 'axial' | 'sagittal' | 'coronal';

export interface DicomVolume {
  /** 8-bit normalised pixel data laid out as [slice][row][col] */
  imageData: Uint8Array;
  /** NIfTI-compatible header so the existing Viewport can render it unchanged */
  header: {
    dims: [number, number, number, number]; // [3, cols, rows, slices]
    pixDims: [number, number, number, number]; // [_, dx, dy, dz]
    datatypeCode: 2; // uint8 after normalization
    scl_slope: 1;
    scl_inter: 0;
    /** DICOM spatial registration (optional, for 3D cross-plane mapping). */
    imageOrientationPatient?: [number, number, number, number, number, number];
    /** IPP of the first slice (top-left voxel, patient mm). */
    imagePositionPatient?: [number, number, number];
    /** Normal vector to the slice plane = cross(rowDir, colDir). */
    sliceDirection?: [number, number, number];
    /** Through-plane spacing between consecutive slices (mm). */
    sliceSpacing?: number;
  };
  dataRange: { min: number; max: number };
  defaultWindowLevel: { window: number; level: number };
  plane: Plane;
  laterality: Laterality;
  seriesDescription: string;
  patientId: string;
  patientName: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sliceCount: number;
  origin: 'dicom';
}

interface ParsedSlice {
  pixels: Float32Array;
  rows: number;
  cols: number;
  instanceNumber: number;
  sliceLocation: number;
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  pixelSpacing: [number, number];
  sliceThickness: number;
  windowCenter?: number;
  windowWidth?: number;
  seriesDescription: string;
  laterality?: string;
  patientId: string;
  patientName: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
}

const tag = {
  rows: 'x00280010',
  cols: 'x00280011',
  bitsAllocated: 'x00280100',
  bitsStored: 'x00280101',
  highBit: 'x00280102',
  pixelRepresentation: 'x00280103',
  photometricInterpretation: 'x00280004',
  pixelData: 'x7fe00010',
  numberOfFrames: 'x00280008',
  pixelSpacing: 'x00280030',
  sliceThickness: 'x00180050',
  rescaleSlope: 'x00281053',
  rescaleIntercept: 'x00281052',
  windowCenter: 'x00281050',
  windowWidth: 'x00281051',
  instanceNumber: 'x00200013',
  sliceLocation: 'x00201041',
  imagePositionPatient: 'x00200032',
  imageOrientationPatient: 'x00200037',
  seriesDescription: 'x0008103e',
  laterality: 'x00200060',
  patientId: 'x00100020',
  patientName: 'x00100010',
  studyInstanceUID: 'x0020000d',
  seriesInstanceUID: 'x0020000e',
} as const;

function readFloatString(dataSet: any, t: string): number | undefined {
  const v = dataSet.string(t);
  if (v == null) return undefined;
  // multi-valued strings are backslash-separated; take the first
  const first = v.split('\\')[0];
  const f = parseFloat(first);
  return Number.isFinite(f) ? f : undefined;
}

function readFloatArray(dataSet: any, t: string): number[] | undefined {
  const v = dataSet.string(t);
  if (v == null) return undefined;
  const parts = v.split('\\').map(parseFloat);
  return parts.every(Number.isFinite) ? parts : undefined;
}

/**
 * Parse a single DICOM file's pixel data into a Float32Array of HU/intensity values
 * (rescale slope/intercept already applied). Signed/unsigned and bit depth are
 * handled. Multi-frame files are flattened in instance order.
 */
function parseDicomFile(buffer: ArrayBuffer): ParsedSlice | null {
  const byteArray = new Uint8Array(buffer);
  let dataSet: any;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (e) {
    console.info('Skipping non-DICOM or unsupported DICOM file', e);
    return null;
  }

  const pixelDataElement = dataSet.elements[tag.pixelData];
  if (!pixelDataElement) return null;

  const rows = dataSet.uint16(tag.rows);
  const cols = dataSet.uint16(tag.cols);
  if (!rows || !cols) return null;

  const bitsAllocated = dataSet.uint16(tag.bitsAllocated) || 16;
  const pixelRepresentation = dataSet.uint16(tag.pixelRepresentation) || 0; // 0 = unsigned, 1 = signed
  const photometric = dataSet.string(tag.photometricInterpretation) || 'MONOCHROME2';

  const slope = readFloatString(dataSet, tag.rescaleSlope) ?? 1;
  const intercept = readFloatString(dataSet, tag.rescaleIntercept) ?? 0;
  const windowCenter = readFloatString(dataSet, tag.windowCenter);
  const windowWidth = readFloatString(dataSet, tag.windowWidth);
  const pixelSpacingArr = readFloatArray(dataSet, tag.pixelSpacing) ?? [1, 1];
  const sliceThickness = readFloatString(dataSet, tag.sliceThickness) ?? 1;

  // Audit: warn if pixel spacing is missing or implausible so users know
  // whether mm measurements can be trusted.
  const psX = pixelSpacingArr[0] ?? 0;
  const psY = pixelSpacingArr[1] ?? 0;
  const psMissing = !readFloatArray(dataSet, tag.pixelSpacing);
  const psSuspicious =
    !psMissing &&
    (psX <= 0 || psY <= 0 || psX > 50 || psY > 50 || psX * psY < 1e-6);
  const psFallback = psMissing || psSuspicious;
  if (psMissing) {
    console.warn(
      '[DICOM] Pixel Spacing (0028,0030) is missing — measurements will use 1 mm/pixel (unreliable for clinical use).',
    );
  } else if (psSuspicious) {
    console.warn(
      `[DICOM] Pixel Spacing (0028,0030) is implausible ([${psX.toFixed(3)}, ${psY.toFixed(3)}] mm) — measurements may be inaccurate.`,
    );
  } else {
    console.log(
      `[DICOM] Pixel Spacing: [${psX.toFixed(3)}, ${psY.toFixed(3)}] mm — measurements should be reliable.`,
    );
  }
  const instanceNumber = parseInt(dataSet.string(tag.instanceNumber) || '0', 10) || 0;
  const sliceLocation = readFloatString(dataSet, tag.sliceLocation) ?? instanceNumber;
  const imagePositionPatient = readFloatArray(dataSet, tag.imagePositionPatient) as
    | [number, number, number]
    | undefined;
  const imageOrientationPatient = readFloatArray(dataSet, tag.imageOrientationPatient) as
    | [number, number, number, number, number, number]
    | undefined;
  const seriesDescription = dataSet.string(tag.seriesDescription) || '';
  const laterality = dataSet.string(tag.laterality) || undefined;
  const patientId = (dataSet.string(tag.patientId) || '').trim();
  const patientName = (dataSet.string(tag.patientName) || '').replace(/\^/g, ' ').trim();
  const studyInstanceUID = (dataSet.string(tag.studyInstanceUID) || '').trim();
  const seriesInstanceUID = (dataSet.string(tag.seriesInstanceUID) || '').trim();

  const numFrames = parseInt(dataSet.string(tag.numberOfFrames) || '1', 10) || 1;
  const sliceSize = rows * cols;
  const totalSamples = sliceSize * numFrames;

  // Build a typed view onto the raw pixel data
  const dataOffset = pixelDataElement.dataOffset;
  let raw: Int16Array | Uint16Array | Uint8Array;
  if (bitsAllocated === 8) {
    raw = new Uint8Array(buffer, dataOffset, totalSamples);
  } else if (pixelRepresentation === 1) {
    raw = new Int16Array(buffer, dataOffset, totalSamples);
  } else {
    raw = new Uint16Array(buffer, dataOffset, totalSamples);
  }

  const out = new Float32Array(totalSamples);
  const isMonochrome1 = photometric === 'MONOCHROME1';
  for (let i = 0; i < totalSamples; i++) {
    let v = raw[i] * slope + intercept;
    if (isMonochrome1) v = -v; // invert: high values are dark in MONOCHROME1
    out[i] = v;
  }

  return {
    pixels: out,
    rows,
    cols,
    instanceNumber,
    sliceLocation,
    imagePositionPatient,
    imageOrientationPatient,
    pixelSpacing: [pixelSpacingArr[0] || 1, pixelSpacingArr[1] || pixelSpacingArr[0] || 1],
    sliceThickness,
    windowCenter,
    windowWidth,
    seriesDescription,
    laterality,
    patientId,
    patientName,
    studyInstanceUID,
    seriesInstanceUID,
  };
}

/**
 * Decide plane using DICOM metadata first (most reliable), then
 * SeriesDescription text, with folder-name hints as the last resort.
 */
function detectPlane(slice: ParsedSlice, hint?: string): Plane {
  // 1. ImageOrientationPatient — authoritative DICOM geometry
  const iop = slice.imageOrientationPatient;
  if (iop && iop.length === 6) {
    const r = [iop[0], iop[1], iop[2]];
    const c = [iop[3], iop[4], iop[5]];
    const n = [
      r[1] * c[2] - r[2] * c[1],
      r[2] * c[0] - r[0] * c[2],
      r[0] * c[1] - r[1] * c[0],
    ];
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    if (az >= ax && az >= ay) return 'axial';
    if (ax >= ay && ax >= az) return 'sagittal';
    return 'coronal';
  }

  // 2. SeriesDescription text (often contains "axial", "sagittal", "coronal")
  const desc = (slice.seriesDescription || '').toLowerCase();
  if (/\bsag(?:ittal)?\b/.test(desc)) return 'sagittal';
  if (/\bcor(?:onal)?\b/.test(desc)) return 'coronal';
  if (/\bax(?:ial)?\b|\btra(?:nsverse)?\b/.test(desc)) return 'axial';

  // 3. Folder-name hint (lowest priority — only when DICOM metadata is absent)
  if (hint) {
    const h = hint.toLowerCase();
    if (/sag|sagittal|s_dicom\b|^s\b/.test(h)) return 'sagittal';
    if (/cor|coronal|c_dicom\b|^c\b/.test(h)) return 'coronal';
    if (/ax|axial|tra|transverse|a_dicom\b|^a\b/.test(h)) return 'axial';
  }

  return 'axial';
}

/**
 * Build a 3D volume from a list of DICOM file ArrayBuffers (one per slice, or a
 * single multi-frame file). Files don't need to be pre-sorted — we sort by
 * ImagePositionPatient (along the slice normal) when available, falling back to
 * SliceLocation, then InstanceNumber.
 */
export async function loadDicomSeries(
  files: { name: string; buffer: ArrayBuffer }[],
  hint?: string,
  laterality: Laterality = 'left',
): Promise<DicomVolume | null> {
  if (!files.length) return null;

  const parsed: ParsedSlice[] = [];
  for (const f of files) {
    const p = parseDicomFile(f.buffer);
    if (p) parsed.push(p);
  }
  if (!parsed.length) return null;

  // All slices in a series should share rows/cols — drop oddballs
  const baseRows = parsed[0].rows;
  const baseCols = parsed[0].cols;
  const consistent = parsed.filter((s) => s.rows === baseRows && s.cols === baseCols);
  if (!consistent.length) return null;

  const plane = detectPlane(consistent[0], hint);
  const dicomLaterality = lateralityFromDicomTag(consistent[0].laterality);

  // Sort along the volume axis. For DICOM, the slice normal direction is most
  // reliable; otherwise SliceLocation; otherwise InstanceNumber.
  const iop = consistent[0].imageOrientationPatient;
  let sortKey: (s: ParsedSlice) => number;
  if (iop && iop.length === 6) {
    const r = [iop[0], iop[1], iop[2]];
    const c = [iop[3], iop[4], iop[5]];
    const n = [
      r[1] * c[2] - r[2] * c[1],
      r[2] * c[0] - r[0] * c[2],
      r[0] * c[1] - r[1] * c[0],
    ];
    sortKey = (s) => {
      const p = s.imagePositionPatient ?? [0, 0, s.sliceLocation];
      return p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    };
  } else {
    sortKey = (s) => s.sliceLocation || s.instanceNumber;
  }
  consistent.sort((a, b) => sortKey(a) - sortKey(b));

  const sliceCount = consistent.length;
  const cols = baseCols;
  const rows = baseRows;
  const sliceSize = rows * cols;

  // Flatten everything to a single Float32Array first to compute global min/max
  const flat = new Float32Array(sliceCount * sliceSize);
  let min = Infinity;
  let max = -Infinity;
  for (let s = 0; s < sliceCount; s++) {
    const src = consistent[s].pixels;
    flat.set(src.subarray(0, sliceSize), s * sliceSize);
    for (let i = 0; i < sliceSize; i++) {
      const v = src[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    min = 0;
    max = Math.max(1, max);
  }

  // Normalise to 0-255 so the existing Viewport pipeline (which expects uint8)
  // works without any modification.
  const range = max - min;
  const imageData = new Uint8Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    imageData[i] = Math.max(0, Math.min(255, Math.round(((flat[i] - min) / range) * 255)));
  }

  // Default window/level: prefer DICOM-supplied values, scaled into the 0-255 space
  const wc = consistent[0].windowCenter;
  const ww = consistent[0].windowWidth;
  let defaultWindow = 255;
  let defaultLevel = 128;
  if (wc != null && ww != null && ww > 0) {
    const scaledLevel = ((wc - min) / range) * 255;
    const scaledWindow = (ww / range) * 255;
    defaultLevel = Math.round(Math.max(0, Math.min(255, scaledLevel)));
    defaultWindow = Math.round(Math.max(1, Math.min(255, scaledWindow)));
  }

  const dx = consistent[0].pixelSpacing[1];
  const dy = consistent[0].pixelSpacing[0];
  const dz = consistent[0].sliceThickness;

  // DICOM spatial registration: preserve orientation + position for 3D mapping.
  const ipp0 = consistent[0].imagePositionPatient;
  let sliceDir: [number, number, number] | undefined;
  let sliceSpacing: number | undefined;

  // Primary: use SliceThickness from DICOM header (reliable, typically 0.5-5mm).
  // Secondary: try IPP deltas but validate they're within 2× of SliceThickness
  // (sorted slices may not be physically adjacent, producing absurd spacings).
  const nominalDS = dz; // SliceThickness from DICOM
  let ippDeltaOk = false;
  if (consistent.length >= 2 && consistent[0].imagePositionPatient && consistent[1].imagePositionPatient) {
    const a = consistent[0].imagePositionPatient;
    const b = consistent[1].imagePositionPatient;
    const ddx = a[0] - b[0], ddy = a[1] - b[1], ddz = a[2] - b[2];
    const d = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
    // Only trust IPP delta if it's within 2× of nominal slice thickness.
    if (d > 0 && nominalDS > 0 && d <= nominalDS * 2.5) {
      sliceSpacing = d;
      sliceDir = [ddx/d, ddy/d, ddz/d];
      ippDeltaOk = true;
    }
  }
  if (!ippDeltaOk) {
    // Fallback: use nominal SliceThickness for spacing, cross product for direction.
    sliceSpacing = nominalDS > 0 ? nominalDS : 1;
    if (iop && iop.length === 6) {
      const rowDir = [iop[0], iop[1], iop[2]] as [number, number, number];
      const colDir = [iop[3], iop[4], iop[5]] as [number, number, number];
      const sx = rowDir[1]*colDir[2] - rowDir[2]*colDir[1];
      const sy = rowDir[2]*colDir[0] - rowDir[0]*colDir[2];
      const sz = rowDir[0]*colDir[1] - rowDir[1]*colDir[0];
      const n = Math.sqrt(sx*sx + sy*sy + sz*sz) || 1;
      sliceDir = [sx/n, sy/n, sz/n];
    }
  }

  return {
    imageData,
    header: {
      dims: [3, cols, rows, sliceCount],
      pixDims: [1, dx, dy, dz],
      datatypeCode: 2,
      scl_slope: 1,
      scl_inter: 0,
      imageOrientationPatient: iop?.length === 6 ? (iop as [number,number,number,number,number,number]) : undefined,
      imagePositionPatient: ipp0?.length === 3 ? (ipp0 as [number,number,number]) : undefined,
      sliceDirection: sliceDir,
      sliceSpacing,
    },
    dataRange: { min, max },
    defaultWindowLevel: { window: defaultWindow, level: defaultLevel },
    plane,
    laterality: laterality ?? dicomLaterality ?? 'left',
    seriesDescription: consistent[0].seriesDescription || hint || plane,
    patientId: consistent[0].patientId || 'unknown-patient',
    patientName: consistent[0].patientName || 'Unknown Patient',
    studyInstanceUID: consistent[0].studyInstanceUID || '',
    seriesInstanceUID: consistent[0].seriesInstanceUID || '',
    sliceCount,
    origin: 'dicom',
  };
}

/**
 * Group a flat list of files by their immediate parent directory (using
 * webkitRelativePath). Used to split a study folder containing A_DICOM,
 * S_DICOM, C_DICOM into separate series.
 */
export function groupFilesByDirectory(files: File[]): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const f of files) {
    const rel = (f as any).webkitRelativePath || f.name;
    const parts = rel.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const arr = groups.get(dir) || [];
    arr.push(f);
    groups.set(dir, arr);
  }
  return groups;
}

/** Read DICOM Laterality (0020,0060) from a single file without building a volume. */
export function readLateralityFromDicomBuffer(buffer: ArrayBuffer): Laterality | null {
  const slice = parseDicomFile(buffer);
  return lateralityFromDicomTag(slice?.laterality);
}

/** Heuristic: only DICOM-looking files (no obvious extensions like .json/.txt). */
export function isProbablyDicom(name: string | undefined | null): boolean {
  if (!name || typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.dcm') || lower.endsWith('.ima')) return true;
  // Many DICOM exports have no extension at all (just numeric names like 0001)
  if (!/\.[a-z0-9]{1,5}$/.test(lower)) return true;
  return false;
}
