import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as nifti from 'nifti-reader-js';
import { ViewportGrid } from './ViewportGrid';
import { WeightingPanel } from './WeightingPanel';
import { Button } from './ui/button';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Label } from './ui/label';
import { MousePointer, Circle as CircleIcon, Pencil, Move } from 'lucide-react';
import type { DicomStudy } from './dicom/DicomStudy';
import type { DicomVolume, Plane } from './dicom/DicomLoader';
import {
  initialWorkflowState,
  recordStepResult,
  WorkflowState,
} from './measurement/MeasurementWorkflow';
import {
  getProtocol,
  Primitive,
} from './measurement/MeasurementProtocols';
import type { SessionAnnotator, SessionAnnotationRow } from '@/app/lib/sessionAnnotationCsv';
import { splitValueUnits } from '@/app/lib/sessionAnnotationCsv';

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
}

export type MeasurementTool =
  | 'none'
  | 'distance'
  | 'angle'
  | 'ellipse'
  | 'closedCurve'
  | 'freehand'
  | 'pan'
  | 'line'
  | 'point';
export type WeightingType = 'T1' | 'T2' | 'PD' | 'CT' | 'Custom';

export interface WindowLevel {
  window: number;
  level: number;
}

/** Default W/L for normalized 0–255 NIfTI display (per-viewport state lives in `Viewport`). */
const NIFTI_DEFAULT_WINDOW_LEVEL: WindowLevel = { window: 255, level: 128 };

export interface Measurement {
  id: string;
  type: MeasurementTool;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  value?: string;
  /** ISO-8601 when captured; set automatically on add for persisted patients. */
  timestamp?: string;
}

interface MedicalImageViewerExtras {
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  studyData?: DicomStudy | null;
  onStudyLoad?: (study: DicomStudy) => void;
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
}

/** Map a protocol primitive to one of the existing viewport tools. */
function primitiveToTool(p: Primitive): MeasurementTool {
  switch (p) {
    case 'line':
      return 'line';
    case 'angle':
      return 'angle';
    case 'point':
      return 'point';
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
  if (primitive === 'point') return measurement.type === 'point';
  return false;
}

function buildSessionAnnotationRow(
  m: Measurement,
  studyData: DicomStudy,
  sourcePatientKey: string,
  annotator: SessionAnnotator,
): SessionAnnotationRow {
  const vol = studyData.volumes[m.plane];
  const sequenceName = (vol?.seriesDescription && vol.seriesDescription.trim()) || m.plane;
  const { value, units } = splitValueUnits(m.value);
  const ts = m.timestamp || new Date().toISOString();
  return {
    sourcePatientKey,
    annotationId: crypto.randomUUID(),
    patientId: studyData.patientId || 'unknown',
    sequenceName,
    plane: m.plane,
    measurementType: m.type,
    value,
    units,
    sliceIndex: m.slice,
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
}: MedicalImageViewerProps & MedicalImageViewerExtras) {
  const [imageData, setImageData] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<any>(null);
  const [dataRange, setDataRange] = useState<{ min: number; max: number }>({ min: 0, max: 255 });
  const [currentSlice, setCurrentSlice] = useState({ axial: 0, sagittal: 0, coronal: 0 });
  /** Middle slice at last sequence load (`Math.floor(totalSlices/2)`), per plane; independent A/S/C. */
  const initialSliceIndex = useRef({ axial: 0, sagittal: 0, coronal: 0 });
  const [activeTool, setActiveTool] = useState<MeasurementTool>('pan');
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
  const prevStudyDataRef = useRef<DicomStudy | null>(null);

  const protocol = useMemo(() => getProtocol(workflow.protocolId), [workflow.protocolId]);
  const activeStep = protocol?.steps[workflow.activeStepIndex] ?? null;
  // When a workflow step is active, override the user-selected tool so the
  // correct primitive is always armed.
  const effectiveTool: MeasurementTool = activeStep
    ? primitiveToTool(activeStep.primitive)
    : activeTool;

  useEffect(() => {
    if (!niftiData) return;

    try {
      // All nifti-reader-js functions expect ArrayBuffer, not Uint8Array
      
      // Check if compressed (shouldn't be at this point, but just in case)
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
      
      // Parse data based on data type
      let typedData: number[];
      const datatypeCode = niftiHeader.datatypeCode;
      
      // NIFTI datatype codes
      // 2 = uint8, 4 = int16, 8 = int32, 16 = float32, 64 = float64, 512 = uint16
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
        // Default to Int16, most common for medical images
        console.warn(`Unknown datatype code ${datatypeCode}, defaulting to Int16`);
        typedData = Array.from(new Int16Array(niftiImage));
      }
      
      // Calculate min and max values from the actual data
      let min = Infinity;
      let max = -Infinity;
      
      for (let i = 0; i < typedData.length; i++) {
        const val = typedData[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      
      // Apply scl_slope and scl_inter if present
      const slope = niftiHeader.scl_slope || 1;
      const inter = niftiHeader.scl_inter || 0;
      
      if (slope !== 0 && slope !== 1) {
        min = min * slope + inter;
        max = max * slope + inter;
      }
      
      console.log('Data range:', { min, max, datatypeCode, slope, inter });
      console.log('Dimensions:', niftiHeader.dims);
      
      // Normalize data to 0-255 range for display
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

  // Load pixels from the active DICOM series. Viewer behavior stays axial-like for all sequences.
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

  /** Workflow / programmatic: ensure plane is open and focused (never closes). */
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

  /** Same state transition as clicking “x” on a viewer (single close path). */
  const closeStudyPlaneViewport = useCallback(
    (plane: Plane) => {
      if (!studyData?.volumes[plane]) return;
      setStudyViewport((s) => stateAfterClosingViewer(s, plane, studyData.volumes));
    },
    [studyData],
  );

  /** Sidebar plane buttons: true toggle open/closed. */
  const toggleStudyPlaneViewport = useCallback(
    (plane: Plane) => {
      if (!studyData?.volumes[plane]) {
        alert(
          `This study does not contain a ${plane} series. Available: ${Object.keys(
            studyData.volumes,
          ).join(', ') || 'none'}.`,
        );
        return;
      }
      setStudyViewport((s) => {
        if (s.open.includes(plane)) {
          return stateAfterClosingViewer(s, plane, studyData.volumes);
        }
        return { open: [...s.open, plane], active: plane };
      });
    },
    [studyData],
  );

  const handleSliceChange = useCallback((plane: 'axial' | 'sagittal' | 'coronal', slice: number) => {
    setCurrentSlice(prev => ({ ...prev, [plane]: slice }));
  }, []);

  /** Pixel spacing (mm/pixel) of whatever volume is currently in the viewer. */
  const pixelSpacing = useMemo(() => {
    if (studyData) {
      const vol = studyData.volumes[studyViewport.active];
      if (vol) return { x: vol.header.pixDims[1], y: vol.header.pixDims[2] };
    }
    if (header?.pixDims) return { x: header.pixDims[1] || 1, y: header.pixDims[2] || 1 };
    return { x: 1, y: 1 };
  }, [studyData, studyViewport.active, header]);

  /** Switch the active plane (and DICOM volume) the workflow is asking for. */
  const handlePlaneRequest = useCallback(
    (plane: Plane) => {
      if (studyData) selectStudyPlane(plane);
      // NIfTI / axial-only viewer: ignore sagittal/coronal view requests until plane switching is restored.
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

  // Resizer handlers (only right panel now)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const MIN_RIGHT = 160;
      const MIN_CENTER = 320; // ensure the viewport remains usable
      const totalW = window.innerWidth;
      const rect = document.body.getBoundingClientRect();
      const x = e.clientX - rect.left;

      if (rightResizing.current) {
        // compute right width measured from right edge and clamp so center stays visible
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
      const stamped: Measurement = {
        ...measurement,
        timestamp: measurement.timestamp || new Date().toISOString(),
      };
      if (
        sessionMeasurementMode &&
        sessionAnnotator &&
        onCommitSessionAnnotation &&
        studyData &&
        patientStorageKey
      ) {
        onCommitSessionAnnotation(
          buildSessionAnnotationRow(stamped, studyData, patientStorageKey, sessionAnnotator),
        );
      } else if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
        onPatientMeasurementsUpdate((prev) => [...prev, stamped]);
      } else if (!sessionMeasurementMode) {
        setLocalMeasurements((prev) => [...prev, stamped]);
      }

      // If a workflow step is active and the drawn primitive matches what the
      // step expects, fold it into workflow state so the checklist advances and
      // the final clinical value can be computed.
      if (protocol && activeStep && measurementMatchesPrimitive(stamped, activeStep.primitive)) {
        setWorkflow(prev =>
          recordStepResult(prev, protocol, {
            primitive: activeStep.primitive,
            points: stamped.points,
            slice: stamped.slice,
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
    ],
  );

  const handleMeasurementDelete = useCallback(
    (id: string) => {
      if (sessionMeasurementMode && onDeleteSessionAnnotation) {
        onDeleteSessionAnnotation(id);
      } else if (archiveMeasurementMode && onPatientMeasurementsUpdate) {
        onPatientMeasurementsUpdate((prev) => prev.filter((m) => m.id !== id));
      } else {
        setLocalMeasurements((prev) => prev.filter((m) => m.id !== id));
      }
    },
    [
      sessionMeasurementMode,
      archiveMeasurementMode,
      onDeleteSessionAnnotation,
      onPatientMeasurementsUpdate,
    ],
  );

  /** Restore slice index to middle for one plane; viewport clears zoom/pan/WL/brightness/drafts via `Viewport` reset. */
  const handleResetViewport = useCallback((plane: Plane) => {
    const mid = initialSliceIndex.current[plane];
    setCurrentSlice((prev) => ({ ...prev, [plane]: mid }));
  }, []);

  // Always render with axial interaction/view behavior regardless of which
  // sequence (A/S/C) is loaded. Sequence identity is shown in metadata labels.
  const currentViewPlane: Plane = 'axial';
  const activeVolumeMeta = studyData ? studyData.volumes[studyViewport.active] : null;

  const applyWeighting = useCallback((pixelValue: number): number => {
    // DREAMER algorithm simulation - in reality this would be much more complex
    // This is a simplified representation of tissue weighting
    switch (weighting) {
      case 'T1':
        // T1-weighted: Fat is bright, water is dark
        return Math.min(255, pixelValue * 1.2);
      case 'T2':
        // T2-weighted: Water is bright, fat is intermediate
        return Math.min(255, pixelValue * 0.8 + 30);
      case 'PD':
        // Proton density: Both fat and water are bright
        return Math.min(255, pixelValue * 1.0);
      case 'CT':
        // CT/Hard tissue: Bone is bright
        return Math.min(255, Math.max(0, pixelValue - 20) * 1.5);
      case 'Custom':
        // Custom weighting based on single tissue weight psi (0-180)
        const psiFactor = (customWeighting.psi || 0) / 180; // normalized 0..1
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
            applyWeighting={applyWeighting}
            showCrosshair={showCrosshair}
            sequenceWindows={sequenceWindows}
            onWindowFocus={(plane) =>
              setStudyViewport((s) => (s.open.includes(plane) ? { ...s, active: plane } : s))
            }
            onHideWindow={closeStudyPlaneViewport}
            onResetViewport={handleResetViewport}
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
              Sequence: <span className="text-gray-100 capitalize">{studyViewport.active}</span>
              {activeVolumeMeta?.seriesDescription ? ` (${activeVolumeMeta.seriesDescription})` : ''}
            </div>
          </div>
        )}

        {/* Floating bottom-right tool bar */}
        <div className="absolute bottom-4 right-4 flex items-center space-x-2" style={{ zIndex: 9999 }}>
          <Button
            size="sm"
            variant={activeTool === 'none' ? 'default' : 'ghost'}
            className={activeTool === 'none' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('none')}
            aria-label="Select tool"
          >
            <MousePointer className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'ellipse' ? 'default' : 'ghost'}
            className={activeTool === 'ellipse' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('ellipse')}
            aria-label="Ellipse tool"
          >
            <CircleIcon className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'freehand' ? 'default' : 'ghost'}
            className={activeTool === 'freehand' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool('freehand')}
            aria-label="Freehand tool"
          >
            <Pencil className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant={activeTool === 'pan' ? 'default' : 'ghost'}
            className={activeTool === 'pan' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool(v => v === 'pan' ? 'none' : 'pan')}
            aria-label="Pan tool"
          >
            <Move className="h-4 w-4" />
          </Button>

        </div>
      </div>
      {/* right resizer: larger interactive hit area with thin visual line */}
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
          pixelSpacing={pixelSpacing}
          onPlaneRequest={handlePlaneRequest}
        />
      </div>
    </div>
  );
}