import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as nifti from 'nifti-reader-js';
import { ViewportGrid } from './ViewportGrid';
import { Toolbar } from './Toolbar';
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

function preferredAvailablePlane(volumes: Partial<Record<Plane, DicomVolume>>): Plane | null {
  const order: Plane[] = ['axial', 'sagittal', 'coronal'];
  for (const p of order) {
    if (volumes[p]) return p;
  }
  const keys = Object.keys(volumes) as Plane[];
  return keys[0] ?? null;
}

export interface MedicalImageViewerProps {
  niftiData?: ArrayBuffer | null;
}

export type MeasurementTool =
  | 'none'
  | 'distance'
  | 'angle'
  | 'perpendicular'
  | 'pan'
  | 'line'
  | 'point';
export type WeightingType = 'T1' | 'T2' | 'PD' | 'CT' | 'Custom';

export interface WindowLevel {
  window: number;
  level: number;
}

export interface Measurement {
  id: string;
  type: MeasurementTool;
  points: { x: number; y: number }[];
  slice: number;
  plane: 'axial' | 'sagittal' | 'coronal';
  value?: string;
  baseLineId?: string;
  groupId?: string;
  label?: string;
}

interface MedicalImageViewerExtras {
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  studyData?: DicomStudy | null;
  onStudyLoad?: (study: DicomStudy) => void;
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
  if (primitive === 'point') return measurement.type === 'point' || measurement.type === 'perpendicular';
  return false;
}

export function MedicalImageViewer({
  niftiData,
  onFileLoad,
  studyData = null,
  onStudyLoad,
}: MedicalImageViewerProps & MedicalImageViewerExtras) {
  const [imageData, setImageData] = useState<Uint8Array | null>(null);
  const [header, setHeader] = useState<any>(null);
  const [dataRange, setDataRange] = useState<{ min: number; max: number }>({ min: 0, max: 255 });
  const [currentSlice, setCurrentSlice] = useState({ axial: 0, sagittal: 0, coronal: 0 });
  const [windowLevel, setWindowLevel] = useState<WindowLevel>({ window: 400, level: 40 });
  const [activeTool, setActiveTool] = useState<MeasurementTool>('pan');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [weighting, setWeighting] = useState<WeightingType>('T1');
  // single psi slider for custom weighting (0-180 degrees)
  const [customWeighting, setCustomWeighting] = useState({ psi: 90 });
  // Processing mode for contrasts
  const [contrastMode, setContrastMode] = useState<'disk' | 'gpu'>('disk');
  // UI helpers
  const [showCrosshair, setShowCrosshair] = useState<boolean>(false);
  // resizable right panel width (px)
  const [rightWidth, setRightWidth] = useState<number>(288); // default w-72 (18rem)
  const rightResizing = useRef(false);
  // Measurement workflow (TT-TG, Insall–Salvati, etc.)
  const [workflow, setWorkflow] = useState<WorkflowState>(initialWorkflowState);
  /** Which DICOM series is loaded (native acquisition). Independent from Open Planes (MPR view). */
  const [activeStudyPlane, setActiveStudyPlane] = useState<Plane>('axial');
  const [hiddenStudyPlanes, setHiddenStudyPlanes] = useState<Set<Plane>>(new Set());
  const prevStudyDataRef = useRef<DicomStudy | null>(null);

  const protocol = useMemo(() => getProtocol(workflow.protocolId), [workflow.protocolId]);
  const activeStep = protocol?.steps[workflow.activeStepIndex] ?? null;
  // When a workflow step is active, override the user-selected tool so the
  // correct primitive is always armed.
  const effectiveTool: MeasurementTool = activeTool;

  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const currentGroupIdRef = useRef<string | null>(null);

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
      
      // Set initial slices to middle
      setCurrentSlice({
        axial: Math.floor(niftiHeader.dims[3] / 2),
        sagittal: Math.floor(niftiHeader.dims[1] / 2),
        coronal: Math.floor(niftiHeader.dims[2] / 2),
      });
      
      // Set default window/level based on normalized range (0-255)
      setWindowLevel({ window: 255, level: 128 });
    } catch (error) {
      console.error('Error parsing NIfTI file:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Error parsing NIfTI file: ${errorMessage}\n\nPlease ensure it is a valid NIfTI format.`);
    }
  }, [niftiData]);

  useEffect(() => {
    if (studyData != null) return;
    setActiveStudyPlane('axial');
  }, [studyData]);

  // Load pixels from the active DICOM series. Viewer behavior stays axial-like for all sequences.
  useEffect(() => {
    if (!studyData) {
      prevStudyDataRef.current = null;
      setHiddenStudyPlanes(new Set());
      return;
    }

    if (prevStudyDataRef.current !== studyData) {
      prevStudyDataRef.current = studyData;
      setHiddenStudyPlanes(new Set());
      setCurrentSlice({
        axial: studyData.volumes.axial ? Math.floor(studyData.volumes.axial.sliceCount / 2) : 0,
        sagittal: studyData.volumes.sagittal ? Math.floor(studyData.volumes.sagittal.sliceCount / 2) : 0,
        coronal: studyData.volumes.coronal ? Math.floor(studyData.volumes.coronal.sliceCount / 2) : 0,
      });
    }

    let plane: Plane = activeStudyPlane;
    let vol = studyData.volumes[plane];
    if (!vol) {
      const p = preferredAvailablePlane(studyData.volumes);
      if (!p) return;
      plane = p;
      vol = studyData.volumes[p]!;
      setActiveStudyPlane(plane);
    }

    setHeader(vol.header);
    setImageData(vol.imageData);
    setDataRange(vol.dataRange);
    setWindowLevel(vol.defaultWindowLevel);
  }, [studyData, activeStudyPlane]);

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
      setActiveStudyPlane(plane);
      setHiddenStudyPlanes((prev) => {
        if (!prev.has(plane)) return prev;
        const next = new Set(prev);
        next.delete(plane);
        return next;
      });
    },
    [studyData],
  );

  const hideStudyPlane = useCallback(
    (plane: Plane) => {
      if (!studyData?.volumes[plane]) return;
      setHiddenStudyPlanes((prev) => {
        if (prev.has(plane)) return prev;
        const next = new Set(prev);
        next.add(plane);
        return next;
      });

      if (activeStudyPlane === plane) {
        const order: Plane[] = ['axial', 'sagittal', 'coronal'];
        const replacement = order.find((p) => p !== plane && studyData.volumes[p] && !hiddenStudyPlanes.has(p));
        if (replacement) setActiveStudyPlane(replacement);
      }
    },
    [studyData, activeStudyPlane, hiddenStudyPlanes],
  );

  const handleSliceChange = useCallback((plane: 'axial' | 'sagittal' | 'coronal', slice: number) => {
    setCurrentSlice(prev => ({ ...prev, [plane]: slice }));
  }, []);

  /** Pixel spacing (mm/pixel) of whatever volume is currently in the viewer. */
  const pixelSpacing = useMemo(() => {
    if (studyData) {
      const vol = studyData.volumes[activeStudyPlane];
      if (vol) return { x: vol.header.pixDims[1], y: vol.header.pixDims[2] };
    }
    if (header?.pixDims) return { x: header.pixDims[1] || 1, y: header.pixDims[2] || 1 };
    return { x: 1, y: 1 };
  }, [studyData, activeStudyPlane, header]);

  /** Switch the active plane (and DICOM volume) the workflow is asking for. */
  const handlePlaneRequest = useCallback(
    (plane: Plane) => {
      if (studyData) selectStudyPlane(plane);
      // NIfTI / axial-only viewer: ignore sagittal/coronal view requests until plane switching is restored.
    },
    [studyData, selectStudyPlane],
  );

  const handleWindowLevelChange = useCallback((wl: WindowLevel) => {
    setWindowLevel(wl);
  }, []);

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

  useEffect(() => {
    if (workflow.protocolId) {
      const id = `${workflow.protocolId}-${Date.now()}`;
      setCurrentGroupId(id);
      currentGroupIdRef.current = id;
    } else {
      setCurrentGroupId(null);
      currentGroupIdRef.current = null;
    }
  }, [workflow.protocolId]);

  const measurementsRef2 = useRef(measurements);
  useEffect(() => { measurementsRef2.current = measurements; }, [measurements]);

  const handleMeasurementAdd = useCallback((measurement: Measurement) => {
    if (currentGroupIdRef.current && protocol) {
      const groupMeasurements = measurementsRef2.current.filter(m => m.groupId === currentGroupIdRef.current);
      const distanceCount = groupMeasurements.filter(m => m.type === 'distance' || m.type === 'line').length;
      const perpCount = groupMeasurements.filter(m => m.type === 'perpendicular').length;
  
      if ((measurement.type === 'distance' || measurement.type === 'line') && distanceCount >= 1) return;
      if (measurement.type === 'perpendicular' && perpCount >= 2) return;
    }
    setMeasurements(prev => {
      let label = measurement.label;
      if (!label) {
        if (measurement.type === 'perpendicular') {
          const perpCount = prev.filter(m =>
            m.type === 'perpendicular' && m.groupId === currentGroupIdRef.current
          ).length;
          if (protocol && perpCount < protocol.steps.length - 1) {
            label = protocol.steps[perpCount + 1].label;
          } else {
            label = `Perp ${perpCount + 1}`;
          }
        } else if (protocol && currentGroupIdRef.current) {
          const lineCount = prev.filter(m =>
            (m.type === 'distance' || m.type === 'line') && m.groupId === currentGroupIdRef.current
          ).length;
          label = protocol.steps[lineCount]?.label;
        }
      }
      return [...prev, { ...measurement, groupId: currentGroupIdRef.current ?? undefined, label }];
    });
      if (protocol && activeStep && measurementMatchesPrimitive(measurement, activeStep.primitive)) {
        const recordedPoints =
          activeStep.primitive === 'point' && measurement.type === 'perpendicular' && measurement.points.length >= 2
            ? [measurement.points[1]]
            : measurement.points;

        setWorkflow(prev =>
          recordStepResult(prev, protocol, {
            primitive: activeStep.primitive,
            points: recordedPoints,
            slice: measurement.slice,
          }),
        );
      }
    },
    [protocol, activeStep, currentGroupId],
  );

  const handleMeasurementDelete = useCallback((id: string) => {
    setMeasurements(prev => prev.filter(m => m.id !== id));
  }, []);

  const handleMeasurementUpdate = useCallback((id: string, newPoints: { x: number; y: number }[]) => {
  setMeasurements(prev => {
    const updated = prev.map(m => {
      if (m.id === id) return { ...m, points: newPoints, value: (() => {
        if (m.type === 'distance' && newPoints.length === 2) {
          const dx = newPoints[1].x - newPoints[0].x;
          const dy = newPoints[1].y - newPoints[0].y;
          return `${Math.sqrt(dx*dx + dy*dy).toFixed(2)} px`;
        }
        return m.value;
      })()};
      return m;
    });

    // Also update any perpendicular lines attached to this base line
    return updated.map(m => {
    if (m.type !== 'perpendicular' || m.baseLineId !== id) return m;
    const baseLine = updated.find(b => b.id === id);
    if (!baseLine || baseLine.points.length < 2) return m;
    const p0 = baseLine.points[0];
    const p1 = baseLine.points[1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len === 0) return m;
    const lineX = dx / len;
    const lineY = dy / len;
    const perpX = -dy / len;
    const perpY = dx / len;

    // Find where the old anchor was along the OLD base line
    // We need to store the t value — for now, project old anchor onto new base line
    const oldAnchor = m.points[0];
    const t = Math.max(0, Math.min(1, 
      ((oldAnchor.x - p0.x) * lineX + (oldAnchor.y - p0.y) * lineY) / len
    ));
    const newAnchorX = p0.x + lineX * t * len;
    const newAnchorY = p0.y + lineY * t * len;

    // Keep stub length and direction
    const stubDx = m.points[1].x - m.points[0].x;
    const stubDy = m.points[1].y - m.points[0].y;
    const stubLen = Math.sqrt(stubDx*stubDx + stubDy*stubDy);
    const sign = (stubDx * perpX + stubDy * perpY) >= 0 ? 1 : -1;

    return {
      ...m,
      points: [
        { x: newAnchorX, y: newAnchorY },
        { x: newAnchorX + perpX * stubLen * sign, y: newAnchorY + perpY * stubLen * sign },
      ],
    };
  });
  });
}, []);

  // Always render with axial interaction/view behavior regardless of which
  // sequence (A/S/C) is loaded. Sequence identity is shown in metadata labels.
  const currentViewPlane: Plane = 'axial';
  const activeVolumeMeta = studyData ? studyData.volumes[activeStudyPlane] : null;

  const handleAutoWindowLevel = useCallback(() => {
    if (!imageData || !header) return;
    const dims = header.dims;

    const plane = currentViewPlane;
    const sliceIndex = plane === 'axial' ? currentSlice.axial : plane === 'sagittal' ? currentSlice.sagittal : currentSlice.coronal;

    let min = Infinity;
    let max = -Infinity;

    if (plane === 'axial') {
      const width = dims[1];
      const height = dims[2];
      const offset = sliceIndex * width * height;
      const sliceSize = width * height;
      for (let i = 0; i < sliceSize; i++) {
        const v = imageData[offset + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    } else if (plane === 'sagittal') {
      const width = dims[2];
      const height = dims[3];
      for (let z = 0; z < height; z++) {
        for (let y = 0; y < width; y++) {
          const sourceIdx = z * dims[1] * dims[2] + y * dims[1] + sliceIndex;
          const v = imageData[sourceIdx] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    } else { // coronal
      const width = dims[1];
      const height = dims[3];
      for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
          const sourceIdx = z * dims[1] * dims[2] + sliceIndex * dims[1] + x;
          const v = imageData[sourceIdx] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }

    if (min === Infinity || max === -Infinity) return;

    const window = Math.max(1, max - min);
    const level = Math.round((min + max) / 2);

    setWindowLevel({ window, level });
  }, [imageData, header, currentSlice, currentViewPlane]);

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
      .filter((p) => Boolean(studyData.volumes[p]) && !hiddenStudyPlanes.has(p))
      .map((p) => {
        const v = studyData.volumes[p]!;
        return {
          id: p,
          label: p,
          imageData: v.imageData,
          header: v.header,
        };
      });
  }, [studyData, hiddenStudyPlanes]);

  return (
    <div className="h-full flex">
    <Toolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        measurements={measurements}
        onMeasurementDelete={handleMeasurementDelete}
        showCrosshair={showCrosshair}
        onToggleCrosshair={() => setShowCrosshair(v => !v)}
        onAutoWindowLevel={handleAutoWindowLevel}
      />
      <div className="flex-1 flex flex-col min-h-0 relative">
        {loaded ? (
          <ViewportGrid
            imageData={imageData!}
            header={header!}
            currentSlice={currentSlice}
            viewPlane={currentViewPlane}
            onSliceChange={handleSliceChange}
            windowLevel={windowLevel}
            onWindowLevelChange={handleWindowLevelChange}
            activeTool={effectiveTool}
            measurements={measurements}
            onMeasurementAdd={handleMeasurementAdd}
            onMeasurementUpdate={handleMeasurementUpdate}
            applyWeighting={applyWeighting}
            showCrosshair={showCrosshair}
            sequenceWindows={sequenceWindows}
            onWindowFocus={(plane) => setActiveStudyPlane(plane)}
            onHideWindow={hideStudyPlane}
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
              Sequence: <span className="text-gray-100 capitalize">{activeStudyPlane}</span>
              {activeVolumeMeta?.seriesDescription ? ` (${activeVolumeMeta.seriesDescription})` : ''}
            </div>
          </div>
        )}

        {/* Floating bottom-right tool bar (select, auto WL) */}
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
            variant={activeTool === 'pan' ? 'default' : 'ghost'}
            className={activeTool === 'pan' ? 'bg-blue-600 text-white' : 'text-gray-300'}
            onClick={() => setActiveTool(v => v === 'pan' ? 'none' : 'pan')}
            aria-label="Pan tool"
          >
            <Move className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="text-gray-300"
            onClick={() => handleAutoWindowLevel()}
            aria-label="Auto window level"
          >
            Auto WL
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
          onStudyPlaneSelect={selectStudyPlane}
          onFileLoad={onFileLoad}
          onStudyLoad={onStudyLoad}
          studyData={studyData}
          activeStudyPlane={activeStudyPlane}
          workflow={workflow}
          onWorkflowChange={setWorkflow}
          pixelSpacing={pixelSpacing}
          onPlaneRequest={handlePlaneRequest}
        />
      </div>
    </div>
  );
}