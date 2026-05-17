/** Viewport overlay shape derived from a session row (matches `Measurement` in the viewer). */
export type SessionMeasurementView = {
  id: string;
  type: string;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  value?: string;
  timestamp?: string;
};

/** In-memory row: CSV-exportable fields plus geometry for viewport overlays (not CSV columns). */
export interface SessionAnnotator {
  name: string;
  email: string;
}

export type Laterality = 'left' | 'right';

export interface SessionAnnotationRow {
  /** Internal: which loaded study key this row belongs to (not exported). */
  sourcePatientKey: string;
  laterality: Laterality;
  annotationId: string;
  patientId: string;
  sequenceName: string;
  plane: 'axial' | 'sagittal' | 'coronal';
  measurementType: string;
  value: string;
  units: string;
  sliceIndex: number;
  annotatedBy: string;
  annotatorEmail: string;
  timestamp: string;
  points: { x: number; y: number }[];
}

const CSV_COLUMNS = [
  'annotationId',
  'patientId',
  'laterality',
  'sequenceName',
  'plane',
  'measurementType',
  'value',
  'units',
  'sliceIndex',
  'annotatedBy',
  'annotatorEmail',
  'timestamp',
] as const;

function escapeCsvField(s: string): string {
  const needsQuote = /[",\r\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function splitValueUnits(raw?: string): { value: string; units: string } {
  if (raw == null || raw === '') return { value: '', units: '' };
  const m = String(raw).trim().match(/^(.+?)\s+([a-zA-Z°²]+)\s*$/);
  if (m) return { value: m[1]!.trim(), units: m[2]! };
  return { value: String(raw).trim(), units: '' };
}

export function joinValueUnits(value: string, units: string): string | undefined {
  if (!value && !units) return undefined;
  if (!units) return value || undefined;
  if (!value) return units;
  return `${value} ${units}`;
}

export function sessionRowToMeasurement(row: SessionAnnotationRow): SessionMeasurementView {
  return {
    id: row.annotationId,
    type: row.measurementType,
    points: Array.isArray(row.points) ? row.points.map((p) => ({ x: p.x, y: p.y })) : [],
    slice: row.sliceIndex,
    plane: row.plane,
    value: joinValueUnits(row.value, row.units),
    timestamp: row.timestamp,
  };
}

export function exportSessionAnnotationsToCsv(rows: SessionAnnotationRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((r) =>
    [
      escapeCsvField(r.annotationId),
      escapeCsvField(r.patientId),
      escapeCsvField(r.sequenceName),
      escapeCsvField(r.plane),
      escapeCsvField(r.measurementType),
      escapeCsvField(r.value),
      escapeCsvField(r.units),
      String(r.sliceIndex),
      escapeCsvField(r.annotatedBy),
      escapeCsvField(r.annotatorEmail),
      escapeCsvField(r.timestamp),
    ].join(','),
  );
  return [header, ...lines].join('\r\n');
}

export function downloadCsvFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function isPlausibleEmail(email: string): boolean {
  const t = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}
