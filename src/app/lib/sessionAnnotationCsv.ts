/** Viewport overlay shape derived from a session row (matches `Measurement` in the viewer). */
export type SessionMeasurementView = {
  id: string;
  type: string;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  patientId?: string;
  patientName?: string;
  studyName?: string;
  sequenceName?: string;
  laterality?: Laterality;
  value?: string;
  timestamp?: string;
  baseLineId?: string;
  groupId?: string;
  label?: string;
  workflowStepId?: string;
  propagateAcrossSlices?: boolean;
  /** CSS→image-pixel scale + offset so coordinates can be converted to native image px regardless of viewport size. */
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
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
  patientName?: string;
  studyName?: string;
  sequenceName: string;
  plane: 'axial' | 'sagittal' | 'coronal';
  measurementType: string;
  baseLineId?: string;
  groupId?: string;
  label?: string;
  workflowStepId?: string;
  value: string;
  units: string;
  sliceIndex: number;
  /** Whether the annotation should be shown across slices in the same plane. Default true. */
  propagateAcrossSlices?: boolean;
  /** CSS→image-pixel scale + offset so coordinates can be converted to native image px regardless of viewport size. */
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
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
    patientId: row.patientId,
    patientName: row.patientName,
    studyName: row.studyName,
    sequenceName: row.sequenceName,
    laterality: row.laterality,
    value: joinValueUnits(row.value, row.units),
    timestamp: row.timestamp,
    baseLineId: row.baseLineId,
    groupId: row.groupId,
    label: row.label,
    workflowStepId: row.workflowStepId,
    propagateAcrossSlices: row.propagateAcrossSlices ?? true,
    imageScale: row.imageScale,
  };
}

export function exportSessionAnnotationsToCsv(rows: SessionAnnotationRow[]): string {
  // Extended CSV suitable for ML: include flattened point columns and
  // baseline endpoints when present. We'll export up to 4 points per
  // measurement (p0..p3) and baseline endpoints (baseline_p0..p1). Also
  // include JSON columns for full points arrays.
  const EXTRA_COLUMNS = [
    'label',
    'workflowStepId',
    'groupId',
    'propagateAcrossSlices',
    'points_count',
    'p0_x',
    'p0_y',
    'p1_x',
    'p1_y',
    'p2_x',
    'p2_y',
    'p3_x',
    'p3_y',
    'baseline_p0_x',
    'baseline_p0_y',
    'baseline_p1_x',
    'baseline_p1_y',
    'points_json',
    'baseline_points_json',
  ];

  const header = [...CSV_COLUMNS, ...EXTRA_COLUMNS].join(',');

  // Build index map for quick baseline lookup
  const byId = new Map<string, SessionAnnotationRow>();
  for (const r of rows) byId.set(r.annotationId, r);

  const maxPoints = 4;

  const lines = rows.map((r) => {
    const baseline = r.baseLineId ? byId.get(r.baseLineId) : undefined;
    const points = Array.isArray(r.points) ? r.points.slice(0, maxPoints) : [];
    const baselinePoints = baseline && Array.isArray(baseline.points) ? baseline.points.slice(0, 2) : [];

    const flattenedPoints: (string | number)[] = [];
    for (let i = 0; i < maxPoints; i++) {
      const p = points[i];
      flattenedPoints.push(p ? String(p.x) : '');
      flattenedPoints.push(p ? String(p.y) : '');
    }

    const baselineFlatten = [
      baselinePoints[0] ? String(baselinePoints[0].x) : '',
      baselinePoints[0] ? String(baselinePoints[0].y) : '',
      baselinePoints[1] ? String(baselinePoints[1].x) : '',
      baselinePoints[1] ? String(baselinePoints[1].y) : '',
    ];

    const rowFields: (string | number)[] = [
      r.annotationId,
      r.patientId,
      r.laterality,
      r.sequenceName,
      r.plane,
      r.measurementType,
      r.value,
      r.units,
      String(r.sliceIndex),
      r.annotatedBy,
      r.annotatorEmail,
      r.timestamp,
    ];

    const extraFields: (string | number)[] = [
      r.label ?? '',
      r.workflowStepId ?? '',
      r.groupId ?? '',
      String(r.propagateAcrossSlices ?? true),
      String(r.points?.length ?? 0),
      ...flattenedPoints,
      ...baselineFlatten,
      JSON.stringify(r.points ?? []),
      JSON.stringify(baselinePoints ?? []),
    ];

    const escaped = [...rowFields, ...extraFields].map((f) => escapeCsvField(String(f ?? '')));
    return escaped.join(',');
  });

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
