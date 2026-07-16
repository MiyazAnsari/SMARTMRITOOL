// Hip X-ray DICOM Loader
// Loads individual CR (Computed Radiography) DICOM files where each file
// represents a single patient with one coronal AP Pelvis X-ray.
// @ts-ignore - dicom-parser ships its own .d.ts but JS module shape varies
import dicomParser from 'dicom-parser';
import type { DicomVolume, Plane } from '../dicom/DicomLoader';

export interface HipXrayImage {
  /** Unique patient key derived from PatientID */
  patientKey: string;
  patientId: string;
  patientName: string;
  studyInstanceUID: string;
  modality: string;
  fileName: string;
  /** 8-bit normalized pixel data: [slice][row][col] with slice=1 */
  imageData: Uint8Array;
  header: DicomVolume['header'];
  defaultWindowLevel: { window: number; level: number };
  pixelSpacing: { x: number; y: number };
  rows: number;
  cols: number;
  /** CSS→image-pixel scale factor for measurements */
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
}

const TAG = {
  rows: 'x00280010',
  cols: 'x00280011',
  bitsAllocated: 'x00280100',
  bitsStored: 'x00280101',
  highBit: 'x00280102',
  pixelRepresentation: 'x00280103',
  photometricInterpretation: 'x00280004',
  pixelData: 'x7fe00010',
  pixelSpacing: 'x00280030',
  rescaleSlope: 'x00281053',
  rescaleIntercept: 'x00281052',
  windowCenter: 'x00281050',
  windowWidth: 'x00281051',
  patientId: 'x00100020',
  patientName: 'x00100010',
  studyInstanceUID: 'x0020000d',
  seriesDescription: 'x0008103e',
  laterality: 'x00200060',
  modality: 'x00080060',
} as const;

function readFloatString(dataSet: any, t: string): number | undefined {
  const v = dataSet.string(t);
  if (v == null) return undefined;
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
 * Parse a single CR/DX DICOM file into a HipXrayImage.
 * Handles grayscale X-rays (MONOCHROME1/2, various bit depths).
 */
export function parseHipXrayDicom(buffer: ArrayBuffer, fileName: string): HipXrayImage | null {
  const byteArray = new Uint8Array(buffer);
  let dataSet: any;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (e) {
    console.warn('Skipping non-DICOM or unsupported file', fileName, e);
    return null;
  }

  const pixelDataElement = dataSet.elements[TAG.pixelData];
  if (!pixelDataElement) return null;

  const rows = dataSet.uint16(TAG.rows);
  const cols = dataSet.uint16(TAG.cols);
  if (!rows || !cols) return null;

  const bitsAllocated = dataSet.uint16(TAG.bitsAllocated) || 16;
  const pixelRepresentation = dataSet.uint16(TAG.pixelRepresentation) || 0;
  const photometric = dataSet.string(TAG.photometricInterpretation) || 'MONOCHROME2';

  const slope = readFloatString(dataSet, TAG.rescaleSlope) ?? 1;
  const intercept = readFloatString(dataSet, TAG.rescaleIntercept) ?? 0;
  let windowCenter = readFloatString(dataSet, TAG.windowCenter);
  let windowWidth = readFloatString(dataSet, TAG.windowWidth);
  const pixelSpacingArr = readFloatArray(dataSet, TAG.pixelSpacing) ?? [1, 1];

  const patientId = (dataSet.string(TAG.patientId) || '').trim() || fileName.replace(/\.dcm$/i, '');
  const patientName = (dataSet.string(TAG.patientName) || '').replace(/\^/g, ' ').trim();
  const studyInstanceUID = (dataSet.string(TAG.studyInstanceUID) || '').trim();
  const seriesDescription = (dataSet.string(TAG.seriesDescription) || '').trim();
  const modality = (dataSet.string(TAG.modality) || '').trim();

  if (modality && !['CR', 'DX', 'DR', 'XA'].includes(modality.toUpperCase())) {
    console.info(`[HipXray] Skipping non-radiograph modality ${modality} in ${fileName}`);
    return null;
  }

  const sliceSize = rows * cols;

  // Read raw pixel data
  const dataOffset = pixelDataElement.dataOffset;
  let raw: Int16Array | Uint16Array | Uint8Array;
  if (bitsAllocated === 8) {
    raw = pixelRepresentation === 1
      ? new Int8Array(buffer, dataOffset, sliceSize)
      : new Uint8Array(buffer, dataOffset, sliceSize);
  } else if (pixelRepresentation === 1) {
    raw = new Int16Array(buffer, dataOffset, sliceSize);
  } else {
    raw = new Uint16Array(buffer, dataOffset, sliceSize);
  }

  // Convert to Float32 with rescale
  const floatPixels = new Float32Array(sliceSize);
  const isMonochrome1 = photometric === 'MONOCHROME1';
  let dataMin = Infinity;
  let dataMax = -Infinity;

  for (let i = 0; i < sliceSize; i++) {
    let v = raw[i] * slope + intercept;
    if (isMonochrome1) v = -v;
    floatPixels[i] = v;
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }

  // Normalize to 0-255 for display
  const range = dataMax - dataMin || 1;
  const normalized = new Uint8Array(sliceSize);
  for (let i = 0; i < sliceSize; i++) {
    normalized[i] = Math.round(((floatPixels[i] - dataMin) / range) * 255);
  }

  // For MONOCHROME1, negate DICOM window center to match negated pixel data
  if (isMonochrome1 && windowCenter != null && Number.isFinite(windowCenter)) {
    windowCenter = -windowCenter;
  }
  // Default window/level for X-rays (wide window)
  if (!windowWidth || !Number.isFinite(windowWidth) || windowWidth <= 0) {
    windowWidth = range;
  }
  if (!windowCenter || !Number.isFinite(windowCenter)) {
    windowCenter = dataMin + range / 2;
  }

  // Map DICOM W/L to normalized 0-255 space
  const normWindow = ((windowWidth / range) * 255);
  const normLevel = (((windowCenter - dataMin) / range) * 255);

  // DICOM Pixel Spacing (0028,0030) = [row spacing (Y), column spacing (X)]
  const psY = pixelSpacingArr[0] ?? 0;
  const psX = pixelSpacingArr[1] ?? 0;
  if (!psX || !psY || psX > 50 || psY > 50) {
    console.warn(`[HipXray] Pixel Spacing implausible for ${patientId}: [${psX}, ${psY}] — using 1 mm/pixel fallback`);
  }

  const header: DicomVolume['header'] = {
    dims: [3, cols, rows, 1],
    pixDims: [0, psX || 1, psY || 1, 1],
    datatypeCode: 2,
    scl_slope: 1,
    scl_inter: 0,
  };

  return {
    patientKey: `hip-${patientId}`,
    patientId,
    patientName: patientName || patientId,
    studyInstanceUID,
    modality: modality || 'CR',
    fileName,
    imageData: normalized,
    header,
    defaultWindowLevel: {
      window: Math.max(1, Math.round(normWindow)),
      level: Math.round(normLevel),
    },
    pixelSpacing: { x: psX || 1, y: psY || 1 },
    rows,
    cols,
  };
}

/**
 * Load a folder of hip X-ray DICOMs. Each DICOM file is treated as a separate
 * patient. Returns an array of HipXrayImage, one per valid DICOM file.
 */
export async function loadHipXrayFolder(
  fileList: FileList | File[],
  onProgress?: (msg: string) => void,
  abortSignal?: AbortSignal,
): Promise<HipXrayImage[]> {
  const files = Array.from(fileList).filter(
    (f) => /\.dcm$/i.test(f.name) || f.name.toLowerCase().endsWith('.dicom'),
  );

  if (files.length === 0) {
    throw new Error('No DICOM files (.dcm) found in the selected folder.');
  }

  onProgress?.(`Loading ${files.length} hip X-ray file(s)...`);

  const results: HipXrayImage[] = [];
  for (let i = 0; i < files.length; i++) {
    if (abortSignal?.aborted) throw new DOMException('Loading cancelled', 'AbortError');
    const f = files[i];
    onProgress?.(`Parsing ${f.name} (${i + 1}/${files.length})...`);
    const buf = await f.arrayBuffer();
    const image = parseHipXrayDicom(buf, f.name);
    if (image) {
      results.push(image);
    }
  }

  onProgress?.(`Loaded ${results.length} hip X-ray patient(s).`);
  return results;
}
