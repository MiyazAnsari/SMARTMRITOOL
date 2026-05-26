import type { DicomStudyView } from '@/app/components/dicom/patientStudy';
import type { Plane } from '@/app/components/dicom/DicomLoader';
import {
  MEASUREMENT_PROTOCOLS,
  type MeasurementProtocol,
  type StepResult,
  getProtocol,
} from '@/app/components/measurement/MeasurementProtocols';

export type ProtocolExportMeasurement = {
  id: string;
  type: string;
  points: { x: number; y: number }[];
  slice: number;
  plane: Plane;
  value?: string;
  baseLineId?: string;
  groupId?: string;
  label?: string;
  workflowStepId?: string;
  propagateAcrossSlices?: boolean;
};

type CsvValue = string | number | boolean | null | undefined;

type ProtocolExportContext = {
  study?: DicomStudyView | null;
  patientId?: string;
  patientName?: string;
  studyName?: string;
  laterality?: string;
};

const CSV_COLUMNS = [
  'recordType',
  'patientId',
  'patientName',
  'studyName',
  'laterality',
  'sequenceName',
  'plane',
  'protocolId',
  'protocolLabel',
  'groupId',
  'measurementId',
  'stepId',
  'stepLabel',
  'primitive',
  'measurementType',
  'sliceIndex',
  'pointCount',
  'resultValue',
  'resultUnit',
  'resultSummary',
  'interpretation',
  'measurementLabel',
  'measurementValue',
  'measurementUnit',
  'measurementPropagateAcrossSlices',
  'p0_x',
  'p0_y',
  'p1_x',
  'p1_y',
  'p2_x',
  'p2_y',
  'p3_x',
  'p3_y',
  'stepPointsMmJson',
  'baselineId',
  'baseline_p0_x',
  'baseline_p0_y',
  'baseline_p1_x',
  'baseline_p1_y',
  'baselinePointsMmJson',
  'pointsJson',
  'baselinePointsJson',
  'stepMeasurementIdsJson',
] as const;

function escapeCsvField(value: CsvValue): string {
  const text = String(value ?? '');
  const needsQuote = /[",\r\n]/.test(text);
  const escaped = text.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

function findProtocolIdFromGroupId(groupId: string | undefined): string | null {
  if (!groupId) return null;
  const match = MEASUREMENT_PROTOCOLS.find((protocol) => groupId === protocol.id || groupId.startsWith(`${protocol.id}-`));
  return match?.id ?? null;
}

function measurementMatchesPrimitive(measurement: ProtocolExportMeasurement, primitive: string): boolean {
  if (primitive === 'line') return measurement.type === 'line' || measurement.type === 'distance';
  if (primitive === 'distance') return measurement.type === 'distance' || measurement.type === 'line';
  if (primitive === 'angle') return measurement.type === 'angle';
  if (primitive === 'point') return measurement.type === 'point' || measurement.type === 'perpendicular';
  return false;
}

function formatPoints(
  points: { x: number; y: number }[],
  maxPoints = 4,
  spacing: { x: number; y: number } = { x: 1, y: 1 },
): (string | number)[] {
  const flattened: (string | number)[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[index];
    if (point) {
      const xmm = point.x * spacing.x;
      const ymm = point.y * spacing.y;
      flattened.push(Number.isFinite(xmm) ? xmm.toFixed(4) : '');
      flattened.push(Number.isFinite(ymm) ? ymm.toFixed(4) : '');
    } else {
      flattened.push('');
      flattened.push('');
    }
  }
  return flattened;
}

function convertPointsToMm(points: { x: number; y: number }[], spacing: { x: number; y: number }) {
  return points.map((p) => ({ x: Number((p.x * spacing.x).toFixed(4)), y: Number((p.y * spacing.y).toFixed(4)) }));
}

function computeMeasurementValue(
  measurement: ProtocolExportMeasurement,
  spacing: { x: number; y: number },
): { value: number | null; unit: string | null } {
  const pts = measurement.points;
  if (!pts || pts.length < 2) return { value: null, unit: null };
  const dx = (pts[1].x - pts[0].x) * spacing.x;
  const dy = (pts[1].y - pts[0].y) * spacing.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (measurement.type === 'line' || measurement.type === 'distance' || measurement.type === 'perpendicular') {
    return { value: dist, unit: 'mm' };
  }
  if (measurement.type === 'angle' && pts.length >= 3) {
    const ax = (pts[0].x - pts[1].x) * spacing.x;
    const ay = (pts[0].y - pts[1].y) * spacing.y;
    const bx = (pts[2].x - pts[1].x) * spacing.x;
    const by = (pts[2].y - pts[1].y) * spacing.y;
    const adotb = ax * bx + ay * by;
    const alen = Math.sqrt(ax * ax + ay * ay);
    const blen = Math.sqrt(bx * bx + by * by);
    if (alen > 0 && blen > 0) {
      const cos = Math.max(-1, Math.min(1, adotb / (alen * blen)));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      return { value: deg, unit: '°' };
    }
  }
  return { value: null, unit: null };
}

function getPlaneSpacing(study: DicomStudyView | null | undefined, plane: Plane): { x: number; y: number } {
  const volume = study?.volumes?.[plane];
  const header = volume?.header as any;
  const pixDims = header?.pixDims || header?.pixdim || [];
  const spacingX = Number.isFinite(pixDims?.[1]) && pixDims[1] > 0 ? Number(pixDims[1]) : 1;
  const spacingY = Number.isFinite(pixDims?.[2]) && pixDims[2] > 0 ? Number(pixDims[2]) : 1;
  return { x: spacingX, y: spacingY };
}

function getSequenceName(study: DicomStudyView | null | undefined, plane: Plane): string {
  const volume = study?.volumes?.[plane];
  return (volume?.seriesDescription && volume.seriesDescription.trim()) || plane;
}

function inferProtocolStepResults(
  protocol: MeasurementProtocol,
  measurements: ProtocolExportMeasurement[],
): Record<string, StepResult> {
  const result: Record<string, StepResult> = {};
  // Track which measurements have already been claimed so that two steps with
  // the same primitive type (e.g. both line steps in Patellar Tilt) cannot
  // both latch onto the same measurement.
  const usedIds = new Set<string>();

  // Helper: extract the anatomical landmark from a measurement.
  // Perpendicular tools store [anchor-on-reference-line, actual-landmark];
  // for point steps we want the actual landmark (last point).
  const extractPoints = (
    match: ProtocolExportMeasurement,
    stepPrimitive: string,
  ): { x: number; y: number }[] => {
    if (stepPrimitive === 'point' && match.type === 'perpendicular' && match.points.length >= 2) {
      return [match.points[match.points.length - 1]];
    }
    return match.points;
  };

  const claim = (match: ProtocolExportMeasurement, step: { id: string; primitive: string }) => {
    usedIds.add(match.id);
    result[step.id] = {
      primitive: step.primitive as StepResult['primitive'],
      points: extractPoints(match, step.primitive),
      slice: match.slice,
    };
  };

  // Pass 1 – exact workflowStepId match (most reliable; set by the viewer).
  for (const step of protocol.steps) {
    const match = measurements.find((m) => !usedIds.has(m.id) && m.workflowStepId === step.id);
    if (match) claim(match, step);
  }

  // Pass 2 – label + primitive match (fallback when stepId not persisted).
  for (const step of protocol.steps) {
    if (result[step.id]) continue;
    const match = [...measurements]
      .reverse()
      .find(
        (m) =>
          !usedIds.has(m.id) &&
          m.label === step.label &&
          measurementMatchesPrimitive(m, step.primitive),
      );
    if (match) claim(match, step);
  }

  // Pass 3 – primitive type match in step order (last resort; avoids double-claim).
  // Iterates steps in declaration order so the first unmatched step gets the
  // earliest available candidate, preventing two same-primitive steps from
  // stealing each other's measurement.
  for (const step of protocol.steps) {
    if (result[step.id]) continue;
    const match = [...measurements]
      .reverse()
      .find((m) => !usedIds.has(m.id) && measurementMatchesPrimitive(m, step.primitive));
    if (match) claim(match, step);
  }

  return result;
}

export function exportProtocolMeasurementsToCsv(
  measurements: ProtocolExportMeasurement[],
  context: ProtocolExportContext = {},
): string {
  const header = CSV_COLUMNS.join(',');
  const byGroup = new Map<string, ProtocolExportMeasurement[]>();

  for (const measurement of measurements) {
    const groupId = measurement.groupId || measurement.id;
    const current = byGroup.get(groupId) ?? [];
    current.push(measurement);
    byGroup.set(groupId, current);
  }

  // Cross-group supplement: if a protocol group is missing a step that is
  // satisfied by a measurement belonging to a different group (e.g. the
  // posterior femoral condyle line drawn during TT-TG being reused by Patellar
  // Tilt), inject a shallow copy of that measurement into the borrowing group
  // so inferProtocolStepResults can resolve the step and protocol.compute
  // returns a result.  The original measurement stays in its own group; only a
  // copy is added here, tagged with the borrowing groupId.
  for (const [groupId, groupMeasurements] of byGroup) {
    const protocolId = findProtocolIdFromGroupId(groupId);
    const protocol = getProtocol(protocolId);
    if (!protocol) continue;

    for (const step of protocol.steps) {
      // Step is already satisfied within this group — nothing to borrow.
      const satisfied = groupMeasurements.some(
        (m) =>
          m.workflowStepId === step.id ||
          (m.label === step.label && measurementMatchesPrimitive(m, step.primitive)),
      );
      if (satisfied) continue;

      // Search every other measurement for a matching candidate.
      for (const candidate of measurements) {
        // Skip if already present in this group.
        if (groupMeasurements.some((m) => m.id === candidate.id)) continue;

        const matchesById = candidate.workflowStepId === step.id;
        const matchesByLabel =
          candidate.label === step.label && measurementMatchesPrimitive(candidate, step.primitive);

        if (matchesById || matchesByLabel) {
          // Shallow-clone so the original's groupId is unchanged.
          groupMeasurements.push({ ...candidate, groupId });
          break;
        }
      }
    }
  }

  const rows: CsvValue[][] = [];

  const sortedGroups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [groupId, groupMeasurements] of sortedGroups) {
    const protocolId = findProtocolIdFromGroupId(groupId);
    const protocol = getProtocol(protocolId);
    const groupSorted = [...groupMeasurements].sort((a, b) => {
      const ta = a.workflowStepId ? 0 : 1;
      const tb = b.workflowStepId ? 0 : 1;
      return ta - tb || a.slice - b.slice || a.id.localeCompare(b.id);
    });
    const sequenceName = protocol ? getSequenceName(context.study, protocol.requiredPlane) : groupSorted[0]?.plane ?? '';
    const spacing = protocol ? getPlaneSpacing(context.study, protocol.requiredPlane) : { x: 1, y: 1 };

    const baselineMap = new Map<string, ProtocolExportMeasurement>();
    for (const measurement of groupSorted) baselineMap.set(measurement.id, measurement);

    if (protocol) {
      const stepResults = inferProtocolStepResults(protocol, groupSorted);
      const finalResult = protocol.compute(stepResults, spacing);
      const completedStepIds = new Set(Object.keys(stepResults));
      const stepMeasurementIds = [...groupSorted.map((m) => m.id)];

      if (finalResult) {
        rows.push([
          'protocol_result',
          context.patientId ?? '',
          context.patientName ?? '',
          context.studyName ?? '',
          context.laterality ?? '',
          sequenceName,
          protocol.requiredPlane,
          protocol.id,
          protocol.label,
          groupId,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          finalResult.value.toFixed(4),
          finalResult.unit,
          finalResult.summary,
          finalResult.interpretation ?? '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          JSON.stringify(stepMeasurementIds),
        ]);
      }

      for (const measurement of groupSorted) {
        const baseline = measurement.baseLineId ? baselineMap.get(measurement.baseLineId) : undefined;
        const computed = computeMeasurementValue(measurement, spacing);
        const measurementValueCell = computed.value != null ? computed.value.toFixed(4) : '';
        const finalResultValue = finalResult ? finalResult.value.toFixed(4) : '';
        const finalResultUnit = finalResult?.unit ?? '';
        const finalResultSummary = finalResult?.summary ?? '';
        const finalResultInterpretation = finalResult?.interpretation ?? '';
        const measurementPointsJson = JSON.stringify(convertPointsToMm(measurement.points, spacing));
        const baselinePointsJson = JSON.stringify(convertPointsToMm(baseline?.points ?? [], spacing));
        rows.push([
          'step_measurement',
          context.patientId ?? '',
          context.patientName ?? '',
          context.studyName ?? '',
          context.laterality ?? '',
          sequenceName,
          measurement.plane,
          protocol.id,
          protocol.label,
          groupId,
          measurement.id,
          measurement.workflowStepId ?? '',
          protocol.steps.find((step) => step.id === measurement.workflowStepId)?.label ?? measurement.label ?? '',
          protocol.steps.find((step) => step.id === measurement.workflowStepId)?.primitive ?? measurement.type,
          measurement.type,
          measurement.slice,
          measurement.points.length,
          finalResultValue,
          finalResultUnit,
          finalResultSummary,
          finalResultInterpretation,
          measurement.label ?? '',
          measurementValueCell,
          computed.unit ?? '',
          String(measurement.propagateAcrossSlices ?? true),
          ...formatPoints(measurement.points, 4, spacing),
          measurementPointsJson,
          measurement.baseLineId ?? '',
          ...(baseline ? formatPoints(baseline.points, 2, spacing) : ['', '', '', '']),
          baselinePointsJson,
          measurementPointsJson,
          baselinePointsJson,
          JSON.stringify([...completedStepIds]),
        ]);
      }
      continue;
    }

    // Non-protocol groups still export their raw geometry.
    for (const measurement of groupSorted) {
      const measurementPointsJson = JSON.stringify(convertPointsToMm(measurement.points, spacing));
      const baselinePointsJson = '[]';
      const computed = computeMeasurementValue(measurement, spacing);
      const measurementValueCell = computed.value != null ? computed.value.toFixed(4) : '';
      rows.push([
        'raw_measurement',
        context.patientId ?? '',
        context.patientName ?? '',
        context.studyName ?? '',
        context.laterality ?? '',
        sequenceName,
        measurement.plane,
        '',
        '',
        groupId,
        measurement.id,
        measurement.workflowStepId ?? '',
        measurement.label ?? '',
        '',
        measurement.type,
        measurement.slice,
        measurement.points.length,
        '',
        '',
        '',
        '',
        measurement.label ?? '',
        measurementValueCell,
        computed.unit ?? '',
        String(measurement.propagateAcrossSlices ?? true),
        ...formatPoints(measurement.points, 4, spacing),
        measurementPointsJson,
        measurement.baseLineId ?? '',
        '',
        '',
        '',
        '',
        baselinePointsJson,
        measurementPointsJson,
        baselinePointsJson,
        '[]',
      ]);
    }
  }

  const csvRows = rows.map((row) => row.map(escapeCsvField).join(','));
  return [header, ...csvRows].join('\r\n');
}