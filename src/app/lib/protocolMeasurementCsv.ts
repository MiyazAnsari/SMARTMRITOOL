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
  'measurementPropagateAcrossSlices',
  'p0_x',
  'p0_y',
  'p1_x',
  'p1_y',
  'p2_x',
  'p2_y',
  'p3_x',
  'p3_y',
  'baselineId',
  'baseline_p0_x',
  'baseline_p0_y',
  'baseline_p1_x',
  'baseline_p1_y',
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

function formatPoints(points: { x: number; y: number }[], maxPoints = 4): (string | number)[] {
  const flattened: (string | number)[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[index];
    flattened.push(point ? point.x : '');
    flattened.push(point ? point.y : '');
  }
  return flattened;
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
  const reversed = [...measurements].reverse();

  for (const step of protocol.steps) {
    const match = reversed.find(
      (measurement) =>
        measurement.workflowStepId === step.id ||
        (measurement.label === step.label && measurementMatchesPrimitive(measurement, step.primitive)),
    );
    if (!match) continue;
    const points =
      step.primitive === 'point' && match.type === 'perpendicular' && match.points.length >= 2
        ? [match.points[1]]
        : match.points;
    result[step.id] = {
      primitive: step.primitive,
      points,
      slice: match.slice,
    };
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
          JSON.stringify(stepMeasurementIds),
        ]);
      }

      for (const measurement of groupSorted) {
        const baseline = measurement.baseLineId ? baselineMap.get(measurement.baseLineId) : undefined;
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
          '',
          '',
          '',
          '',
          measurement.label ?? '',
          '',
          String(measurement.propagateAcrossSlices ?? true),
          ...formatPoints(measurement.points),
          measurement.baseLineId ?? '',
          ...(baseline ? formatPoints(baseline.points, 2) : ['', '', '', '']),
          JSON.stringify(measurement.points),
          JSON.stringify(baseline?.points ?? []),
          JSON.stringify([...completedStepIds]),
        ]);
      }
      continue;
    }

    // Non-protocol groups still export their raw geometry.
    for (const measurement of groupSorted) {
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
        '',
        String(measurement.propagateAcrossSlices ?? true),
        ...formatPoints(measurement.points),
        measurement.baseLineId ?? '',
        '',
        '',
        '',
        '',
        JSON.stringify(measurement.points),
        '[]',
        '[]',
      ]);
    }
  }

  const csvRows = rows.map((row) => row.map(escapeCsvField).join(','));
  return [header, ...csvRows].join('\r\n');
}
