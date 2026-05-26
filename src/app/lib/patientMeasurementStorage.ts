import type { Measurement, MeasurementTool } from '../components/MedicalImageViewer';

const MEASUREMENT_TOOLS = new Set<MeasurementTool>([
  'none',
  'distance',
  'angle',
  'ellipse',
  'closedCurve',
  'freehand',
  'pan',
  'line',
  'point',
]);

export const PATIENT_MEASUREMENTS_STORAGE_KEY = 'smartmritool-patient-measurements-v1';

export type PatientMeasurementArchive = Record<string, Measurement[]>;

const TSV_HEADER = [
  'patientKey',
  'patientId',
  'measurementId',
  'plane',
  'type',
  'value',
  'sliceIndex',
  'timestamp',
  'pointsJson',
] as const;

function normalizeMeasurement(raw: Partial<Measurement> & { id: string }): Measurement {
  return {
    id: raw.id,
    type: raw.type ?? 'distance',
    points: Array.isArray(raw.points) ? raw.points : [],
    slice: typeof raw.slice === 'number' ? raw.slice : 0,
    plane: (raw.plane as Measurement['plane']) ?? 'axial',
    patientId: raw.patientId,
    patientName: raw.patientName,
    studyName: raw.studyName,
    sequenceName: raw.sequenceName,
    laterality: raw.laterality,
    value: raw.value,
    baseLineId: raw.baseLineId,
    groupId: raw.groupId,
    label: raw.label,
    workflowStepId: raw.workflowStepId,
    propagateAcrossSlices: raw.propagateAcrossSlices,
    timestamp:
      typeof raw.timestamp === 'string' && raw.timestamp.length > 0 ? raw.timestamp : undefined,
  };
}

export function loadPatientMeasurementArchive(): PatientMeasurementArchive {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PATIENT_MEASUREMENTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PatientMeasurementArchive = {};
    for (const [patientKey, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      out[patientKey] = list.map((item) => normalizeMeasurement(item as Partial<Measurement> & { id: string }));
    }
    return out;
  } catch {
    return {};
  }
}

export function savePatientMeasurementArchive(archive: PatientMeasurementArchive): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PATIENT_MEASUREMENTS_STORAGE_KEY, JSON.stringify(archive));
  } catch (e) {
    console.error('Failed to persist patient measurements', e);
  }
}

function escapeTsvField(s: string): string {
  return s.replace(/\t/g, ' ').replace(/\r/g, '').replace(/\n/g, ' ');
}

/** Tab-separated values for spreadsheet paste (Excel / Sheets). */
export function exportArchiveToTsv(
  archive: PatientMeasurementArchive,
  patientLabels?: Record<string, { patientId?: string; patientName?: string }>,
): string {
  const lines: string[] = [TSV_HEADER.join('\t')];
  for (const [patientKey, measurements] of Object.entries(archive)) {
    const label = patientLabels?.[patientKey];
    const patientId = escapeTsvField(label?.patientId ?? '');
    for (const m of measurements) {
      const pointsJson = escapeTsvField(JSON.stringify(m.points ?? []));
      lines.push(
        [
          escapeTsvField(patientKey),
          patientId,
          escapeTsvField(m.id),
          escapeTsvField(m.plane),
          escapeTsvField(m.type),
          escapeTsvField(m.value ?? ''),
          String(m.slice),
          escapeTsvField(m.timestamp ?? ''),
          pointsJson,
        ].join('\t'),
      );
    }
  }
  return lines.join('\n');
}

export function exportPatientToTsv(
  patientKey: string,
  measurements: Measurement[],
  patientId?: string,
): string {
  const single: PatientMeasurementArchive = { [patientKey]: measurements };
  return exportArchiveToTsv(single, { [patientKey]: { patientId } });
}

export type MergeMeasurementsResult = {
  archive: PatientMeasurementArchive;
  errors: string[];
  importedCount: number;
};

/** Parse TSV from export or manual sheets; merges into existing archive by measurement id (replace) or append. */
export function mergeTsvIntoArchive(tsv: string, existing: PatientMeasurementArchive): MergeMeasurementsResult {
  const errors: string[] = [];
  const next: PatientMeasurementArchive = { ...existing };
  const lines = tsv
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    errors.push('No data rows found.');
    return { archive: next, errors, importedCount: 0 };
  }
  const headerCells = lines[0]!.split('\t').map((h) => h.trim());
  const idx = (name: string) => headerCells.indexOf(name);
  const ik = idx('patientKey');
  const iid = idx('measurementId');
  const iPlane = idx('plane');
  const iType = idx('type');
  const iVal = idx('value');
  const iSlice = idx('sliceIndex');
  const iTs = idx('timestamp');
  const iPts = idx('pointsJson');
  if (ik < 0 || iid < 0 || iPlane < 0 || iType < 0 || iSlice < 0) {
    errors.push('Missing required columns (need patientKey, measurementId, plane, type, sliceIndex).');
    return { archive: next, errors, importedCount: 0 };
  }
  let importedCount = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split('\t');
    const patientKey = cells[ik]?.trim();
    if (!patientKey) {
      errors.push(`Row ${r + 1}: missing patientKey`);
      continue;
    }
    try {
      const id = cells[iid]?.trim() ?? '';
      if (!id) {
        errors.push(`Row ${r + 1}: missing measurementId`);
        continue;
      }
      const planeRaw = cells[iPlane]?.trim();
      const plane: Measurement['plane'] =
        planeRaw === 'sagittal' || planeRaw === 'coronal' || planeRaw === 'axial' ? planeRaw : 'axial';
      const typeRaw = cells[iType]?.trim() ?? 'distance';
      const type: MeasurementTool = MEASUREMENT_TOOLS.has(typeRaw as MeasurementTool)
        ? (typeRaw as MeasurementTool)
        : 'distance';
      const value = iVal >= 0 ? cells[iVal] : undefined;
      const slice = Number.parseInt(cells[iSlice] ?? '', 10);
      const timestamp = iTs >= 0 ? (cells[iTs]?.trim() ?? new Date().toISOString()) : new Date().toISOString();
      let points: { x: number; y: number }[] = [];
      if (iPts >= 0 && cells[iPts]) {
        try {
          points = JSON.parse(cells[iPts]!) as { x: number; y: number }[];
          if (!Array.isArray(points)) points = [];
        } catch {
          errors.push(`Row ${r + 1}: invalid pointsJson`);
        }
      }
      const m = normalizeMeasurement({
        id,
        plane,
        type,
        value,
        slice: Number.isFinite(slice) ? slice : 0,
        timestamp,
        points,
      });
      const list = [...(next[patientKey] ?? [])];
      const existingIdx = list.findIndex((x) => x.id === m.id);
      if (existingIdx >= 0) list[existingIdx] = m;
      else list.push(m);
      next[patientKey] = list;
      importedCount += 1;
    } catch (e) {
      errors.push(`Row ${r + 1}: ${e instanceof Error ? e.message : 'parse error'}`);
    }
  }
  return { archive: next, errors, importedCount };
}

export function downloadTextFile(filename: string, text: string, mime = 'text/tab-separated-values;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
