// Hip X-ray Viewer — fully self-contained, no shared workflow dependencies
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewport } from '../Viewport';
import type { MeasurementTool, Measurement, PointUpdater } from '../MedicalImageViewer';
import type { HipXrayImage } from './HipXrayLoader';
import type { Laterality } from '../dicom/laterality';
import { LATERALITIES } from '../dicom/laterality';
import { Button } from '../ui/button';
import { loadHipXrayFolder } from './HipXrayLoader';
import { FolderOpen, Loader2, MousePointer, Ruler, Triangle, Dot, CheckCircle2, Circle, RotateCcw } from 'lucide-react';
import { HIP_MEASUREMENT_PROTOCOL } from './HipMeasurementProtocols';

export { HIP_MEASUREMENT_PROTOCOL };

/** Lightweight tooltip */
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

/** Per-step result stored in workflow state */
interface StepResult {
  points: { x: number; y: number }[];
  slice: number;
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number };
}

interface HipWorkflowState {
  protocolId: string | null;
  activeStepIndex: number;
  stepResults: Record<string, StepResult>;
}

const initialWorkflow: HipWorkflowState = {
  protocolId: null,
  activeStepIndex: 0,
  stepResults: {},
};

interface HipXrayViewerProps {
  onImagesLoad?: (images: HipXrayImage[]) => void;
  sessionUser?: string;
  sessionUserEmail?: string;
}

// ── LocalStorage persistence ─────────────────────────────────────────
const HIP_STORAGE_KEY = 'hip-measurements';

function loadHipArchive(): Record<string, Measurement[]> {
  try {
    const raw = localStorage.getItem(HIP_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveHipArchive(archive: Record<string, Measurement[]>) {
  try {
    localStorage.setItem(HIP_STORAGE_KEY, JSON.stringify(archive));
  } catch {}
}

function storageKey(patientKey: string, laterality: Laterality): string {
  return `${patientKey}::${laterality}`;
}

export function HipXrayViewer({ onImagesLoad, sessionUser, sessionUserEmail }: HipXrayViewerProps) {
  // ── State ──────────────────────────────────────────────────────────
  const [images, setImages] = useState<HipXrayImage[]>([]);
  const [activeImageKey, setActiveImageKey] = useState<string | null>(null);
  const [activeLaterality, setActiveLaterality] = useState<Laterality>('left');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<MeasurementTool>('pan');
  const [userToolOverride, setUserToolOverride] = useState<MeasurementTool | null>(null);
const [magnifierActive, setMagnifierActive] = useState(0);
const [showLabels, setShowLabels] = useState(true);
  // Per-patient per-side measurement archive
  const [measurementArchive, setMeasurementArchive] = useState<Record<string, Measurement[]>>(() => loadHipArchive());
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<HipWorkflowState>(initialWorkflow);

  // Persist archive on every change
  useEffect(() => { saveHipArchive(measurementArchive); }, [measurementArchive]);

  // Active measurements for current patient + side
  const activeStorageKey = activeImageKey ? storageKey(activeImageKey, activeLaterality) : null;
  const measurements: Measurement[] = activeStorageKey
    ? (measurementArchive[activeStorageKey] ?? []).filter(
        (m) => m.workflowStepId !== 'femur-shaft-midline' && m.workflowStepId !== 'midpoint-guideline'
      )
    : [];

  const setMeasurements = useCallback(
    (updater: Measurement[] | ((prev: Measurement[]) => Measurement[])) => {
      if (!activeStorageKey) return;
      setMeasurementArchive((prev) => {
        const cur = prev[activeStorageKey] ?? [];
        const next = typeof updater === 'function' ? updater(cur) : updater;
        // Guard: strip any measurements whose laterality doesn't match the storage key
        const keyLaterality = activeStorageKey?.split('::')[1];
        const clean = keyLaterality ? next.filter((m) => !m.laterality || m.laterality === keyLaterality) : next;
        return { ...prev, [activeStorageKey]: clean };
      });
    },
    [activeStorageKey],
  );

  // Clean up orphaned midpoint guidelines when switching knees
  // (stale data from previous bugs may have stored guidelines under wrong keys)
  useEffect(() => {
    if (!activeStorageKey) return;
    setMeasurementArchive((prev) => {
      const cur = prev[activeStorageKey];
      if (!cur) return prev;
      const hasNeck = cur.some((m) => m.workflowStepId === 'femur-neck-width');
      const hasHead = cur.some((m) => m.workflowStepId === 'femur-head-diameter');
      // If midpoint guideline exists but no neck/head, it's orphaned — remove it
      if (!hasNeck || !hasHead) {
        const filtered = cur.filter((m) => m.workflowStepId !== 'midpoint-guideline');
        if (filtered.length !== cur.length) {
          return { ...prev, [activeStorageKey]: filtered };
        }
      }
      return prev;
    });
  }, [activeStorageKey]);

  // One-time cleanup of all orphaned midpoint guidelines on mount
  useEffect(() => {
    setMeasurementArchive((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [key, measList] of Object.entries(next)) {
        const hasNeck = measList.some((m) => m.workflowStepId === 'femur-neck-width');
        const hasHead = measList.some((m) => m.workflowStepId === 'femur-head-diameter');
        if (!hasNeck || !hasHead) {
          const filtered = measList.filter((m) => m.workflowStepId !== 'midpoint-guideline');
          if (filtered.length !== measList.length) {
            next[key] = filtered;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, []); // run once on mount

  const [rightWidth, setRightWidth] = useState(288);
  const rightResizing = useRef(false);
  const dicomInputRef = useRef<HTMLInputElement | null>(null);
  const measIdCounter = useRef(0);
  const loadingAbortRef = useRef<AbortController | null>(null);

  const activeImage = useMemo(
    () => images.find((img) => img.patientKey === activeImageKey) ?? null,
    [images, activeImageKey],
  );

  const activePixelSpacing = useMemo(
    () => activeImage?.pixelSpacing ?? { x: 1, y: 1 },
    [activeImage],
  );

  const protocolActive = workflow.protocolId === HIP_MEASUREMENT_PROTOCOL.id;
  const activeStep = protocolActive ? HIP_MEASUREMENT_PROTOCOL.steps[workflow.activeStepIndex] : null;

  // Rebuild workflow from existing measurements when switching patient or side
  const prevStorageKeyRef = useRef(activeStorageKey);
  useEffect(() => {
    if (!activeStorageKey || activeStorageKey === prevStorageKeyRef.current) {
      prevStorageKeyRef.current = activeStorageKey;
      return;
    }
    prevStorageKeyRef.current = activeStorageKey;
    setSelectedMeasurementId(null);
    // Rebuild step results from existing measurements for this patient/side
    const curMeas = measurementArchive[activeStorageKey] ?? [];
    const stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any }> = {};
    for (const m of curMeas) {
      if (m.workflowStepId && HIP_MEASUREMENT_PROTOCOL.steps.some((s) => s.id === m.workflowStepId)) {
        stepResults[m.workflowStepId] = { points: m.points, slice: 0, imageScale: m.imageScale };
      }
    }
    // Auto-create femur shaft midline step result if G2 exists but G1 doesn't
    if (stepResults['lesser-trochanter-guideline'] && !stepResults['femur-shaft-midline']) {
      const g2 = stepResults['lesser-trochanter-guideline'];
      const g2Mid = { x: (g2.points[0].x + g2.points[1].x) / 2, y: (g2.points[0].y + g2.points[1].y) / 2 };
      const dx = g2.points[1].x - g2.points[0].x;
      const dy = g2.points[1].y - g2.points[0].y;
      const len = Math.hypot(dx, dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;
      const halfLen = 300;
      stepResults['femur-shaft-midline'] = {
        points: [
          { x: g2Mid.x - perpX * halfLen, y: g2Mid.y - perpY * halfLen },
          { x: g2Mid.x + perpX * halfLen, y: g2Mid.y + perpY * halfLen },
        ],
        slice: 0,
      };
    }
    let nextIdx = 0;
    while (nextIdx < HIP_MEASUREMENT_PROTOCOL.steps.length) {
      const s = HIP_MEASUREMENT_PROTOCOL.steps[nextIdx];
      const isAuto = s.id === 'femur-shaft-midline' || s.id === 'midpoint-guideline' || s.id === 'shaft-thickness' || s.id === 'horizontal-offset' || s.id === 'vertical-offset' || s.id === 'femoral-neck-angle';
      if (stepResults[s.id] || isAuto) { nextIdx++; } else { break; }
    }
    setWorkflow({
      protocolId: HIP_MEASUREMENT_PROTOCOL.id,
      activeStepIndex: Math.min(nextIdx, HIP_MEASUREMENT_PROTOCOL.steps.length - 1),
      stepResults,
    });
  }, [activeStorageKey, measurementArchive]);

  // ── Resize ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rightResizing.current) return;
      setRightWidth((w) => Math.max(220, Math.min(600, w - e.movementX)));
    };
    const onUp = () => { rightResizing.current = false; document.body.style.cursor = ''; };
    const onTouchMove = (e: TouchEvent) => {
      if (!rightResizing.current) return;
      const t = e.touches[0];
      if (t) setRightWidth((w) => Math.max(220, Math.min(600, window.innerWidth - t.clientX)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────
  const handleLoadFolder = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || !files.length) return;
    try {
      setBusy(true);
      loadingAbortRef.current = new AbortController();
      const loaded = await loadHipXrayFolder(files, setProgress, loadingAbortRef.current.signal);
      if (loaded.length === 0) { alert('No valid hip X-ray DICOMs found.'); return; }
      setImages(loaded);
      setActiveImageKey(loaded[0].patientKey);
      onImagesLoad?.(loaded);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgress('Loading cancelled.');
      } else {
        console.error(err);
        alert('Failed to load hip X-ray DICOMs.');
      }
    } finally {
      setBusy(false);
      setProgress(null);
      loadingAbortRef.current = null;
      event.target.value = '';
    }
  };

  const genId = () => `hip-${Date.now()}-${++measIdCounter.current}`;

  const selectTool = (tool: MeasurementTool) => {
    setActiveTool(tool);
    setUserToolOverride(tool);
  };

  // When a protocol step is active, auto-select the matching tool UNLESS
  // the user manually overrode it (e.g. clicked a done step to edit).
  const effectiveTool: MeasurementTool = useMemo(() => {
    if (userToolOverride !== null) return userToolOverride;
    if (!activeStep) return activeTool;
    if (activeStep.tool === 'point') return 'point';
    return 'distance';
  }, [activeStep, activeTool, userToolOverride]);

  // Clear user tool override when step advances (new measurement added)
  const prevStepIdRef = useRef(activeStep?.id);
  useEffect(() => {
    if (activeStep?.id !== prevStepIdRef.current) {
      setUserToolOverride(null);
      prevStepIdRef.current = activeStep?.id;
    }
  }, [activeStep?.id]);

  // Compute constraint for the current step
  const constraintProps = useMemo(() => {
    if (!protocolActive || !activeStep || !activeStep.id) return { constraintLineId: null, constraintMode: 'none' as const };
    
    const stepId = activeStep.id;
    const stepIdx = workflow.activeStepIndex;
    
    // Step 7 (femur-head-diameter): parallel to step 6
    if (stepId === 'femur-head-diameter') {
      const refMeas = measurements.find((m) => m.workflowStepId === 'femur-neck-width');
      if (refMeas && refMeas.points.length >= 2) return { constraintLineId: refMeas.id, constraintMode: 'parallel' as const };
    }
    
    return { constraintLineId: null, constraintMode: 'none' as const };
  }, [protocolActive, activeStep, measurements, workflow.activeStepIndex]);

  // Point constraint: snap to specific guideline based on step
  const pointConstraintLineId = useMemo(() => {
    if (!protocolActive || !activeStep) return null;
    const stepId = activeStep.id;
    // Steps 3-4: snap to lesser trochanter guideline
    if (stepId === 'medial-cortical-point' || stepId === 'lateral-cortical-point') {
      const g = measurements.find((m) => m.workflowStepId === 'lesser-trochanter-guideline');
      return g?.id ?? null;
    }
    // Steps 8-10: snap to midpoint guideline — same laterality only
    if (stepId === 'hip-axis-lateral' || stepId === 'hip-axis-medial' || stepId === 'neck-axis-medial') {
      const raw = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
      const g = raw.find((m) => m.workflowStepId === 'midpoint-guideline' && m.laterality === activeLaterality);
      return g?.id ?? null;
    }
    return null;
  }, [protocolActive, activeStep, measurementArchive, activeStorageKey, activeLaterality]);

  // Point constraint line points: for steps 8-10, pass the midpoint guideline
  // line directly so the Viewport can snap to it (the guideline is filtered
  // from measurements so pointConstraintLineId can't resolve it).
  const pointConstraintLinePoints = useMemo(() => {
    if (!protocolActive || !activeStep) return null;
    const stepId = activeStep.id;
    if (stepId !== 'hip-axis-lateral' && stepId !== 'hip-axis-medial' && stepId !== 'neck-axis-medial') return null;
    // Compute the midpoint guideline from the current knee's neck-width + head-diameter
    const neck = measurements.find((m) => m.workflowStepId === 'femur-neck-width');
    const head = measurements.find((m) => m.workflowStepId === 'femur-head-diameter');
    if (!neck || !head || neck.points.length < 2 || head.points.length < 2) return null;
    const nm = { x: (neck.points[0].x + neck.points[1].x) / 2, y: (neck.points[0].y + neck.points[1].y) / 2 };
    const hm = { x: (head.points[0].x + head.points[1].x) / 2, y: (head.points[0].y + head.points[1].y) / 2 };
    return [nm, hm];
  }, [protocolActive, activeStep, measurements]);

  // Snap-to-lines for point steps (3, 4)
  const shouldSnapToLines = protocolActive && activeStep?.tool === 'point';

  // Compute which measurements should render as extended dashed guidelines
  const guidelineIds = useMemo(() => {
    if (!protocolActive) return null;
    const ids = new Set<string>();
    // Non-auto guidelines only (midpoint-guideline is rendered as derived line)
    for (const stepId of ['lesser-trochanter-guideline']) {
      const m = measurements.find((mm) => mm.workflowStepId === stepId);
      if (m) ids.add(m.id);
    }
    return ids.size > 0 ? ids : null;
  }, [protocolActive, measurements]);

  // Compute derived measurement lines for visual overlay
  const derivedLines = useMemo(() => {
    const lines: { points: { x: number; y: number }[]; label: string }[] = [];
    if (!protocolActive) return lines;

    const headDiam = measurements.find((m) => m.workflowStepId === 'femur-head-diameter');
    // G1 (femur shaft midline): auto-computed from G2 midpoint, perpendicular to G2
    const g2line = measurements.find((m) => m.workflowStepId === 'lesser-trochanter-guideline');
    if (g2line && g2line.points.length >= 2) {
      const g2Mid = { x: (g2line.points[0].x + g2line.points[1].x) / 2, y: (g2line.points[0].y + g2line.points[1].y) / 2 };
      const dx = g2line.points[1].x - g2line.points[0].x;
      const dy = g2line.points[1].y - g2line.points[0].y;
      const len = Math.hypot(dx, dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;
      const halfLen = Math.max(200, len); // extend past viewport
      lines.push({ points: [
        { x: g2Mid.x - perpX * halfLen, y: g2Mid.y - perpY * halfLen },
        { x: g2Mid.x + perpX * halfLen, y: g2Mid.y + perpY * halfLen },
      ], label: 'Femur Shaft Midline' });
    }
    const g1Points = g2line && g2line.points.length >= 2 ? (() => { const m = { x: (g2line.points[0].x + g2line.points[1].x) / 2, y: (g2line.points[0].y + g2line.points[1].y) / 2 }; const dx = g2line.points[1].x - g2line.points[0].x, dy = g2line.points[1].y - g2line.points[0].y; const l = Math.hypot(dx, dy) || 1; const px = -dy / l, py = dx / l; const h = 300; return [{ x: m.x - px * h, y: m.y - py * h }, { x: m.x + px * h, y: m.y + py * h }]; })() : undefined;
    const ltGuid = measurements.find((m) => m.workflowStepId === 'lesser-trochanter-guideline');
    // Compute midpoint guideline on the fly from current hip's neck-width + head-diameter.
    // Never read from archive or stepResults — that's what caused cross-hip leakage.
    const neckW = measurements.find((m) => m.workflowStepId === 'femur-neck-width');
    const headD = measurements.find((m) => m.workflowStepId === 'femur-head-diameter');
    let midGuid: { points: { x: number; y: number }[] } | undefined;
    if (neckW && headD && neckW.points.length >= 2 && headD.points.length >= 2) {
      const nm = { x: (neckW.points[0].x + neckW.points[1].x) / 2, y: (neckW.points[0].y + neckW.points[1].y) / 2 };
      const hm = { x: (headD.points[0].x + headD.points[1].x) / 2, y: (headD.points[0].y + headD.points[1].y) / 2 };
      const dx = hm.x - nm.x, dy = hm.y - nm.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const big = 5000;
      lines.push({ points: [
        { x: nm.x - ux * big, y: nm.y - uy * big },
        { x: hm.x + ux * big, y: hm.y + uy * big }
      ], label: 'Midpoint Guideline' });
      midGuid = { points: [nm, hm] };
    }

    const hipLat = measurements.find((m) => m.workflowStepId === 'hip-axis-lateral');
    const hipMed = measurements.find((m) => m.workflowStepId === 'hip-axis-medial');
    if (headDiam && headDiam.points.length >= 2) {
      const headMid = { x: (headDiam.points[0].x + headDiam.points[1].x) / 2, y: (headDiam.points[0].y + headDiam.points[1].y) / 2 };
      // Horizontal offset
      if (g1Points && g1Points.length >= 2) {
        const sm0 = g1Points[0], sm1 = g1Points[1];
        const dx = sm1.x - sm0.x, dy = sm1.y - sm0.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = ((headMid.x - sm0.x) * dx + (headMid.y - sm0.y) * dy) / len2;
        const foot = { x: sm0.x + dx * t, y: sm0.y + dy * t };
        lines.push({ points: [headMid, foot], label: 'H-Offset' });
      }
      // Vertical offset
      if (ltGuid && ltGuid.points.length >= 2) {
        const lt0 = ltGuid.points[0], lt1 = ltGuid.points[1];
        const dx = lt1.x - lt0.x, dy = lt1.y - lt0.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = ((headMid.x - lt0.x) * dx + (headMid.y - lt0.y) * dy) / len2;
        const foot = { x: lt0.x + dx * t, y: lt0.y + dy * t };
        lines.push({ points: [headMid, foot], label: 'V-Offset' });
      }
    }

    // Angle arc: arc between hip axis (projected onto guideline) and shaft midline
    if (hipLat && hipMed && hipLat.points.length >= 1 && hipMed.points.length >= 1 && g1Points && g1Points.length >= 2 && midGuid && midGuid.points.length >= 2) {
      const mg0 = midGuid.points[0], mg1 = midGuid.points[1];
      const tLat = ((hipLat.points[0].x - mg0.x) * (mg1.x - mg0.x) + (hipLat.points[0].y - mg0.y) * (mg1.y - mg0.y)) / ((mg1.x - mg0.x) ** 2 + (mg1.y - mg0.y) ** 2 || 1);
      const tMed = ((hipMed.points[0].x - mg0.x) * (mg1.x - mg0.x) + (hipMed.points[0].y - mg0.y) * (mg1.y - mg0.y)) / ((mg1.x - mg0.x) ** 2 + (mg1.y - mg0.y) ** 2 || 1);
      const gdx = mg1.x - mg0.x, gdy = mg1.y - mg0.y;
      const projLat = { x: mg0.x + gdx * tLat, y: mg0.y + gdy * tLat };
      const projMed = { x: mg0.x + gdx * tMed, y: mg0.y + gdy * tMed };
      // Hip axis direction
      const haDx = projMed.x - projLat.x, haDy = projMed.y - projLat.y;
      const haLen = Math.hypot(haDx, haDy) || 1;
      // Shaft midline direction
      const smDx = g1Points[1].x - g1Points[0].x, smDy = g1Points[1].y - g1Points[0].y;
      const smLen = Math.hypot(smDx, smDy) || 1;
      // Compute intersection of hip axis line and shaft midline
      const haPx = projLat.x, haPy = projLat.y;
      const smPx = g1Points[0].x, smPy = g1Points[0].y;
      const det = haDx * (-smDy) - haDy * (-smDx);
      if (Math.abs(det) > 1e-10) {
        const tS = ((smPx - haPx) * (-smDy) + (smPy - haPy) * smDx) / det;
        const ix = haPx + tS * haDx, iy = haPy + tS * haDy;
        // Compute the obtuse neck-shaft angle arc. Starts at the HIP AXIS line,
        // The two lines each have two directions (opposite pairs).
        // Pick the pair that gives the obtuse (> π/2) angle between them.
        const angleShaft = Math.atan2(-smDy, smDx);
        const angleHip = Math.atan2(-haDy, haDx);
        // Generate both direction options for each line
        const shaftDirs = [angleShaft, angleShaft + Math.PI];
        const hipDirs = [angleHip, angleHip + Math.PI];
        let bestShaftAngle = angleShaft, bestHipAngle = angleHip, bestAngle = 0;
        for (const sd of shaftDirs) {
          for (const hd of hipDirs) {
            let diff = ((hd - sd) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
            const short = Math.min(diff, 2 * Math.PI - diff);
            if (short > bestAngle) {
              bestAngle = short;
              bestShaftAngle = sd;
              bestHipAngle = hd;
            }
          }
        }
        // bestAngle is the obtuse (> π/2) or the acute (< π/2) — get the obtuse
        const neckAngle = bestAngle > Math.PI / 2 ? bestAngle : Math.PI - bestAngle;
        // Draw from hip axis TO shaft midline, in the direction toward the shaft
        let diff = ((bestShaftAngle - bestHipAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const towardShaft = diff <= Math.PI ? 1 : -1; // CCW if short way is CCW, else CW
        const arcR = 40;
        const steps = 20;
        const arcPts: { x: number; y: number }[] = [];
        for (let i = 0; i <= steps; i++) {
          const a = bestHipAngle + towardShaft * neckAngle * (i / steps);
          arcPts.push({ x: ix + arcR * Math.cos(a), y: iy - arcR * Math.sin(a) });
        }
        lines.push({ points: arcPts, label: 'Angle' });
      }
    }
    return lines;
  }, [protocolActive, measurements, activeLaterality]);

  // ── Helper: constrain points to maintain live perpendicular/parallel/point-on-line ──
  const constrainPoints = (
    stepId: string | undefined,
    newPts: { x: number; y: number }[],
    oldPts: { x: number; y: number }[],
    allMeas: Measurement[],
    laterality?: string,
  ): { x: number; y: number }[] => {
    if (!stepId || newPts.length === 0) return newPts;

    // Point-on-line: steps 3-4 (on lesser trochanter guideline), steps 8-10 (on midpoint guideline)
    if (newPts.length === 1) {
      let guideId: string | undefined;
      if (stepId === 'medial-cortical-point' || stepId === 'lateral-cortical-point') {
        guideId = 'lesser-trochanter-guideline';
      } else if (stepId === 'hip-axis-lateral' || stepId === 'hip-axis-medial' || stepId === 'neck-axis-medial') {
        guideId = 'midpoint-guideline';
      }
      if (guideId) {
        // Only constrain to guidelines matching this point's laterality
        const lat = laterality ?? activeLaterality;
        const sameLat = allMeas.filter((m) => m.laterality === lat);
        const guide = sameLat.find((m) => m.workflowStepId === guideId);
        if (guide && guide.points.length >= 2) {
          // DIAGNOSTIC: log when constraining a point to help debug cross-knee issues
          console.warn(
            `[constrainPoints] CONSTRAINING step="${stepId}" point_laterality="${lat}" ` +
            `guideline_laterality="${guide.laterality}" guideline_id="${guide.id}" ` +
            `activeKey="${activeStorageKey}" activeLaterality="${activeLaterality}"`
          );
          const g0 = guide.points[0], g1 = guide.points[1];
          const dx = g1.x - g0.x, dy = g1.y - g0.y;
          const len2 = dx * dx + dy * dy || 1;
          const t = ((newPts[0].x - g0.x) * dx + (newPts[0].y - g0.y) * dy) / len2;
          return [{ x: g0.x + dx * t, y: g0.y + dy * t }];
        }
      }
      return newPts;
    }

    // Parallel constraint: step 7 → step 6
    if (stepId === 'femur-head-diameter' && newPts.length >= 2) {
      const lat = laterality ?? activeLaterality;
      const sameLat = allMeas.filter((m) => m.laterality === lat);
      const ref = sameLat.find((m) => m.workflowStepId === 'femur-neck-width');
      if (ref && ref.points.length >= 2) {
        const r0 = ref.points[0], r1 = ref.points[1];
        const rdx = r1.x - r0.x, rdy = r1.y - r0.y;
        const rlen = Math.hypot(rdx, rdy) || 1;
        const dirX = rdx / rlen, dirY = rdy / rlen;
        const start = newPts[0];
        const vx = newPts[1].x - start.x, vy = newPts[1].y - start.y;
        const proj = vx * dirX + vy * dirY;
        return [start, { x: start.x + dirX * proj, y: start.y + dirY * proj }];
      }
    }

    return newPts;
  };

  const cascadeDependents = (changedStepId: string | undefined, cur: Measurement[]): Measurement[] => {
    if (!changedStepId) return cur;
    let next = cur;
    // Loop through dependency levels (handles transitive: step1→step2→steps3-4)
    let iteration = 0;
    while (iteration < 5) {
      iteration++;
      const trigger = iteration === 1 ? changedStepId : '';
      let didChange = false;

      // G2 is now free (step 1). G1 is auto-computed from G2's midpoint as a derived line.

      // Re-project points on lesser trochanter guideline (steps 3-4)
      if (trigger === 'lesser-trochanter-guideline' || iteration > 1) {
        next = next.map((m) => {
          if ((m.workflowStepId !== 'medial-cortical-point' && m.workflowStepId !== 'lateral-cortical-point') || m.points.length < 1) return m;
          const newPts = constrainPoints(m.workflowStepId, m.points, m.points, next, m.laterality);
          if (newPts[0]?.x !== m.points[0]?.x || newPts[0]?.y !== m.points[0]?.y) didChange = true;
          return { ...m, points: newPts };
        });
      }

      // Re-project parallel (step 7) when step 5 changes
      if (trigger === 'femur-neck-width' || iteration > 1) {
        next = next.map((m) => {
          if (m.workflowStepId !== 'femur-head-diameter' || m.points.length < 2) return m;
          const newPts = constrainPoints('femur-head-diameter', m.points, m.points, next, m.laterality);
          if (newPts[0]?.x !== m.points[0]?.x || newPts[0]?.y !== m.points[0]?.y || newPts[1]?.x !== m.points[1]?.x || newPts[1]?.y !== m.points[1]?.y) didChange = true;
          return { ...m, points: newPts };
        });
      }

      // Recompute midpoint guideline (step 8) — only from measurements of the same laterality
      if (trigger === 'femur-neck-width' || trigger === 'femur-head-diameter' || iteration > 1) {
        const sameLat = next.filter((m) => m.laterality === activeLaterality);
        const neck = sameLat.find((m) => m.workflowStepId === 'femur-neck-width');
        const head = sameLat.find((m) => m.workflowStepId === 'femur-head-diameter');
        if (neck && head && neck.points.length >= 2 && head.points.length >= 2) {
          const neckMid = { x: (neck.points[0].x + neck.points[1].x) / 2, y: (neck.points[0].y + neck.points[1].y) / 2 };
          const headMid = { x: (head.points[0].x + head.points[1].x) / 2, y: (head.points[0].y + head.points[1].y) / 2 };
          const oldG = next.find((m) => m.workflowStepId === 'midpoint-guideline' && m.laterality === activeLaterality);
          if (oldG) {
            if (oldG.points[0]?.x !== neckMid.x || oldG.points[0]?.y !== neckMid.y || oldG.points[1]?.x !== headMid.x || oldG.points[1]?.y !== headMid.y) {
              didChange = true;
              next = next.map((m) => m.workflowStepId === 'midpoint-guideline' ? { ...m, points: [neckMid, headMid] } : m);
            }
          } else {
            // Create the midpoint guideline if it doesn't exist yet (out-of-order drawing)
            const gId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            next = [...next, {
              id: gId, type: 'distance' as const, points: [neckMid, headMid],
              slice: 0, plane: 'coronal' as const,
              laterality: activeLaterality,
              label: 'Guideline Through Midpoints', workflowStepId: 'midpoint-guideline',
              timestamp: new Date().toISOString(),
            }];
            didChange = true;
          }
        }
      }

      // Re-project points on midpoint guideline (steps 8-10) — trigger on placement too
      if (trigger === 'hip-axis-lateral' || trigger === 'hip-axis-medial' || trigger === 'neck-axis-medial' || trigger === 'midpoint-guideline' || iteration > 1) {
        next = next.map((m) => {
          if ((m.workflowStepId !== 'hip-axis-lateral' && m.workflowStepId !== 'hip-axis-medial' && m.workflowStepId !== 'neck-axis-medial') || m.points.length < 1) return m;
          const newPts = constrainPoints(m.workflowStepId, m.points, m.points, next, m.laterality);
          if (newPts[0]?.x !== m.points[0]?.x || newPts[0]?.y !== m.points[0]?.y) didChange = true;
          return { ...m, points: newPts };
        });
      }

      if (!didChange) break;
    }
    return next;
  };


  const handleMeasurementAdd = useCallback(
    (m: Measurement) => {
      // If protocol active and step expects a specific primitive, check match
      if (protocolActive && activeStep) {
        const stepPrimitive = activeStep.primitive;
        const mType = m.type;
        const matches = 
          (stepPrimitive === 'distance' || stepPrimitive === 'line') 
            ? (mType === 'distance' || mType === 'line')
            : stepPrimitive === 'point'
              ? (mType === 'point')
              : false;
        if (!matches) return; // silently reject wrong-tool drawings
        // Block if this step already has a completed result (no duplicates)
        if (workflow.stepResults[activeStep.id]) return;
      }

      const id = m.id || genId();
      const tagged: Measurement = {
        ...m,
        id,
        patientId: m.patientId ?? activeImage?.patientId,
        patientName: m.patientName ?? activeImage?.patientName,
        laterality: activeLaterality,
        label: activeStep?.label ?? m.label ?? m.type,
        workflowStepId: activeStep?.id,
        plane: 'coronal',
        slice: 0,
        timestamp: m.timestamp ?? new Date().toISOString(),
        sourcePixelSpacing: activeImage?.pixelSpacing,
      };

      setMeasurements((prev) => {
        const next = [...prev, tagged];
        // Cascade: if this is a reference line drawn after its dependents,
        // retroactively constrain them (e.g. M1/M2 placed before G2).
        return cascadeDependents(tagged.workflowStepId, next);
      });

      // Record step result and advance
      if (protocolActive && activeStep) {
        setWorkflow((prev) => {
          // Rebuild stepResults from current archive to avoid stale cross-knee data
          // (the rebuild effect at line 132 may not have fired yet after a knee switch)
          const curArchive = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
          let stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any }> = {};
          for (const m of curArchive) {
            if (m.workflowStepId && HIP_MEASUREMENT_PROTOCOL.steps.some((s) => s.id === m.workflowStepId)) {
              stepResults[m.workflowStepId] = { points: m.points, slice: 0, imageScale: m.imageScale };
            }
          }
          stepResults[activeStep.id] = { points: tagged.points, slice: 0, imageScale: tagged.imageScale };
          // Auto-create femur shaft midline stepResult when lesser trochanter guideline is drawn
          if (activeStep.id === 'lesser-trochanter-guideline' && !stepResults['femur-shaft-midline'] && tagged.points.length >= 2) {
            const g2Mid = { x: (tagged.points[0].x + tagged.points[1].x) / 2, y: (tagged.points[0].y + tagged.points[1].y) / 2 };
            const dx = tagged.points[1].x - tagged.points[0].x;
            const dy = tagged.points[1].y - tagged.points[0].y;
            const len = Math.hypot(dx, dy) || 1;
            const perpX = -dy / len;
            const perpY = dx / len;
            const halfLen = 300;
            stepResults['femur-shaft-midline'] = {
              points: [
                { x: g2Mid.x - perpX * halfLen, y: g2Mid.y - perpY * halfLen },
                { x: g2Mid.x + perpX * halfLen, y: g2Mid.y + perpY * halfLen },
              ],
              slice: 0,
              primitive: 'distance' as const,
            };
          }
          // Advance to next step; if at the last one, wrap to find earliest incomplete
          const total = HIP_MEASUREMENT_PROTOCOL.steps.length;
          let nextIdx = (prev.activeStepIndex + 1) % total;
          let seen = 0;
          while (seen < total) {
            const s = HIP_MEASUREMENT_PROTOCOL.steps[nextIdx];
            const isAuto = s.id === 'femur-shaft-midline' || s.id === 'midpoint-guideline' || s.id === 'shaft-thickness' || s.id === 'horizontal-offset' || s.id === 'vertical-offset' || s.id === 'femoral-neck-angle';
            if (stepResults[s.id] || isAuto) {
              nextIdx = (nextIdx + 1) % total;
              seen++;
            } else { break; }
          }
          if (seen === total) nextIdx = total - 1;
          return { ...prev, stepResults, activeStepIndex: nextIdx };
        });
      }
    },
    [protocolActive, activeStep, activeLaterality, activeImage, setMeasurements, cascadeDependents, measurementArchive, activeStorageKey],
  );

  const handleMeasurementUpdate = useCallback(
    (id: string, newPoints: PointUpdater, value?: string, imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number }) => {
      const key = activeStorageKey;
      if (!key) return;
      setMeasurementArchive((prev) => {
        const cur = prev[key] ?? [];
        const target = cur.find((m) => m.id === id);
        if (!target) return prev;
        const pts = typeof newPoints === 'function' ? newPoints(target.points) : newPoints;
        // Apply live constraint based on the measurement's workflow step
        const constrained = constrainPoints(target.workflowStepId, pts, target.points, cur, target.laterality);
        let next = cur.map((m) => {
          if (m.id !== id) return m;
          return { ...m, points: constrained, value: value ?? m.value, imageScale: imageScale ?? m.imageScale };
        });
        // Cascade: update all dependent measurements
        next = cascadeDependents(target.workflowStepId, next);
        // Guard: strip any measurements whose laterality doesn't match the storage key
        const keyLaterality = key?.split('::')[1];
        const clean = keyLaterality ? next.filter((m) => !m.laterality || m.laterality === keyLaterality) : next;
        return { ...prev, [key]: clean };
      });
    },
    [activeStorageKey, activeLaterality, constrainPoints, cascadeDependents],
  );

  // ── Cascade: when a reference measurement is edited, update all dependents ──


  const handleMeasurementDelete = useCallback((id: string) => {
    // Find the measurement's workflow step before removing
    const target = measurements.find((m) => m.id === id);
    setMeasurements((prev) => prev.filter((m) => m.id !== id));
    if (selectedMeasurementId === id) setSelectedMeasurementId(null);
    // Also clear the workflow step result so the task list updates
    if (target?.workflowStepId) {
      clearSteps([target.workflowStepId]);
    }
  }, [measurements, selectedMeasurementId]);

  const clearSteps = (stepIds: string[]) => {
    // Also cascade: removing step 5 or 6 removes step 7 too
    const toRemove = new Set(stepIds);
    if (toRemove.has('lesser-trochanter-guideline')) {
      toRemove.add('femur-shaft-midline');
    }
    if (toRemove.has('femur-neck-width') || toRemove.has('femur-head-diameter')) {
      toRemove.add('midpoint-guideline');
    }
    const removeArr = Array.from(toRemove);
    setMeasurements((prev) => prev.filter((m) => !removeArr.includes(m.workflowStepId ?? '')));
    setWorkflow((prev) => {
      // Rebuild from current archive to avoid stale cross-knee data
      const curArchive = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
      const stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any }> = {};
      for (const m of curArchive) {
        if (m.workflowStepId && HIP_MEASUREMENT_PROTOCOL.steps.some((s) => s.id === m.workflowStepId)) {
          stepResults[m.workflowStepId] = { points: m.points, slice: 0, imageScale: m.imageScale };
        }
      }
      for (const sid of removeArr) delete stepResults[sid];
      let minIdx = Infinity;
      for (const sid of removeArr) {
        const idx = HIP_MEASUREMENT_PROTOCOL.steps.findIndex((s) => s.id === sid);
        if (idx >= 0 && idx < minIdx) minIdx = idx;
      }
      return { ...prev, stepResults, activeStepIndex: Math.max(0, minIdx < Infinity ? minIdx : 0) };
    });
  };

  const redrawStep = (stepId: string) => {
    clearSteps([stepId]);
  };

  const resetProtocol = () => {
    setMeasurements((prev) => prev.filter((m) => !m.workflowStepId));
    setWorkflow({ ...initialWorkflow, protocolId: HIP_MEASUREMENT_PROTOCOL.id });
  };

  // ── Export ─────────────────────────────────────────────────────────
  const downloadTextFile = (filename: string, text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click(); URL.revokeObjectURL(url);
  };

  const exportHipCsv = useCallback(() => {
    const rows: string[] = ['sessionUser,sessionUserEmail,patient,laterality,step,label,type,mm_value,point1_x,point1_y,point2_x,point2_y'];
    const userCols = [sessionUser ?? '', sessionUserEmail ?? ''].join(',');
    for (const [key, measList] of Object.entries(measurementArchive)) {
      const [patientKey, laterality] = key.split('::');
      // Determine this patient's own pixel spacing from the first measurement that has it
      const ownPS =
        measList.find((m) => m.sourcePixelSpacing)?.sourcePixelSpacing ??
        activePixelSpacing;
      // Build step results for this patient+side to compute derived values
      const stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any; sourcePixelSpacing?: any }> = {};
      for (const m of measList) {
        if (m.workflowStepId) {
          stepResults[m.workflowStepId] = {
            points: m.points,
            slice: 0,
            imageScale: m.imageScale,
            sourcePixelSpacing: m.sourcePixelSpacing,
          };
        }
      }
      // Rebuild auto-computed step results that are not stored as measurements
      // (femur-shaft-midline, midpoint-guideline) for ALL patients, not just the active one.
      const g2 = stepResults['lesser-trochanter-guideline'];
      if (g2 && !stepResults['femur-shaft-midline'] && g2.points.length >= 2) {
        const g2Mid = { x: (g2.points[0].x + g2.points[1].x) / 2, y: (g2.points[0].y + g2.points[1].y) / 2 };
        const dx = g2.points[1].x - g2.points[0].x, dy = g2.points[1].y - g2.points[0].y;
        const len = Math.hypot(dx, dy) || 1;
        const perpX = -dy / len, perpY = dx / len;
        const halfLen = 300;
        stepResults['femur-shaft-midline'] = {
          points: [
            { x: g2Mid.x - perpX * halfLen, y: g2Mid.y - perpY * halfLen },
            { x: g2Mid.x + perpX * halfLen, y: g2Mid.y + perpY * halfLen },
          ],
          slice: 0,
          imageScale: g2.imageScale,
          sourcePixelSpacing: g2.sourcePixelSpacing,
        };
      }
      // Rebuild midpoint-guideline from neck-width + head-diameter if both exist
      const neck = stepResults['femur-neck-width'];
      const head = stepResults['femur-head-diameter'];
      if (neck && head && !stepResults['midpoint-guideline'] && neck.points.length >= 2 && head.points.length >= 2) {
        const neckMid = { x: (neck.points[0].x + neck.points[1].x) / 2, y: (neck.points[0].y + neck.points[1].y) / 2 };
        const headMid = { x: (head.points[0].x + head.points[1].x) / 2, y: (head.points[0].y + head.points[1].y) / 2 };
        stepResults['midpoint-guideline'] = {
          points: [neckMid, headMid],
          slice: 0,
          imageScale: neck.imageScale,
          sourcePixelSpacing: neck.sourcePixelSpacing,
        };
      }
      // Compute derived measurements (M1-M10) using this patient's own pixel spacing
      const computed = HIP_MEASUREMENT_PROTOCOL.compute(stepResults, ownPS);
      const derivedLines = computed ? computed.summary.split('\n').filter(Boolean) : [];
      for (const dl of derivedLines) {
        const eqIdx = dl.indexOf('=');
        if (eqIdx > 0) {
          let label = dl.substring(0, eqIdx).trim();
          let val = dl.substring(eqIdx + 1).trim();
          // M10 comes back as the acute unsigned angle from angleBetweenLinesDeg;
          // convert to obtuse just like the on-screen display does.
          if (label === 'M10. Femur Neck Angle') {
            const m10Match = val.match(/([\d.]+)°/);
            if (m10Match) {
              const unsigned = parseFloat(m10Match[1]);
              const obtuse = unsigned < 90 ? 180 - unsigned : unsigned;
              val = obtuse.toFixed(1) + '°';
            }
          }
          rows.push([userCols, patientKey, laterality, 'derived', label, 'computed', val, '', '', '', ''].join(','));
        }
      }
      // Raw measurements — use each measurement's own pixelSpacing + imageScale
      for (const m of measList) {
        const ps = m.sourcePixelSpacing ?? ownPS;
        const is = m.imageScale;
        const sx = (is?.x ?? 1) * ps.x;
        const sy = (is?.y ?? 1) * ps.y;
        let mmVal = '';
        if ((m.type === 'distance' || m.type === 'line') && m.points.length >= 2) {
          mmVal = Math.hypot((m.points[1].x - m.points[0].x) * sx, (m.points[1].y - m.points[0].y) * sy).toFixed(2);
        }
        const p1x = m.points[0]?.x.toFixed(1) ?? '';
        const p1y = m.points[0]?.y.toFixed(1) ?? '';
        const p2x = m.points[1]?.x.toFixed(1) ?? '';
        const p2y = m.points[1]?.y.toFixed(1) ?? '';
        rows.push([userCols, patientKey, laterality, m.workflowStepId || '', m.label || '', m.type, mmVal, p1x, p1y, p2x, p2y].join(','));
      }
    }
    downloadTextFile(`hip-measurements-${Date.now()}.csv`, rows.join('\n'));
  }, [measurementArchive, activePixelSpacing, sessionUser, sessionUserEmail]);

  // ── Protocol result (computed from live measurements, not stale workflow state) ──
  const result = useMemo(() => {
    if (!protocolActive) return null;
    // Build step results from current measurements + auto-computed workflow steps
    const stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any }> = {};
    for (const m of measurements) {
      if (m.workflowStepId) {
        stepResults[m.workflowStepId] = { points: m.points, slice: 0, imageScale: m.imageScale };
      }
    }
    // Merge in auto-computed step results (e.g. femur shaft midline) not stored as measurements
    for (const [stepId, sr] of Object.entries(workflow.stepResults)) {
      if (!stepResults[stepId]) {
        stepResults[stepId] = sr;
      }
    }
    // Rebuild auto-computed guidelines from raw archive to avoid stale workflow data
    // (cascade updates the archive but not workflow.stepResults after edits)
    const rawArchive = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
    // Femur shaft midline from G2
    const g2 = rawArchive.find((m) => m.workflowStepId === 'lesser-trochanter-guideline');
    if (g2 && g2.points.length >= 2 && !stepResults['femur-shaft-midline']) {
      const g2Mid = { x: (g2.points[0].x + g2.points[1].x) / 2, y: (g2.points[0].y + g2.points[1].y) / 2 };
      const dx = g2.points[1].x - g2.points[0].x, dy = g2.points[1].y - g2.points[0].y;
      const len = Math.hypot(dx, dy) || 1;
      const perpX = -dy / len, perpY = dx / len;
      const halfLen = 300;
      stepResults['femur-shaft-midline'] = {
        points: [
          { x: g2Mid.x - perpX * halfLen, y: g2Mid.y - perpY * halfLen },
          { x: g2Mid.x + perpX * halfLen, y: g2Mid.y + perpY * halfLen },
        ],
        slice: 0,
        imageScale: g2.imageScale,
      };
    }
    // Midpoint guideline from neck-width + head-diameter
    const neck = rawArchive.find((m) => m.workflowStepId === 'femur-neck-width');
    const head = rawArchive.find((m) => m.workflowStepId === 'femur-head-diameter');
    if (neck && head && neck.points.length >= 2 && head.points.length >= 2) {
      const neckMid = { x: (neck.points[0].x + neck.points[1].x) / 2, y: (neck.points[0].y + neck.points[1].y) / 2 };
      const headMid = { x: (head.points[0].x + head.points[1].x) / 2, y: (head.points[0].y + head.points[1].y) / 2 };
      stepResults['midpoint-guideline'] = {
        points: [neckMid, headMid],
        slice: 0,
        imageScale: neck.imageScale,
      };
    }
    const raw = HIP_MEASUREMENT_PROTOCOL.compute(stepResults, activePixelSpacing);
    if (!raw) return null;
    // Display the angle as the obtuse (> 90°) unsigned value
    let summary = raw.summary;
    const m10Match = summary.match(/M10\. Femur Neck Angle = ([\d.]+)° \(signed: ([\d.-]+)°\)/);
    if (m10Match) {
      const unsigned = parseFloat(m10Match[1]);
      const angle = unsigned < 90 ? 180 - unsigned : unsigned;
      summary = summary.replace(m10Match[0], `M10. Femur Neck Angle = ${angle.toFixed(1)}°`);
    } else if (!summary.includes('M10.')) {
      // M10 not yet computed — check if we have all prerequisites
      const hasHipAxis = stepResults['hip-axis-lateral'] && stepResults['hip-axis-medial'];
      const hasMidline = stepResults['femur-shaft-midline'];
      const hasMidGuideline = stepResults['midpoint-guideline'];
      if (hasHipAxis && hasMidline && hasMidGuideline) {
        summary += `
M10. Femur Neck Angle = ? (compute pending)`;
      }
    }
    return { ...raw, summary };
  }, [protocolActive, measurements, measurementArchive, activeStorageKey, activePixelSpacing, activeLaterality, workflow.stepResults]);

  // ── Auto-create midpoint guideline when neck-width + head-diameter exist ────
  // Derive everything from the archive (NOT workflow.stepResults) to avoid
  // cross-knee contamination during hip-switch race conditions.
  useEffect(() => {
    if (!protocolActive || !activeStorageKey) return;
    const curArchive = measurementArchive[activeStorageKey] ?? [];
    // Check if the CURRENT knee's archive has neck-width and head-diameter
    const neck = curArchive.find((m) => m.workflowStepId === 'femur-neck-width');
    const head = curArchive.find((m) => m.workflowStepId === 'femur-head-diameter');
    if (!neck || !head || neck.points.length < 2 || head.points.length < 2) return;
    // Check if a midpoint guideline already exists for this knee
    const existingGuideline = curArchive.find((m) => m.workflowStepId === 'midpoint-guideline');
    if (existingGuideline) return;

    const neckMid = { x: (neck.points[0].x + neck.points[1].x) / 2, y: (neck.points[0].y + neck.points[1].y) / 2 };
    const headMid = { x: (head.points[0].x + head.points[1].x) / 2, y: (head.points[0].y + head.points[1].y) / 2 };

    const gId = genId();
    const guideline: Measurement = {
      id: gId, type: 'distance', points: [neckMid, headMid],
      slice: 0, plane: 'coronal',
      laterality: activeLaterality,
      label: 'Guideline Through Midpoints', workflowStepId: 'midpoint-guideline',
      timestamp: new Date().toISOString(),
    };
    setMeasurements((prev) => [...prev, guideline]);

    // Update workflow step result
    if (!workflow.stepResults['midpoint-guideline']) {
      setWorkflow((prev) => {
        const curArchive2 = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
        const stepResults: Record<string, { points: { x: number; y: number }[]; slice: number; imageScale?: any }> = {};
        for (const m of curArchive2) {
          if (m.workflowStepId && HIP_MEASUREMENT_PROTOCOL.steps.some((s) => s.id === m.workflowStepId)) {
            stepResults[m.workflowStepId] = { points: m.points, slice: 0, imageScale: m.imageScale };
          }
        }
        stepResults['midpoint-guideline'] = { points: [neckMid, headMid], slice: 0 };
        return { ...prev, stepResults };
      });
    }
  }, [protocolActive, activeStorageKey, measurementArchive]);

  const loaded = activeImage !== null;

  // ── Independent canvas click handler for measurement selection ──
  const handleCanvasClick = useCallback((x: number, y: number) => {
    if (userToolOverride !== 'none') return; // only in Select mode
    // Hit-test all measurements
    for (const m of measurements) {
      for (const p of m.points) {
        if (Math.hypot(p.x - x, p.y - y) <= 15) {
          setSelectedMeasurementId(m.id);
          return;
        }
      }
      if ((m.type === 'distance' || m.type === 'line') && m.points.length >= 2) {
        const a = m.points[0], b = m.points[1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
        const cp = { x: a.x + dx * t, y: a.y + dy * t };
        if (Math.hypot(cp.x - x, cp.y - y) <= 15) {
          setSelectedMeasurementId(m.id);
          return;
        }
      }
    }
  }, [measurements, userToolOverride]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="h-full flex">
      <input ref={dicomInputRef} type="file" webkitdirectory="" directory="" multiple onChange={handleLoadFolder} className="hidden" />

      {/* Center: viewport */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        {loaded ? (
          <Viewport
            imageData={activeImage!.imageData}
            header={activeImage!.header}
            plane="axial"
            planeLabel={`AP Pelvis — ${activeImage!.patientId}`}
            measurementPlane="coronal"
            currentSlice={0}
            onSliceChange={() => {}}
            defaultWindowLevel={activeImage!.defaultWindowLevel}
            activeTool={effectiveTool}
            measurements={measurements}
            onMeasurementAdd={handleMeasurementAdd}
            onMeasurementUpdate={handleMeasurementUpdate}
            selectedMeasurementId={selectedMeasurementId}
            onMeasurementSelect={setSelectedMeasurementId}
            showCrosshair={false}
            applyWeighting={(v: number) => v}
            pixelSpacing={activePixelSpacing}
            measurementUnits="mm"
            allowNewMeasurements={true}
            constraintLineId={constraintProps.constraintLineId}
            constraintMode={constraintProps.constraintMode}
            snapToLines={shouldSnapToLines}
            pointConstraintLineId={pointConstraintLineId}
            pointConstraintLinePoints={pointConstraintLinePoints}
            guidelineIds={guidelineIds}
            derivedLines={derivedLines}
            suppressPerpendicularCreation={protocolActive}
            onCanvasClick={handleCanvasClick}
            magnifierActive={magnifierActive}
            showLabels={showLabels}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <svg className="mx-auto h-16 w-16 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-300">No hip X-ray loaded</h3>
              <p className="mt-2 text-sm text-gray-500">Select a folder of .dcm files (one per patient AP Pelvis).</p>
              <div className="mt-4">
                  <Button type="button" onClick={() => dicomInputRef.current?.click()} disabled={busy} className="bg-blue-600 hover:bg-blue-500 text-white">
                    {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-2" />}
                    Load Hip X-ray Folder
                  </Button>
              </div>
              {progress && <div className="mt-2 text-[10px] text-gray-400">{progress}</div>}
            </div>
          </div>
        )}

        {/* Patient info overlay */}
        {loaded && (
          <div className="absolute top-10 left-2 z-20 bg-black/60 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200">
            <div>Patient: <span className="text-gray-100">{activeImage!.patientId}</span> · {activeImage!.patientName || 'Unknown'}</div>
            <div>Study: AP Pelvis · Hip: <span className="capitalize">{activeLaterality}</span></div>
            <div>{activeImage!.rows}×{activeImage!.cols} · {activeImage!.pixelSpacing.x.toFixed(3)} mm/px</div>
          </div>
        )}

        {/* Floating bottom-right tool bar */}
        <div className="absolute bottom-4 right-4 flex flex-col items-center space-y-2" style={{ zIndex: 9999 }}>
          <ToolTip label="Select">
            <Button size="sm" variant={effectiveTool === 'none' ? 'default' : 'ghost'} className={effectiveTool === 'none' ? 'bg-blue-600 text-white' : 'text-gray-300'} onClick={() => selectTool('none')} aria-label="Select tool">
              <MousePointer className="h-4 w-4" />
            </Button>
          </ToolTip>
          <ToolTip label="Distance">
            <Button size="sm" variant={effectiveTool === 'distance' ? 'default' : 'ghost'} className={effectiveTool === 'distance' ? 'bg-blue-600 text-white' : 'text-gray-300'} onClick={() => selectTool('distance')} aria-label="Distance tool">
              <Ruler className="h-4 w-4" />
            </Button>
          </ToolTip>
          <ToolTip label="Angle">
            <Button size="sm" variant={effectiveTool === 'angle' ? 'default' : 'ghost'} className={effectiveTool === 'angle' ? 'bg-blue-600 text-white' : 'text-gray-300'} onClick={() => selectTool('angle')} aria-label="Angle tool">
              <Triangle className="h-4 w-4" />
            </Button>
          </ToolTip>
          <ToolTip label="Point">
            <Button size="sm" variant={effectiveTool === 'point' ? 'default' : 'ghost'} className={effectiveTool === 'point' ? 'bg-blue-600 text-white' : 'text-gray-300'} onClick={() => selectTool('point')} aria-label="Point tool">
              <Dot className="h-4 w-4" />
            </Button>
          </ToolTip>
          <ToolTip label={magnifierActive === 0 ? 'Magnifier off' : magnifierActive === 1 ? 'Image only (click for annotations)' : 'Image + annotations (click to off)'}>
            <Button
              size="sm"
              variant={magnifierActive ? 'default' : 'ghost'}
              className={magnifierActive ? (magnifierActive === 2 ? 'bg-amber-700 text-white' : 'bg-amber-600 text-white') : 'text-gray-300'}
              onClick={() => setMagnifierActive(v => (v + 1) % 3)}
              aria-label="Toggle magnifier"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </Button>
          </ToolTip>
          <ToolTip label={showLabels ? 'Hide label text' : 'Show label text'}>
            <Button
              size="sm"
              variant={showLabels ? 'default' : 'ghost'}
              className={showLabels ? 'bg-gray-600 text-white' : 'text-gray-300'}
              onClick={() => setShowLabels(v => !v)}
              aria-label="Toggle labels"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="9" x2="15" y2="15" />
                <line x1="15" y1="9" x2="9" y2="15" />
              </svg>
            </Button>
          </ToolTip>
        </div>
      </div>

      {/* Resizable divider */}
      <div
        role="separator" aria-orientation="vertical" aria-label="Resize right panel"
        onMouseDown={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onTouchStart={() => { rightResizing.current = true; document.body.style.cursor = 'col-resize'; }}
        onDoubleClick={() => { setRightWidth(288); }}
        className="w-8 -ml-4 -mr-4 cursor-col-resize relative" style={{ zIndex: 40 }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-transparent hover:bg-gray-700" />
      </div>

      {/* Right panel */}
      <div style={{ width: rightWidth }} className="flex-shrink-0 bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto h-full">
        <h2 className="text-sm font-bold text-blue-300 mb-3">Hip X-ray Measurements</h2>

        {/* Load button */}
        <div className="flex gap-2 mb-3">
          <Button type="button" size="sm" onClick={() => dicomInputRef.current?.click()} disabled={busy} className="bg-blue-600 hover:bg-blue-500 text-white flex-1">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-2" />}
            Load Hip X-ray Folder
          </Button>
          {busy && (
            <Button type="button" size="sm" onClick={() => loadingAbortRef.current?.abort()} variant="destructive" className="bg-red-700 hover:bg-red-600 text-white shrink-0">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
              Stop
            </Button>
          )}
        </div>
        {progress && <div className="mb-3 text-[10px] text-gray-400 truncate">{progress}</div>}

        {/* Patient list */}
        {images.length > 0 && (
          <div className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Patients ({images.length})</div>
            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
              {images.map((img) => (
                <div key={img.patientKey} className={`flex items-stretch rounded border overflow-hidden transition-colors ${
                  activeImageKey === img.patientKey ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-800/80'
                }`}>
                  <button type="button" onClick={() => setActiveImageKey(img.patientKey)}
                    className="flex-1 min-w-0 px-2 py-1.5 text-left text-[10px] hover:bg-gray-700/50"
                  >
                    <div className="font-semibold text-gray-100">{img.patientId}</div>
                    <div className="text-gray-400">{img.patientName}</div>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 px-1.5 text-[10px] text-red-400 hover:text-red-300 border-l border-gray-700/60 hover:bg-gray-700/50"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('Remove patient ' + (img.patientId || 'unknown') + ' and all their measurements?')) {
                        setImages((prev) => prev.filter((p) => p.patientKey !== img.patientKey));
                        const key = img.patientKey;
                        setMeasurementArchive((prev) => {
                          const next = { ...prev };
                          for (const k of Object.keys(next)) {
                            if (k.startsWith(key + '::') || k === key) delete next[k];
                          }
                          return next;
                        });
                        if (activeImageKey === img.patientKey) {
                          const remaining = images.filter((p) => p.patientKey !== img.patientKey);
                          setActiveImageKey(remaining.length > 0 ? remaining[0].patientKey : null);
                        }
                      }
                    }}
                    title="Remove patient"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Left/Right Hip Toggle */}
        {loaded && (
          <div className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Hip Side</div>
            <div className="flex gap-1 rounded-md bg-gray-950/80 p-0.5 border border-gray-700">
              {LATERALITIES.map((lat) => (
                <button key={lat} type="button" onClick={() => setActiveLaterality(lat)}
                  className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                    activeLaterality === lat ? 'bg-blue-600 text-white' : 'text-gray-200 hover:bg-gray-700/80'
                  }`}
                >{lat === 'left' ? 'Left Hip' : 'Right Hip'}</button>
              ))}
            </div>
            <p className="text-[9px] text-gray-500 mt-1 leading-tight">Same image, toggle tags measurements with this side.</p>
          </div>
        )}

        {/* ── Standalone Protocol Workflow ──────────────────────── */}
        <div className="rounded border border-gray-800 bg-gray-950/50 p-2 mb-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Hip protocol</div>
          {!protocolActive ? (
            <button type="button" onClick={() => setWorkflow({ ...initialWorkflow, protocolId: HIP_MEASUREMENT_PROTOCOL.id })}
              className="w-full rounded border border-emerald-700 bg-emerald-950/40 px-2 py-2 text-left text-xs text-emerald-200 hover:bg-emerald-900/40 transition-colors"
            >
              <div className="font-medium">Hip X-ray Measurements</div>
              <div className="mt-1 text-[10px] text-emerald-400/80">10-measurement protocol for AP Pelvis</div>
            </button>
          ) : (
            <>
              <div className="rounded border border-emerald-900/50 bg-emerald-950/30 p-2 text-xs text-gray-200 mb-2">
                <div className="font-medium text-emerald-200">Hip X-ray Measurements</div>
                <div className="mt-1 text-emerald-400/70 text-[10px]">Active — draw the current step</div>
              </div>

              <ol className="space-y-1.5 mb-2">
                {HIP_MEASUREMENT_PROTOCOL.steps.map((step, idx) => {
                  // Compute 'done' from workflow.stepResults, but cross-check against
                  // the archive for non-auto steps to prevent stale cross-knee display
                  const rawForStep = activeStorageKey ? (measurementArchive[activeStorageKey] ?? []) : [];
                  const inArchive = rawForStep.some((m) => m.workflowStepId === step.id);
                  const isAuto = step.id === 'femur-shaft-midline' || step.id === 'midpoint-guideline' || step.id === 'shaft-thickness' || step.id === 'horizontal-offset' || step.id === 'vertical-offset' || step.id === 'femoral-neck-angle';
                  // For auto steps, trust workflow.stepResults (they aren't in archive).
                  // For user-drawn steps, require the measurement to exist in the current archive.
                  const done = !!workflow.stepResults[step.id] && (isAuto || inArchive);
                  const isActive = idx === workflow.activeStepIndex && !done;
                  if (isAuto) {
                    if (done) {
                      return (
                        <li key={step.id} className="rounded p-1.5 text-[10px] bg-gray-800/60 border border-emerald-700/60">
                          <div className="flex items-start gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
                            <div className="flex-1">
                              <div className="font-medium text-gray-400 line-through">{idx + 1}. {step.label}</div>
                              <div className="text-emerald-500/70 text-[9px]">Auto-computed</div>
                            </div>
                          </div>
                        </li>
                      );
                    }
                    return (
                      <li key={step.id} className="rounded p-1.5 text-[10px] bg-gray-900/40 border border-dashed border-gray-700/50">
                        <div className="flex items-start gap-1.5">
                          <div className="w-3.5 h-3.5 flex-shrink-0" />
                          <div className="flex-1">
                            <div className="font-medium text-gray-500 italic">{idx + 1}. {step.label}</div>
                            <div className="text-gray-600 text-[9px]">Auto-computed</div>
                          </div>
                        </div>
                      </li>
                    );
                  }
                  return (
                    <li key={step.id}
                      className={`rounded p-1.5 text-[10px] cursor-pointer ${isActive ? 'bg-blue-900/40 border border-blue-700' : done ? 'bg-gray-800/60' : 'bg-gray-800/30'}`}
                      onClick={() => {
                        if (done) {
                          // Select the measurement and switch to Select tool
                          const m = measurements.find((mm) => mm.workflowStepId === step.id);
                          if (m) { setSelectedMeasurementId(m.id); setUserToolOverride('none'); setActiveTool('none'); }
                        } else {
                          setWorkflow((prev) => ({ ...prev, activeStepIndex: idx }));
                        }
                      }}
                    >
                      <div className="flex items-start gap-1.5">
                        {done ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
                        ) : (
                          <Circle className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${isActive ? 'text-blue-400' : 'text-gray-500'}`} />
                        )}
                        <div className="flex-1">
                          <div className={`font-medium ${done ? 'text-gray-400 line-through' : isActive ? 'text-blue-200' : 'text-gray-300'}`}>
                            {idx + 1}. {step.label}
                          </div>
                          {isActive && <div className="text-gray-300 mt-0.5 leading-snug">{step.instruction}</div>}
                          {done && (
                            <button className="text-[9px] text-blue-400 hover:text-blue-300 mt-0.5" onClick={(e) => { e.stopPropagation(); redrawStep(step.id); }}>
                              Redo
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {/* Result box */}
              {result && (
                <div className="rounded bg-emerald-900/30 border border-emerald-700 p-2 text-[10px] mb-2">
                  <div className="font-semibold text-emerald-300 whitespace-pre-line">{result.summary}</div>
                </div>
              )}

              <Button size="sm" variant="outline" className="w-full border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
                onClick={resetProtocol}
              >
                <RotateCcw className="w-3 h-3 mr-1" /> Reset measurements
              </Button>
              <Button size="sm" variant="ghost" className="mt-1 w-full border border-emerald-700 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200"
                onClick={exportHipCsv}
              >
                Export CSV
              </Button>
            </>
          )}
        </div>

        {/* ── All measurement values ────────────────────────────── */}
        {measurements.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Drawn measurements</div>
            <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
              {measurements.map((m) => {
                const is = m.imageScale;
                const sx = (is?.x ?? 1) * activePixelSpacing.x;
                const sy = (is?.y ?? 1) * activePixelSpacing.y;
                let val = '';
                if ((m.type === 'distance' || m.type === 'line') && m.points.length >= 2) {
                  const mm = Math.hypot((m.points[1].x - m.points[0].x) * sx, (m.points[1].y - m.points[0].y) * sy);
                  val = `${mm.toFixed(1)} mm`;
                } else if (m.type === 'point' && m.points.length >= 1) {
                  val = `(${m.points[0].x.toFixed(0)}, ${m.points[0].y.toFixed(0)})`;
                }
                return (
                  <div key={m.id} onClick={() => { setSelectedMeasurementId(m.id); }}
                    className={`rounded p-1.5 text-[10px] cursor-pointer transition-colors ${
                      selectedMeasurementId === m.id ? 'bg-blue-900/40 border border-blue-700' : 'bg-gray-800/30 hover:bg-gray-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-gray-300 truncate">{m.label || m.type}</span>
                      <button className="text-red-400 hover:text-red-300 text-[9px]" onClick={(e) => { e.stopPropagation(); handleMeasurementDelete(m.id); }}>×</button>
                    </div>
                    {val && <div className="text-emerald-300 font-mono mt-0.5">{val}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
