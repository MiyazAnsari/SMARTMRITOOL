import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as nifti from 'nifti-reader-js';
import { ViewportGrid } from './ViewportGrid';
import { WeightingPanel } from './WeightingPanel';
import { Button } from './ui/button';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Label } from './ui/label';
import { MousePointer, Circle as CircleIcon, Pencil, Move, Ruler, Triangle, Dot, CornerDownLeft } from 'lucide-react';

/** Lightweight tooltip — no external dependency required. */
function ToolTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative group/tip">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs text-gray-100 opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100 z-[10000]">
        {label}
      </div>
    </div>
  );
}
import type { DicomStudyView } from './dicom/patientStudy';
import type { DicomVolume, Plane } from './dicom/DicomLoader';
import {
  initialWorkflowState,
  recordStepResult,
  WorkflowState,
} from './measurement/MeasurementWorkflow';
import {
  getProtocol,
  Primitive,
  type WorkflowTool,
} from './measurement/MeasurementProtocols';
import type { SessionAnnotator, SessionAnnotationRow } from '../lib/sessionAnnotationCsv';
import { splitValueUnits } from '../lib/sessionAnnotationCsv';

const STUDY_PLANE_ORDER: Plane[] = ['axial', 'sagittal', 'coronal'];

function preferredAvailablePlane(volumes: Partial<Record<Plane, DicomVolume>>): Plane | null {
  for (const p of STUDY_PLANE_ORDER) {
    if (volumes[p]) return p;
  }
  const keys = Object.keys(volumes) as Plane[];
  return keys[0] ?? null;
}

/** Which floating DICOM viewers are open + which series drives the sidebar / pixel spacing. */
type StudyViewportState = { open: Plane[]; active: Plane };

function initialOpenPlanesForStudy(volumes: Partial<Record<Plane, DicomVolume>>): Plane[] {
  return STUDY_PLANE_ORDER.filter((p) => Boolean(volumes[p]));
}

/** 0-based index of the middle slice: `Math.floor(totalSlices / 2)` (per plane / sequence). */
export function middleSliceIndexFromCount(totalSlices: number): number {
  if (!Number.isFinite(totalSlices) || totalSlices <= 0) return 0;
  return Math.floor(totalSlices / 2);
}

function stateAfterClosingViewer(
  s: StudyViewportState,
  plane: Plane,
  volumes: Partial<Record<Plane, DicomVolume>>,
): StudyViewportState {
  if (!s.open.includes(plane)) return s;
  const open = s.open.filter((p) => p !== plane);
  let active = s.active;
  if (active === plane) {
    const next = open[0] ?? preferredAvailablePlane(volumes);
    active = next ?? plane;
  }
  return { open, active };
}

export interface MedicalImageViewerProps {
  niftiData?: ArrayBuffer | null;
  /** When set to a measurement id, force the viewer to jump to that measurement's slice on select. */
  forceJumpOnSelectId?: string | null;
}

export type MeasurementTool =
  | 'none'
  | 'distance'
  | 'angle'
  | 'perpendicular'
  | 'ellipse'
  | 'closedCurve'
  | 'freehand'
  | 'pan'
  | 'line'
  | 'point';
export type WeightingType = 'T1' | 'T2' | 'PD' | 'CT' | 'Custom';
export type MeasurementDisplayUnits = 'mm' | 'px';

export interface WindowLevel {
  window: number;
  level: number;
}

/** Allows dynamic scaling during resize to avoid stale closures */
export type PointUpdater = { x: number; y: number }[] | ((prev: { x: number; y: number }[]) => { x: number; y: number }[]);

/** Default W/L for normalized 0–255 NIfTI display (per-viewport state lives in `Viewport`). */
const NIFTI_DEFAULT_WINDOW_LEVEL: WindowLevel = { window: 255, level: 128 };

export interface Measurement {
  id: string;
  type: MeasurementTool;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  patientId?: string;
  patientName?: string;
  studyName?: string;
  sequenceName?: string;
  laterality?: 'left' | 'right';
  value?: string;
  /** ISO-8601 when captured; set automatically on add for persisted patients. */
  timestamp?: string;
  baseLineId?: string;
  groupId?: string;
  label?: string;
  workflowStepId?: string;
  /** When true the measurement is shown on parallel slices and selection shouldn't force a slice jump. */
  propagateAcrossSlices?: boolean;
  /** CSS-pixel → image-pixel scale factor at the time the measurement was captured.
   *  Stored so protocol `compute` can convert overlay coordinates to physical mm
   *  regardless of the current viewport display size. */
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
}

interface MedicalImageViewerExtras {
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  studyData?: DicomStudyView | null;
  onStudyLoad?: (study: import('./dicom/DicomStudy').DicomStudy) => void;
  /** When set with `onPatientMeasurementsUpdate`, measurements are controlled by the parent (per-patient persistence). */
  patientStorageKey?: string | null;
  patientMeasurements?: Measurement[];
  onPatientMeasurementsUpdate?: (updater: (prev: Measurement[]) => Measurement[]) => void;
  /**
   * Session-only annotations: when set with `onCommitSessionAnnotation`, new drawings are persisted
   * as structured rows in the parent (not localStorage). Overrides archive `onPatientMeasurementsUpdate`.
   */
  sessionAnnotator?: SessionAnnotator | null;
  onCommitSessionAnnotation?: (row: SessionAnnotationRow) => void;
  onDeleteSessionAnnotation?: (annotationId: string) => void;
  onUpdateSessionAnnotation?: (
    annotationId: string,
    updater: (row: SessionAnnotationRow) => SessionAnnotationRow,
  ) => void;
  selectedMeasurementId?: string | null;
  onMeasurementSelect?: (id: string | null) => void;
  /** Notify parent when the current protocol group id changes (or null). */
  onCurrentGroupChange?: (groupId: string | null) => void;
}

/** Map a workflow step tool to one of the existing viewport tools. */
function workflowToolToMeasurementTool(tool: WorkflowTool): MeasurementTool {
  switch (tool) {
    case 'line':
      return 'line';
    case 'angle':
      return 'angle';
    case 'none':
      return 'none';
    case 'point':
      return 'point'; // standalone point placement — distinct from Select
    case 'distance':
    default:
      return 'distance';
  }
}

/** Does a measurement (as captured by the viewport) satisfy a primitive? */
function measurementMatchesPrimitive(measurement: Measurement, primitive: Primitive): boolean {
  if (primitive === 'line') return measurement.type === 'line' || measurement.type === 'distance';
  if (primitive === 'distance') return measurement.type === 'distance' || measurement.type === 'line';
  if (primitive === 'angle') return measurement.type === 'angle';
  if (primitive === 'point') return measurement.type === 'point' || measurement.type === 'perpendicular';
  return false;
}

function buildSessionAnnotationRow(
  m: Measurement,
  studyData: DicomStudyView,
  sourcePatientKey: string,
  annotator: SessionAnnotator,
): SessionAnnotationRow {
  const vol = studyData.volumes[m.plane];
  const sequenceName = (vol?.seriesDescription && vol.seriesDescription.trim()) || m.plane;
  const { value, units } = splitValueUnits(m.value);
  const ts = m.timestamp || new Date().toISOString();
  return {
    sourcePatientKey,
    laterality: studyData.laterality,
    // Use the measurement id as the session annotation id so the sidebar
    // `Select` button can directly select the corresponding measurement in
    // the viewport (keeps ids aligned between UI and viewport state).
    annotationId: m.id,
    patientId: m.patientId || studyData.patientId || 'unknown',
    patientName: m.patientName || studyData.patientName || undefined,
    studyName: m.studyName || studyData.studyName || undefined,
    sequenceName: m.sequenceName || sequenceName,
    plane: m.plane,
    measurementType: m.type,
    baseLineId: m.baseLineId,
    groupId: m.groupId,
    label: m.label,
    workflowStepId: m.workflowStepId,
    value,
    units,
    sliceIndex: m.slice,
    propagateAcrossSlices: m.propagateAcrossSlices ?? true,
    imageScale: m.imageScale,
    annotatedBy: annotator.name,
    annotatorEmail: annotator.email,
    timestamp: ts,
    points: m.points.map((p) => ({ x: p.x, y: p.y })),
  };
}

export function MedicalImageViewer({
  niftiData,
  onFileLoad,
  studyData = null,
  onStudyLoad,
  patientStorageKey = null,
  patientMeasurements,
  onPatientMeasurementsUpdate,
  sessionAnnotator = null,
  onCommitSessionAnnotation,
  onDeleteSessionAnnotation,
  onUpdateSessionAnnotation,
  selectedMeasurementId = null,
  onMeasurementSelect,
  forceJumpOnSelectId = null,
  onCurrentGroupChange,
}: MedicalImageViewerProps & MedicalImageViewerExtras) {
  const [imageData, setImageData] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<any>(null);
  const [dataRange, setDataRange] = useState<{ min: number; max: number }>({ min: 0, max: 255 });
  const [currentSlice, setCurrentSlice] = useState({ axial: 0, sagittal: 0, coronal: 0 });
  /** Middle slice at last sequence load (`Math.floor(totalSlices/2)`), per plane; independent A/S/C. */
  const initialSliceIndex = useRef({ axial: 0, sagittal: 0, coronal: 0 });
  const [activeTool, setActiveTool] = useState<MeasurementTool>('pan');
  const [userToolOverride, setUserToolOverride] = useState<MeasurementTool | null>(null);
  const [localMeasurements, setLocalMeasurements] = useState<Measurement[]>([]);
  const sessionMeasurementMode =
    Boolean(patientStorageKey) &&
    Boolean(sessionAnnotator) &&
    typeof onCommitSessionAnnotation === 'function';
  const archiveMeasurementMode =
    Boolean(patientStorageKey) &&
    typeof onPatientMeasurementsUpdate === 'function' &&
    !sessionMeasurementMode;
  const measurementsControlled = sessionMeasurementMode || archiveMeasurementMode;
  const measurements = measurementsControlled ? (patientMeasurements ?? []) : localMeasurements;
  const [weighting, setWeighting] = useState<WeightingType>('T1');
  const [measurementUnits, setMeasurementUnits] = useState<MeasurementDisplayUnits>('mm');
  // single psi slider for custom weighting (0-180 degrees)
  const [customWeighting, setCustomWeighting] = useState({ psi: 90 });
  // UI helpers
  const [showCrosshair, setShowCrosshair] = useState<boolean>(false);
  // resizable right panel width (px)
  const [rightWidth, setRightWidth] = useState<number>(288); // default w-72 (18rem)
  const rightResizing = useRef(false);
  // Measurement workflow (TT-TG, Insall–Salvati, etc.)
  const [workflow, setWorkflow] = useState<WorkflowState>(initialWorkflowState);
  /** DICOM: open floating viewers + focused series (single source of truth with `open`). */
  const [studyViewport, setStudyViewport] = useState<StudyViewportState>({ open: [], active: 'axial' });
  const prevStudyDataRef = useRef<DicomStudyView | null>(null);
  const previousMeasurementsRef = useRef<Measurement[]>([]);

  const protocol = useMemo(() => getProtocol(workflow.protocolId), [workflow.protocolId]);
  const activeStep = protocol?.steps[workflow.activeStepIndex] ?? null;
  // When a workflow step is active, override the user-selected tool so the
  // correct primitive is always armed unless the user manually picks another tool.
  const effectiveTool: MeasurementTool = userToolOverride ?? (activeStep ? workflowToolToMeasurementTool(activeStep.tool) : activeTool);

  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const currentGroupIdRef = useRef<string | null>(null);

  // Track per-plane viewport display sizes so we can compute CSS→image-pixel
  // scale factors for mm conversion in protocol calculations.
  const [viewportDisplaySizes, setViewportDisplaySizes] = useState<Record<string, { width: number; height: number }>>({});
  const handleViewportDisplaySizeChange = useCallback(
    (plane: Plane, size: { width: number; height: number }) => {
      setViewportDisplaySizes((prev) => {
        if (prev[plane]?.width === size.width && prev[plane]?.height === size.height) return prev;
        return { ...prev, [plane]: size };
      });
    },
    [],
  );

  // Compute CSS→image-pixel scale for the protocol's required plane.
  // Must match the spacing + dimension logic used by the Viewport's
  // getPlaneGeometry so the draw area is identical.
  const imageScale = useMemo(() => {
    if (!protocol) return undefined;
    const plane = protocol.requiredPlane;
    const vol = studyData?.volumes[plane];
    if (!vol || !vol.header) return undefined;
    const dims = vol.header.dims;
    const pixDims: number[] = vol.header.pixDims || vol.header.pixdim || [];
    const imgW: number = plane === 'sagittal' ? dims[2] : dims[1];
    const imgH: number = plane === 'axial' ? dims[2] : dims[3];
    const p1: number = Number.isFinite(pixDims[1]) && pixDims[1] > 0 ? pixDims[1] : 1;
    const p2: number = Number.isFinite(pixDims[2]) && pixDims[2] > 0 ? pixDims[2] : 1;
    const dInPlane: number = Math.min(p1, p2);
    let spcX: number;
    let spcY: number;
    if (plane === 'axial') { spcX = p1; spcY = p2; }
    else if (plane === 'coronal') { spcX = p1; spcY = dInPlane; }
    else { spcX = p2; spcY = dInPlane; }
    const dSize = viewportDisplaySizes[plane];
    if (!dSize || dSize.width === 0) return undefined;
    const physicalW = Math.max(1, imgW * spcX);
    const physicalH = Math.max(1, imgH * spcY);
    const fitScale = Math.min(dSize.width / physicalW, dSize.height / physicalH);
    const drawW = Math.max(1, Math.round(physicalW * fitScale));
    const drawH = Math.max(1, Math.round(physicalH * fitScale));
    return { x: imgW / drawW, y: imgH / drawH };
  }, [protocol, studyData, viewportDisplaySizes]);

  // ── Cross-plane reference line computation ─────────────────────────
  // When any completed protocol step defines a `referenceLineMm` offset and
  // its result exists, compute reference line data for the viewport that
  // hosts the step's plane.  The line persists across steps so the user can
  // click it to navigate even after advancing to later steps.
  const referenceLineByPlane = useMemo(() => {
    if (!protocol) return undefined;
    const result: Record<string, {
      fromPoint: { x: number; y: number };
      offsetMm: number;
      label: string;
      imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
    } | null> = {};

    for (const step of protocol.steps) {
      if (!step.referenceLineMm) continue;
      const stepResult = workflow.stepResults[step.id];
      if (!stepResult || stepResult.points.length < 1) continue;

      const refPlane = step.plane ?? protocol.requiredPlane;
      const point = stepResult.points[stepResult.points.length - 1];
      const is = stepResult.imageScale;

      result[refPlane] = {
        fromPoint: point,
        offsetMm: step.referenceLineMm,
        label: `${(step.referenceLineMm / 10).toFixed(1)} cm above joint line`,
        imageScale: is,
      };
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }, [protocol, workflow.stepResults]);

  // ── Reference line click → navigate axial viewer ──────────────────
  // The Viewport passes the Z-position in sagittal image-pixels and the
  // Z extent.  We map the fraction to the axial volume's actual slice count.
  const navigateToAxialFraction = useCallback(
    (refImgY: number, imgH: number) => {
      if (refImgY < 0 || imgH <= 0) return;
      const axialVol = studyData?.volumes?.axial;
      const axialSliceCount = axialVol?.sliceCount ?? (axialVol?.header?.dims?.[3] ?? 0);
      if (axialSliceCount <= 0) return;
      const fraction = Math.max(0, Math.min(1, refImgY / imgH));
      const axialSlice = Math.round(fraction * (axialSliceCount - 1));
      setCurrentSlice((prev) => ({ ...prev, axial: axialSlice }));
      if (studyData) {
        setStudyViewport((s) => ({
          open: s.open.includes('axial') ? s.open : [...s.open, 'axial'],
          active: 'axial',
        }));
      }
    },
    [studyData],
  );

  const handleReferenceLineClick = useCallback(
    (refImgY: number, imgH: number) => {
      navigateToAxialFraction(refImgY, imgH);
    },
    [navigateToAxialFraction],
  );

  // ── Auto-navigate on first reference line appearance ──────────────
  // When the user places the joint-line point and the reference line data
  // first becomes available, automatically jump the axial viewer to the
  // computed 3‑cm‑above slice so the user can immediately start drawing
  // the sulcus angle lines without an extra click.
  const prevHadReferenceLine = useRef(false);
  useEffect(() => {
    const hasNow = referenceLineByPlane != null;
    if (hasNow && !prevHadReferenceLine.current) {
      // First time the reference line appears — auto-navigate.
      const sagData = referenceLineByPlane!['sagittal'];
      if (sagData && protocol) {
        // Recompute the Z fraction using the sagittal volume's geometry.
        const sagVol = studyData?.volumes?.sagittal;
        const pixDims: number[] = sagVol?.header?.pixDims || sagVol?.header?.pixdim || [];
        const rowSpacing = Number.isFinite(pixDims[2]) && pixDims[2] > 0 ? pixDims[2] : 1;
        const imgH = sagVol?.header?.dims?.[2] ?? 0; // sagittal image height = Z extent
        const is = sagData.imageScale;
        if (imgH > 0 && is) {
          const imgY = (sagData.fromPoint.y - (is.offsetY ?? 0)) * (is.y || 1);
          const refImgY = imgY - sagData.offsetMm / rowSpacing;
          navigateToAxialFraction(refImgY, imgH);
        }
      }
    }
    prevHadReferenceLine.current = hasNow;
  }, [referenceLineByPlane, protocol, studyData, navigateToAxialFraction]);

  useEffect(() => {
    if (workflow.protocolId) {
      const id = `${workflow.protocolId}-${Date.now()}`;
      setCurrentGroupId(id);
      currentGroupIdRef.current = id;
      // Reset per-group measurement counter when starting a new protocol.
      groupCountsRef.current = { distanceCount: 0, perpCount: 0 };
    } else {
      setCurrentGroupId(null);
      currentGroupIdRef.current = null;
      groupCountsRef.current = { distanceCount: 0, perpCount: 0 };
    }
  }, [workflow.protocolId]);

  // Synchronously-tracked measurement counts per group so the limiting
  // check in handleMeasurementAdd never sees stale React state.
  const groupCountsRef = useRef<{ distanceCount: number; perpCount: number }>({ distanceCount: 0, perpCount: 0 });

  useEffect(() => {
    console.debug('[MedicalImageViewer] currentGroupId changed', currentGroupId);
    onCurrentGroupChange?.(currentGroupId ?? null);
  }, [currentGroupId, onCurrentGroupChange]);

  useEffect(() => {
    if (workflow.protocolId) setUserToolOverride(null);
  }, [workflow.protocolId]);

  useEffect(() => {
    if (!activeStep) return;
    setUserToolOverride(null);
  }, [activeStep?.id]);

  useEffect(() => {
    const previous = previousMeasurementsRef.current;
    previousMeasurementsRef.current = measurements;
    if (!protocol) return;

    const currentIds = new Set(measurements.map((m) => m.id));
    const removed = previous.filter((m) => !currentIds.has(m.id));
    if (removed.length === 0) return;

    const removedStepIds = new Set<string>();
    for (const measurement of removed) {
      const stepId =
        measurement.workflowStepId ||
        protocol.steps.find((step) => step.label === measurement.label && measurementMatchesPrimitive(measurement, step.primitive))?.id;
      if (stepId) removedStepIds.add(stepId);
    }

    if (removedStepIds.size === 0) return;

    setWorkflow((prev) => {
      let changed = false;
      const stepResults = { ...prev.stepResults };
      let nextActiveIndex = prev.activeStepIndex;
      for (const stepId of removedStepIds) {
        if (stepResults[stepId]) {
          delete stepResults[stepId];
          const stepIndex = protocol.steps.findIndex((step) => step.id === stepId);
          if (stepIndex >= 0) nextActiveIndex = stepIndex;
          changed = true;
        }
      }
      return changed ? { ...prev, stepResults, activeStepIndex: nextActiveIndex } : prev;
    });
  }, [measurements, protocol]);

  useEffect(() => {
    if (!protocol) return;

    const existingResults: Record<string, { primitive: Primitive; points: { x: number; y: number }[]; slice: number }> = {};
    const consumedMeasurementIds = new Set<string>();

    const samePoints = (
      a: { x: number; y: number }[],
      b: { x: number; y: number }[],
    ) => a.length === b.length && a.every((point, index) => point.x === b[index]?.x && point.y === b[index]?.y);

    const sameStepResult = (
      a: { primitive: Primitive; points: { x: number; y: number }[]; slice: number } | undefined,
      b: { primitive: Primitive; points: { x: number; y: number }[]; slice: number },
    ) => !!a && a.primitive === b.primitive && a.slice === b.slice && samePoints(a.points, b.points);

    const claimMatch = (predicate: (m: Measurement) => boolean) => {
      const match = measurements.find((m) => !consumedMeasurementIds.has(m.id) && predicate(m));
      if (match) consumedMeasurementIds.add(match.id);
      return match;
    };

    for (const step of protocol.steps) {
      // 1) exact workflowStepId match
      let match = claimMatch((m) => m.workflowStepId === step.id);
      // 2) prefer measurements that belong to the current protocol group
      if (!match && currentGroupIdRef.current) {
        match = claimMatch(
          (m) => m.groupId === currentGroupIdRef.current && measurementMatchesPrimitive(m, step.primitive),
        );
      }
      // 3) fallback to label+primitive (legacy behavior)
      if (!match) {
        match = claimMatch((m) => m.label === step.label && measurementMatchesPrimitive(m, step.primitive));
      }

      if (match) {
        const isPointFromPerp = step.primitive === 'point' && match.type === 'perpendicular' && match.points.length >= 2;
        existingResults[step.id] = {
          primitive: step.primitive,
          points: isPointFromPerp ? [{ x: match.points[1].x, y: match.points[1].y }] : match.points.map((p) => ({ x: p.x, y: p.y })),
          slice: match.slice,
        };
      }
    }

    setWorkflow((prev) => {
      if (prev.protocolId !== protocol.id && prev.protocolId !== null) return prev;
      const merged = { ...prev.stepResults };
      let changed = false;
      for (const [stepId, result] of Object.entries(existingResults)) {
        if (!sameStepResult(merged[stepId], result)) {
          merged[stepId] = result;
          changed = true;
        }
      }
      if (!changed) return prev;
      const nextActiveIndex = protocol.steps.findIndex((step) => !merged[step.id]);
      return {
        ...prev,
        protocolId: protocol.id,
        stepResults: merged,
        activeStepIndex: nextActiveIndex >= 0 ? nextActiveIndex : Math.max(0, protocol.steps.length - 1),
      };
    });

    // Keep the per-group measurement counter in sync with reused steps so
    // the limit in handleMeasurementAdd doesn't let the user draw extra
    // lines/points beyond what the protocol specifies.
    const reusedDistanceCount = Object.values(existingResults).filter(
      (r) => r.primitive === 'line' || r.primitive === 'distance',
    ).length;
    const reusedPerpCount = Object.values(existingResults).filter(
      (r) => r.primitive === 'point',
    ).length;
    groupCountsRef.current = {
      distanceCount: reusedDistanceCount,
      perpCount: reusedPerpCount,
    };
  }, [measurements, protocol]);

  const onMeasurementSelectRef = useRef(onMeasurementSelect);
  useEffect(() => {
    onMeasurementSelectRef.current = onMeasurementSelect;
  }, [onMeasurementSelect]);

  useEffect(() => {
    console.debug('[MedicalImageViewer] selectedMeasurementId effect', { selectedMeasurementId, forceJumpOnSelectId });
    if (!selectedMeasurementId) return;
    const selectedMeasurement = measurements.find((m) => m.id === selectedMeasurementId);
    if (!selectedMeasurement) return;

    // If the measurement is propagated across slices, do not force the
    // viewer to jump back to the measurement's original slice — unless the
    // parent explicitly asked to force a jump via `forceJumpOnSelectId`.
    if (selectedMeasurement.propagateAcrossSlices === true && forceJumpOnSelectId !== selectedMeasurementId) return;

    const plane = selectedMeasurement.plane ?? 'axial';
    setCurrentSlice((prev) => (prev[plane] === selectedMeasurement.slice ? prev : { ...prev, [plane]: selectedMeasurement.slice }));
    
    // Use ref to avoid dependency cycles while safely notifying parent
    onMeasurementSelectRef.current?.(selectedMeasurement.id);
  }, [measurements, selectedMeasurementId, forceJumpOnSelectId]);

  // Also respond directly to an explicit force-jump request from the parent.
  useEffect(() => {
    if (!forceJumpOnSelectId) return;
    console.debug('[MedicalImageViewer] received forceJumpOnSelectId', forceJumpOnSelectId);
    const forced = measurements.find((m) => m.id === forceJumpOnSelectId);
    if (!forced) return;
    const plane = forced.plane ?? 'axial';
    setCurrentSlice((prev) => (prev[plane] === forced.slice ? prev : { ...prev, [plane]: forced.slice }));
    
    onMeasurementSelectRef.current?.(forced.id);
  }, [forceJumpOnSelectId, measurements]);

  const selectTool = (tool: MeasurementTool) => {
    setActiveTool(tool);
    setUserToolOverride(tool);
  };

  useEffect(() => {
    if (!niftiData) return;

    try {
      if (nifti.isCompressed(niftiData)) {
        throw new Error('File appears to be compressed. Please use a .nii.gz file and ensure it\'s properly decompressed.');
      }
      
      if (!nifti.isNIFTI(niftiData)) {
        throw new Error('File is not a valid NIfTI format');
      }

      const niftiHeader = nifti.readHeader(niftiData);
      if (!niftiHeader) {
        throw new Error('Could not read NIfTI header');
      }

      const niftiImage = nifti.readImage(niftiHeader, niftiData);
      if (!niftiImage) {
        throw new Error('Could not read NIfTI image data');
      }
      
      let typedData: number[];
      const datatypeCode = niftiHeader.datatypeCode;
      
      if (datatypeCode === 2) {
        typedData = Array.from(new Uint8Array(niftiImage));
      } else if (datatypeCode === 4) {
        typedData = Array.from(new Int16Array(niftiImage));
      } else if (datatypeCode === 512) {
        typedData = Array.from(new Uint16Array(niftiImage));
      } else if (datatypeCode === 8) {
        typedData = Array.from(new Int32Array(niftiImage));
      } else if (datatypeCode === 16) {
        typedData = Array.from(new Float32Array(niftiImage));
      } else if (datatypeCode === 64) {
        typedData = Array.from(new Float64Array(niftiImage));
      } else {
        console.warn(`Unknown datatype code ${datatypeCode}, defaulting to Int16`);
        typedData = Array.from(new Int16Array(niftiImage));
      }
      
      let min = Infinity;
      let max = -Infinity;
      
      for (let i = 0; i < typedData.length; i++) {
        const val = typedData[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      
      const slope = niftiHeader.scl_slope || 1;
      const inter = niftiHeader.scl_inter || 0;
      
      if (slope !== 0 && slope !== 1) {
        min = min * slope + inter;
        max = max * slope + inter;
      }
      
      const range = max - min;
      const normalizedData = new Uint8Array(typedData.length);
      
      if (range > 0) {
        for (let i = 0; i < typedData.length; i++) {
          let val = typedData[i];
          if (slope !== 0 && slope !== 1) {
            val = val * slope + inter;
          }
          normalizedData[i] = Math.round(((val - min) / range) * 255);
        }
      }
      
      setHeader(niftiHeader);
      setImageData(normalizedData);
      setDataRange({ min, max });
      
      const d = niftiHeader.dims;
      const initial = {
        axial: middleSliceIndexFromCount(d[3] ?? 0),
        sagittal: middleSliceIndexFromCount(d[1] ?? 0),
        coronal: middleSliceIndexFromCount(d[2] ?? 0),
      };
      initialSliceIndex.current = initial;
      setCurrentSlice(initial);
    } catch (error) {
      console.error('Error parsing NIfTI file:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Error parsing NIfTI file: ${errorMessage}\n\nPlease ensure it is a valid NIfTI format.`);
    }
  }, [niftiData]);

  useEffect(() => {
    if (!studyData) {
      prevStudyDataRef.current = null;
      setStudyViewport({ open: [], active: 'axial' });
      const cleared = { axial: 0, sagittal: 0, coronal: 0 };
      initialSliceIndex.current = cleared;
      setCurrentSlice(cleared);
      return;
    }

    if (prevStudyDataRef.current !== studyData) {
      prevStudyDataRef.current = studyData;
      const open = initialOpenPlanesForStudy(studyData.volumes);
      const active0 = open[0] ?? preferredAvailablePlane(studyData.volumes) ?? 'axial';
      setStudyViewport({ open, active: active0 });
      const initial = {
        axial: studyData.volumes.axial
          ? middleSliceIndexFromCount(studyData.volumes.axial.sliceCount)
          : 0,
        sagittal: studyData.volumes.sagittal
          ? middleSliceIndexFromCount(studyData.volumes.sagittal.sliceCount)
          : 0,
        coronal: studyData.volumes.coronal
          ? middleSliceIndexFromCount(studyData.volumes.coronal.sliceCount)
          : 0,
      };
      initialSliceIndex.current = initial;
      setCurrentSlice(initial);
      const vol0 = studyData.volumes[active0];
      if (vol0) {
        setHeader(vol0.header);
        setImageData(vol0.imageData);
        setDataRange(vol0.dataRange);
      }
      return;
    }

    let plane: Plane = studyViewport.active;
    let vol = studyData.volumes[plane];
    if (!vol) {
      const p = preferredAvailablePlane(studyData.volumes);
      if (!p) return;
      plane = p;
      vol = studyData.volumes[p]!;
      setStudyViewport((s) => (s.active === plane ? s : { ...s, active: plane }));
    }

    setHeader(vol.header);
    setImageData(vol.imageData);
    setDataRange(vol.dataRange);
  }, [studyData, studyViewport.active]);

  const selectStudyPlane = useCallback(
    (plane: Plane) => {
      if (!studyData) return;
      if (!studyData.volumes[plane]) {
        alert(
          `This study does not contain a ${plane} series. Available: ${Object.keys(
            studyData.volumes,
          ).join(', ') || 'none'}.`,
        );
        return;
      }
      setStudyViewport((s) => ({
        open: s.open.includes(plane) ? s.open : [...s.open, plane],
        active: plane,
      }));
    },
    [studyData],
  );

  const closeStudyPlaneViewport = useCallback(
    (plane: Plane) => {
      const studyVolumes = studyData?.volumes;
      if (!studyVolumes?.[plane]) return;
      setStudyViewport((s) => stateAfterClosingViewer(s, plane, studyVolumes));
    },
    [studyData],
  );

  const toggleStudyPlaneViewport = useCallback(
    (plane: Plane) => {
      const studyVolumes = studyData?.volumes;
      if (!studyVolumes?.[plane]) {
        alert(
          `This study does not contain a ${plane} series. Available: ${Object.keys(
            studyVolumes || {},
          ).join(', ') || 'none'}.`,
        );
        return;
      }
      setStudyViewport((s) => {
        if (s.open.includes(plane)) {
          return stateAfterClosingViewer(s, plane, studyVolumes);
        }
        return { open: [...s.open, plane], active: plane };
      });
    },
    [studyData],
  );

  const handleSliceChange = useCallback((plane: 'axial' | 'sagittal' | 'coronal', slice: number) => {
    setCurrentSlice(prev => ({ ...prev, [plane]: slice }));
  }, []);

  const pixelSpacing = useMemo(() => {
    if (studyData) {
      const vol = studyData.volumes[studyViewport.active];
      if (vol) return { x: vol.header.pixDims[1], y: vol.header.pixDims[2] };
    }
    if (header?.pixDims) return { x: header.pixDims[1] || 1, y: header.pixDims[2] || 1 };
    return { x: 1, y: 1 };
  }, [studyData, studyViewport.active, header]);

  const handlePlaneRequest = useCallback(
    (plane: Plane) => {
      if (studyData) selectStudyPlane(plane);
    },
    [studyData, selectStudyPlane],
  );

  const resolveDefaultWindowLevel = useCallback(
    (viewportId: Plane): WindowLevel => {
      const vol = studyData?.volumes[viewportId];
      if (vol) return vol.defaultWindowLevel;
      return NIFTI_DEFAULT_WINDOW_LEVEL;
    },
    [studyData],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const MIN_RIGHT = 160;
      const MIN_CENTER = 320;
      const totalW = window.innerWidth;
      const rect = document.body.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (rightResizing.current) {
        const rawRight = Math.max(MIN_RIGHT, totalW - x);
        const maxRight = Math.max(MIN_RIGHT, totalW - MIN_CENTER);
        const newRight = Math.min(rawRight, maxRight);
        setRightWidth(newRight);
      }
    };

    const onMouseUp = () => {
      rightResizing.current = false;
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mouseleave', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mouseleave', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, []);

  const handleMeasurementAdd = useCallback(
    (measurement: Measurement) => {
      if (currentGroupIdRef.current && protocol) {
        const lineStepCount = protocol.steps.filter((step) => step.primitive === 'line' || step.primitive === 'distance').length;
        const pointStepCount = protocol.steps.filter((step) => step.primitive === 'point').length;
        const counts = groupCountsRef.current;

        if ((measurement.type === 'distance' || measurement.type === 'line') && counts.distanceCount >= lineStepCount) return;
        if (measurement.type === 'perpendicular' && counts.perpCount >= pointStepCount) return;

        // Increment synchronously so the next invocation sees the updated count
        // regardless of whether React has committed the state update yet.
        if (measurement.type === 'distance' || measurement.type === 'line') {
          counts.distanceCount += 1;
        } else if (measurement.type === 'perpendicular') {
          counts.perpCount += 1;
        }
      }

      const stamped: Measurement = {
        ...measurement,
        timestamp: measurement.timestamp || new Date().toISOString(),
      };
      let label = stamped.label;
      if (!label) {
        if (protocol && activeStep && measurementMatchesPrimitive(stamped, activeStep.primitive)) {
          label = activeStep.label;
        } else if (stamped.type === 'perpendicular') {
          const perpCount = measurements.filter(
            (m) => m.type === 'perpendicular' && m.groupId === currentGroupIdRef.current,
          ).length;
          if (protocol && perpCount < protocol.steps.length - 1) {
            label = protocol.steps[perpCount + 1]?.label || `Perp ${perpCount + 1}`;
          } else {
            label = `Perp ${perpCount + 1}`;
          }
        } else if (protocol && currentGroupIdRef.current) {
          const lineCount = measurements.filter(
            (m) => (m.type === 'distance' || m.type === 'line') && m.groupId === currentGroupIdRef.current,
          ).length;
          label = protocol.steps[lineCount]?.label || activeStep?.label;
        } else if (activeStep) {
          label = activeStep.label;
        } else {
          const baseLabel =
            stamped.type === 'line'
              ? 'Line'
              : stamped.type === 'distance'
                ? 'Distance'
                : stamped.type === 'angle'
                  ? 'Angle'
                  : stamped.type.charAt(0).toUpperCase() + stamped.type.slice(1);
          const sameTypeCount = measurements.filter(
            (m) => m.type === stamped.type && m.groupId === currentGroupIdRef.current,
          ).length;
          label = `${baseLabel} ${sameTypeCount + 1}`;
        }
      }
      const groupedMeasurement = {
        ...stamped,
        patientId: stamped.patientId ?? studyData?.patientId ?? undefined,
        patientName: stamped.patientName ?? studyData?.patientName ?? undefined,
        studyName: stamped.studyName ?? studyData?.studyName ?? undefined,
        sequenceName:
          stamped.sequenceName ??
          (studyData?.volumes[stamped.plane]?.seriesDescription?.trim() || stamped.plane),
        laterality: stamped.laterality ?? studyData?.laterality ?? undefined,
        groupId: currentGroupIdRef.current ?? undefined,
        label,
        workflowStepId:
          protocol && activeStep && measurementMatchesPrimitive(stamped, activeStep.primitive)
            ? activeStep.id
            : undefined,
      };
      if (
        sessionMeasurementMode &&
        sessionAnnotator &&
        onCommitSessionAnnotation &&
        studyData &&
        patientStorageKey
      ) {
        onCommitSessionAnnotation(buildSessionAnnotationRow(groupedMeasurement, studyData, patientStorageKey, sessionAnnotator));
      } else if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
        onPatientMeasurementsUpdate((prev) => [...prev, groupedMeasurement]);
      } else if (!sessionMeasurementMode) {
        setLocalMeasurements((prev) => [...prev, groupedMeasurement]);
      }

      const shouldDeferPointCompletion =
        activeStep?.primitive === 'point' && groupedMeasurement.type === 'perpendicular';
      if (protocol && activeStep && measurementMatchesPrimitive(groupedMeasurement, activeStep.primitive) && !shouldDeferPointCompletion) {
        const recordedPoints =
          activeStep.primitive === 'point' && groupedMeasurement.type === 'perpendicular' && groupedMeasurement.points.length >= 2
            ? [groupedMeasurement.points[1]]
            : groupedMeasurement.points;

        setWorkflow(prev =>
          recordStepResult(prev, protocol, {
            primitive: activeStep.primitive,
            points: recordedPoints,
            slice: groupedMeasurement.slice,
            imageScale: groupedMeasurement.imageScale,
          }),
        );
      }
    },
    [
      protocol,
      activeStep,
      sessionMeasurementMode,
      archiveMeasurementMode,
      sessionAnnotator,
      onCommitSessionAnnotation,
      studyData,
      patientStorageKey,
      onPatientMeasurementsUpdate,
      measurements,
      currentGroupId,
    ],
  );

  const handleMeasurementUpdate = useCallback(
    (id: string, newPoints: PointUpdater, newValue?: string, imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number }) => {
      const lengthValue = newValue;

      if (sessionMeasurementMode && onUpdateSessionAnnotation) {
        const parsed = lengthValue !== undefined ? splitValueUnits(lengthValue) : null;
        
        let resolvedPointsForWorkflow: { x: number; y: number }[] = [];

        onUpdateSessionAnnotation(id, (row: SessionAnnotationRow) => {
          const resolved = typeof newPoints === 'function' ? newPoints(row.points) : newPoints;
          resolvedPointsForWorkflow = resolved;
          return {
            ...row,
            points: resolved.map((p) => ({ x: p.x, y: p.y })),
            value: parsed ? parsed.value : row.value,
            units: parsed ? parsed.units : row.units,
            timestamp: new Date().toISOString(),
            imageScale: imageScale ?? row.imageScale,
          };
        });

        // Recalculate dependent perpendiculars in session mode so they
        // follow the baseline (the repositioning effect skips perpendiculars
        // whose baselines are remapped in the same batch to avoid conflicts).
        const updatedBaseLine = measurements.find((m) => m.id === id);
        if (
          updatedBaseLine &&
          (updatedBaseLine.type === 'distance' || updatedBaseLine.type === 'line') &&
          updatedBaseLine.points.length >= 2
        ) {
          const resolvedNew = typeof newPoints === 'function' ? newPoints(updatedBaseLine.points) : updatedBaseLine.points;
          const p0 = resolvedNew[0];
          const p1 = resolvedNew[1];
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            const lineX = dx / len;
            const lineY = dy / len;
            const perpX = -dy / len;
            const perpY = dx / len;

            // Old baseline geometry to compute invariant t
            const oldP0 = updatedBaseLine.points[0];
            const oldP1 = updatedBaseLine.points[1];
            const oldDx = oldP1.x - oldP0.x;
            const oldDy = oldP1.y - oldP0.y;
            const oldLen = Math.hypot(oldDx, oldDy) || 1;
            const scaleFactor = len / oldLen;

            const perps = measurements.filter(
              (m) => m.type === 'perpendicular' && m.baseLineId === id && m.points.length >= 2,
            );
            for (const perp of perps) {
              const oldAnchor = perp.points[0];
              const t = oldLen > 0
                ? Math.max(
                    0,
                    Math.min(
                      1,
                      ((oldAnchor.x - oldP0.x) * (oldDx / oldLen) +
                        (oldAnchor.y - oldP0.y) * (oldDy / oldLen)) /
                        oldLen,
                    ),
                  )
                : 0.5;
              const newAnchorX = p0.x + lineX * t * len;
              const newAnchorY = p0.y + lineY * t * len;

              const stubDx = perp.points[1].x - perp.points[0].x;
              const stubDy = perp.points[1].y - perp.points[0].y;
              const stubLen = Math.hypot(stubDx, stubDy) || 1;
              const sign = stubDx * perpX + stubDy * perpY >= 0 ? 1 : -1;
              const scaledStubLen = stubLen * scaleFactor;

              onUpdateSessionAnnotation(perp.id, (row: SessionAnnotationRow) => ({
                ...row,
                points: [
                  { x: newAnchorX, y: newAnchorY },
                  { x: newAnchorX + perpX * scaledStubLen * sign, y: newAnchorY + perpY * scaledStubLen * sign },
                ],
                timestamp: new Date().toISOString(),
                imageScale: imageScale ?? row.imageScale,
              }));
            }
          }
        }

        const target = measurements.find((m) => m.id === id);
        const matchedStep = protocol && target ? protocol.steps.find((step) => target.workflowStepId === step.id || (target.label === step.label && measurementMatchesPrimitive(target, step.primitive))) : null;

        if (protocol && matchedStep && target) {
          const resolvedFallback = typeof newPoints === 'function' ? newPoints(target.points) : newPoints;
          const recordedPoints =
            matchedStep.primitive === 'point' && target.type === 'perpendicular' && resolvedFallback.length >= 2
              ? [resolvedFallback[1]]
              : resolvedFallback;
          
          setWorkflow((prev) => ({
            ...prev,
            stepResults: {
              ...prev.stepResults,
              [matchedStep.id]: {
                primitive: matchedStep.primitive,
                points: recordedPoints,
                slice: target.slice,
                imageScale,
              },
            },
          }));
        }
        return;
      }

      const updater = (prev: Measurement[]) => {
        const updated = prev.map((m) => {
          if (m.id !== id) return m;
          const resolvedPoints = typeof newPoints === 'function' ? newPoints(m.points) : newPoints;
          return {
            ...m,
            points: resolvedPoints,
            // Fallback generically to old m.value if we don't have a new explicit text value
            value: lengthValue !== undefined ? lengthValue : m.value,
            // Always stamp the latest imageScale so CSV export / protocol compute
            // recovers the same image-pixel positions regardless of viewport size.
            imageScale: imageScale ?? m.imageScale,
          };
        });

        const baseLine = updated.find((m) => m.id === id);
        if (!baseLine || (baseLine.type !== 'distance' && baseLine.type !== 'line')) {
          return updated;
        }

        if (baseLine.points.length < 2) {
          return updated;
        }

        // --- new baseline geometry (after remap) ---
        const p0 = baseLine.points[0];
        const p1 = baseLine.points[1];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) {
          return updated;
        }

        const lineX = dx / len;
        const lineY = dy / len;
        const perpX = -dy / len;
        const perpY = dx / len;

        // --- old baseline geometry (before remap, from prev state) ---
        const oldBaseLine = prev.find((m) => m.id === id);
        const oldP0 = oldBaseLine?.points?.[0] ?? p0;
        const oldP1 = oldBaseLine?.points?.[1] ?? p1;
        const oldDx = oldP1.x - oldP0.x;
        const oldDy = oldP1.y - oldP0.y;
        const oldLen = Math.hypot(oldDx, oldDy) || 1;
        const scaleFactor = len / oldLen;

        return updated.map((m) => {
          if (m.type !== 'perpendicular' || m.baseLineId !== id || m.points.length < 2) {
            return m;
          }

          const oldAnchor = m.points[0];

          // Project old anchor onto the OLD baseline to find t (invariant fraction)
          const t = oldLen > 0
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((oldAnchor.x - oldP0.x) * (oldDx / oldLen) +
                    (oldAnchor.y - oldP0.y) * (oldDy / oldLen)) /
                    oldLen,
                ),
              )
            : 0.5;

          // Apply t to the NEW baseline for the correct new anchor
          const newAnchorX = p0.x + lineX * t * len;
          const newAnchorY = p0.y + lineY * t * len;

          const stubDx = m.points[1].x - m.points[0].x;
          const stubDy = m.points[1].y - m.points[0].y;
          const stubLen = Math.hypot(stubDx, stubDy) || 1;
          const sign = stubDx * perpX + stubDy * perpY >= 0 ? 1 : -1;

          // Scale the stub length to match the display size change
          const scaledStubLen = stubLen * scaleFactor;

          return {
            ...m,
            points: [
              { x: newAnchorX, y: newAnchorY },
              { x: newAnchorX + perpX * scaledStubLen * sign, y: newAnchorY + perpY * scaledStubLen * sign },
            ],
            // Recalculated at the same display size as the baseline update;
            // stamp the same imageScale so CSV export stays invariant.
            imageScale: imageScale ?? m.imageScale,
          };
        });
      };

      if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
        onPatientMeasurementsUpdate(updater);
      } else {
        setLocalMeasurements(updater);
      }

      // Update matched protocol step if active
      const target = measurements.find((m) => m.id === id);
      const matchedStep = protocol && target ? protocol.steps.find((step) => target.workflowStepId === step.id || (target.label === step.label && measurementMatchesPrimitive(target, step.primitive))) : null;

      if (protocol && matchedStep && target) {
        const resolvedFallback = typeof newPoints === 'function' ? newPoints(target.points) : newPoints;
        const recordedPoints =
          matchedStep.primitive === 'point' && target.type === 'perpendicular' && resolvedFallback.length >= 2
            ? [resolvedFallback[1]]
            : resolvedFallback;
            
        setWorkflow((prev) => ({
          ...prev,
          stepResults: {
            ...prev.stepResults,
            [matchedStep.id]: {
              primitive: matchedStep.primitive,
              points: recordedPoints,
              slice: target.slice,
              imageScale,
            },
          },
        }));
      }
    },
    [
      measurements,
      protocol,
      activeStep,
      sessionMeasurementMode,
      onUpdateSessionAnnotation,
      archiveMeasurementMode,
      onPatientMeasurementsUpdate,
    ],
  );

  const handleMeasurementDelete = useCallback(
    (id: string) => {
      const target = measurements.find((m) => m.id === id);
      const updater = (prev: Measurement[]) => prev.filter((m) => m.id !== id && m.baseLineId !== id);

      if (sessionMeasurementMode && onDeleteSessionAnnotation) {
        onDeleteSessionAnnotation(id);
      } else if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
        onPatientMeasurementsUpdate(updater);
      } else {
        setLocalMeasurements(updater);
      }

      // Decrement the ref-based counter so the limiting check stays accurate.
      if (target) {
        if (target.type === 'distance' || target.type === 'line') {
          groupCountsRef.current.distanceCount = Math.max(0, groupCountsRef.current.distanceCount - 1);
        } else if (target.type === 'perpendicular') {
          groupCountsRef.current.perpCount = Math.max(0, groupCountsRef.current.perpCount - 1);
        }
      }

      if (protocol && target) {
        const stepId =
          target.workflowStepId ||
          protocol.steps.find((s) => s.label === target.label && measurementMatchesPrimitive(target, s.primitive))?.id;
        if (stepId) {
          const stepIndex = protocol.steps.findIndex((step) => step.id === stepId);
          setWorkflow((prev) => {
            const nextResults = { ...prev.stepResults };
            delete nextResults[stepId];
            return { ...prev, stepResults: nextResults, activeStepIndex: stepIndex >= 0 ? stepIndex : prev.activeStepIndex };
          });
        }
      }
    },
    [
      measurements,
      protocol,
      sessionMeasurementMode,
      archiveMeasurementMode,
      onDeleteSessionAnnotation,
      onPatientMeasurementsUpdate,
    ],
  );

  const handleWorkflowStepRedo = useCallback(
    (stepId: string) => {
      const target = measurements.find((m) => m.workflowStepId === stepId) ??
        (protocol ? measurements.find((m) => m.label === protocol.steps.find((s) => s.id === stepId)?.label) : undefined);
      if (!target) return;
      handleMeasurementDelete(target.id);
    },
    [handleMeasurementDelete, measurements, protocol],
  );

  const handleWorkflowReset = useCallback(() => {
    if (!protocol) return;
    const protocolStepIds = new Set(protocol.steps.map((step) => step.id));
    const activeGroupId = currentGroupIdRef.current;
    const shouldRemove = (measurement: Measurement) => {
      if (activeGroupId && measurement.groupId === activeGroupId) return true;
      if (measurement.workflowStepId && protocolStepIds.has(measurement.workflowStepId)) return true;
      return false;
    };

    const idsToRemove = measurements.filter(shouldRemove).map((measurement) => measurement.id);
    if (idsToRemove.length === 0) {
      setWorkflow((prev) => ({ ...prev, protocolId: protocol.id, activeStepIndex: 0, stepResults: {} }));
      return;
    }

    const removeByIds = (prev: Measurement[]) => prev.filter((measurement) => !idsToRemove.includes(measurement.id) && !idsToRemove.includes(measurement.baseLineId ?? ''));

    if (sessionMeasurementMode && onDeleteSessionAnnotation) {
      for (const id of idsToRemove) onDeleteSessionAnnotation(id);
    } else if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
      onPatientMeasurementsUpdate(removeByIds);
    } else {
      setLocalMeasurements(removeByIds);
    }

    setWorkflow((prev) => ({ ...prev, protocolId: protocol.id, activeStepIndex: 0, stepResults: {} }));
    groupCountsRef.current = { distanceCount: 0, perpCount: 0 };
  }, [
    archiveMeasurementMode,
    measurements,
    onDeleteSessionAnnotation,
    onPatientMeasurementsUpdate,
    protocol,
    sessionMeasurementMode,
  ]);

  const handleResetViewport = useCallback((plane: Plane) => {
    const mid = initialSliceIndex.current[plane];
    setCurrentSlice((prev) => ({ ...prev, [plane]: mid }));
  }, []);

  const currentViewPlane: Plane = 'axial';
  const activeVolumeMeta = studyData ? studyData.volumes[studyViewport.active] : null;

  const applyWeighting = useCallback((pixelValue: number): number => {
    switch (weighting) {
      case 'T1':
        return Math.min(255, pixelValue * 1.2);
      case 'T2':
        return Math.min(255, pixelValue * 0.8 + 30);
      case 'PD':
        return Math.min(255, pixelValue * 1.0);
      case 'CT':
        return Math.min(255, Math.max(0, pixelValue - 20) * 1.5);
      case 'Custom':
        const psiFactor = (customWeighting.psi || 0) / 180;
        return Math.min(255, pixelValue * (1 + psiFactor));
      default:
        return pixelValue;
    }
  }, [weighting, customWeighting]);

  const loaded = Boolean(imageData && header);
  const sequenceWindows = useMemo(() => {
    if (!studyData) return undefined;
    const order: Plane[] = ['axial', 'sagittal', 'coronal'];
    return order
      .filter((p) => Boolean(studyData.volumes[p]) && studyViewport.open.includes(p))
      .map((p) => {
        const v = studyData.volumes[p]!;
        return {
          id: p,
          label: p,
          imageData: v.imageData,
          header: v.header,
          defaultWindowLevel: v.defaultWindowLevel,
        };
      });
  }, [studyData, studyViewport.open]);

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-h-0 relative">
        {loaded ? (
          <ViewportGrid
            imageData={imageData!}
            header={header!}
            currentSlice={currentSlice}
            viewPlane={currentViewPlane}
            onSliceChange={handleSliceChange}
            resolveDefaultWindowLevel={resolveDefaultWindowLevel}
            activeTool={effectiveTool}
            measurements={measurements}
            onMeasurementAdd={handleMeasurementAdd}
            onMeasurementUpdate={handleMeasurementUpdate}
            selectedMeasurementId={selectedMeasurementId}
            onMeasurementSelect={onMeasurementSelect}
            applyWeighting={applyWeighting}
            showCrosshair={showCrosshair}
            measurementUnits={measurementUnits}
            sequenceWindows={sequenceWindows}
            onWindowFocus={(plane) =>
              setStudyViewport((s) => (s.open.includes(plane) ? { ...s, active: plane } : s))
            }
            onHideWindow={closeStudyPlaneViewport}
            onResetViewport={handleResetViewport}
            pixelSpacing={pixelSpacing}
            onDisplaySizeChange={handleViewportDisplaySizeChange}
            referenceLineByPlane={referenceLineByPlane}
            onReferenceLineClick={handleReferenceLineClick}
            allowedDrawPlane={activeStep?.plane ?? protocol?.requiredPlane}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <svg className="mx-auto h-16 w-16 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-300">No image loaded</h3>
              <p className="mt-2 text-sm text-gray-500">Load imaging data (.nii or .nii.gz) to begin</p>
            </div>
          </div>
        )}

        {studyData && (
          <div className="absolute top-2 left-2 z-20 bg-black/60 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200">
            <div>
              Patient: <span className="text-gray-100">{studyData.patientId || 'unknown-patient'}</span>
              {' · '}
              {studyData.patientName || 'Unknown Patient'}
            </div>
            <div>
              Study: <span className="text-gray-100">{studyData.studyName}</span>
            </div>
            <div>
              Knee: <span className="text-gray-100 capitalize">{studyData.laterality}</span>
            </div>
            <div>
              Sequence: <span className="text-gray-100 capitalize">{studyViewport.active}</span>
              {activeVolumeMeta?.seriesDescription ? ` (${activeVolumeMeta.seriesDescription})` : ''}
            </div>
          </div>
        )}

        {/* Floating bottom-right tool bar */}
        <div className="absolute bottom-4 right-4 flex items-center space-x-2" style={{ zIndex: 9999 }}>
          <ToolTip label="Select">
            <Button
              size="sm"
              variant={effectiveTool === 'none' ? 'default' : 'ghost'}
              className={effectiveTool === 'none' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('none')}
              aria-label="Select tool"
            >
              <MousePointer className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Perpendicular">
            <Button
              size="sm"
              variant={effectiveTool === 'perpendicular' ? 'default' : 'ghost'}
              className={effectiveTool === 'perpendicular' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('perpendicular')}
              aria-label="Perpendicular tool"
            >
              <CornerDownLeft className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Distance">
            <Button
              size="sm"
              variant={effectiveTool === 'distance' ? 'default' : 'ghost'}
              className={effectiveTool === 'distance' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('distance')}
              aria-label="Distance tool"
            >
              <Ruler className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Angle">
            <Button
              size="sm"
              variant={effectiveTool === 'angle' ? 'default' : 'ghost'}
              className={effectiveTool === 'angle' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('angle')}
              aria-label="Angle tool"
            >
              <Triangle className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Point">
            <Button
              size="sm"
              variant={effectiveTool === 'point' ? 'default' : 'ghost'}
              className={effectiveTool === 'point' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('point')}
              aria-label="Point tool"
            >
              <Dot className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Ellipse">
            <Button
              size="sm"
              variant={effectiveTool === 'ellipse' ? 'default' : 'ghost'}
              className={effectiveTool === 'ellipse' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('ellipse')}
              aria-label="Ellipse tool"
            >
              <CircleIcon className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Freehand">
            <Button
              size="sm"
              variant={effectiveTool === 'freehand' ? 'default' : 'ghost'}
              className={effectiveTool === 'freehand' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool('freehand')}
              aria-label="Freehand tool"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </ToolTip>

          <ToolTip label="Pan">
            <Button
              size="sm"
              variant={effectiveTool === 'pan' ? 'default' : 'ghost'}
              className={effectiveTool === 'pan' ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => selectTool(effectiveTool === 'pan' ? 'none' : 'pan')}
              aria-label="Pan tool"
            >
              <Move className="h-4 w-4" />
            </Button>
          </ToolTip>

        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        onMouseDown={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onTouchStart={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => { setRightWidth(288); }}
        className="w-8 -ml-4 -mr-4 cursor-col-resize relative"
        style={{ zIndex: 40 }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-transparent hover:bg-gray-700" />
      </div>

      <div style={{ width: rightWidth }} className="flex-shrink-0">
        <WeightingPanel
          weighting={weighting}
          onWeightingChange={setWeighting}
          customWeighting={customWeighting}
          onCustomWeightingChange={(p) => setCustomWeighting(p)}
          onFileLoad={onFileLoad}
          onStudyLoad={onStudyLoad}
          studyData={studyData}
          openStudyPlanes={studyViewport.open}
          activeStudyPlane={studyViewport.active}
          onStudyPlaneToggle={toggleStudyPlaneViewport}
          workflow={workflow}
          onWorkflowChange={setWorkflow}
          measurements={measurements}
          selectedMeasurementId={selectedMeasurementId}
          onMeasurementSelect={onMeasurementSelect}
          onStepRedo={handleWorkflowStepRedo}
          onResetMeasurements={handleWorkflowReset}
          pixelSpacing={pixelSpacing}
          onPlaneRequest={handlePlaneRequest}
          imageScale={imageScale}
        />
      </div>
    </div>
  );
}