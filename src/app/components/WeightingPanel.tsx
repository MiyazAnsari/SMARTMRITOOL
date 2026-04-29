import { useEffect, useRef, useState } from 'react';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Separator } from './ui/separator';
import { WeightingType } from './MedicalImageViewer';
import { StudyUpload } from './dicom/StudyUpload';
import type { DicomStudy } from './dicom/DicomStudy';
import type { Plane } from './dicom/DicomLoader';
import {
  MeasurementWorkflow,
  WorkflowState,
} from './measurement/MeasurementWorkflow';

interface WeightingPanelProps {
  weighting: WeightingType;
  onWeightingChange: (weighting: WeightingType) => void;
  customWeighting: { psi: number };
  onCustomWeightingChange: (params: { psi: number }) => void;
  /** Contrast mode: 'disk' (pregenerated) or 'gpu' (real-time) */
  contrastMode: 'disk' | 'gpu';
  onContrastModeChange: (mode: 'disk' | 'gpu') => void;
  /** Selected planes (multi-select) */
  selectedPlanes: Array<'axial' | 'sagittal' | 'coronal'>;
  onPlanesChange: (planes: Array<'axial' | 'sagittal' | 'coronal'>) => void;
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  onStudyLoad?: (study: DicomStudy) => void;
  studyData?: DicomStudy | null;
  activeStudyPlane?: Plane;
  workflow: WorkflowState;
  onWorkflowChange: (s: WorkflowState) => void;
  pixelSpacing: { x: number; y: number };
  onPlaneRequest?: (plane: Plane) => void;
  layoutPreference?: 'auto' | 'row' | 'column' | 'grid';
  onLayoutPreferenceChange?: (p: 'auto' | 'row' | 'column' | 'grid') => void;
  onOverflowChange?: (overflowing: boolean) => void;
}

export function WeightingPanel({ 
  weighting, 
  onWeightingChange, 
  customWeighting, 
  onCustomWeightingChange,
  contrastMode,
  onContrastModeChange,
  selectedPlanes,
  onPlanesChange,
  onFileLoad,
  onStudyLoad,
  studyData,
  activeStudyPlane,
  workflow,
  onWorkflowChange,
  pixelSpacing,
  onPlaneRequest,
  layoutPreference = 'auto',
  onLayoutPreferenceChange,
  onOverflowChange,
}: WeightingPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const openPlanesRef = useRef<HTMLDivElement | null>(null);
  const placementRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const prevOverflowRef = useRef<boolean>(false);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let rafId: number | null = null;
    let retryTimer: number | null = null;
    let changeTimer: number | null = null;
    let stableTimer: number | null = null;
    let lastResizeAt = 0;

    // hysteresis and stability to avoid rapid flips at the boundary
    // use refs (here simple objects) so counters persist across effect runs
    const overflowStableRef = { current: 0 } as { current: number };
    const underflowStableRef = { current: 0 } as { current: number };
    const HYSTERESIS_PX = 36; // larger guard band to reduce flips
    const REQUIRED_STABLE = 4; // require more consecutive checks for stability
    const STABLE_DELAY = 300; // ms to wait after resize stops before committing

    const check = () => {
      const el = containerRef.current;
      const controls = controlsRef.current;
      const measure = measureRef.current;
      // Log refs availability for debugging
      console.debug('WeightingPanel.check refs', { hasContainer: !!el, hasControls: !!controls, hasMeasure: !!measure });
      if (!el || !controls || !measure) return false;
      const containerRect = el.getBoundingClientRect();

      // Ensure the hidden measurement clone matches the panel width for accurate height calculation
      try {
        const w = Math.max(0, Math.floor(containerRect.width - 16));
        measure.style.width = `${w}px`;
      } catch (e) {
        // ignore
      }

      // Use the off-screen clone's scrollHeight to determine the intrinsic
      // height of the sections we may move (Open Planes + Window Placement).
      // We want to decide whether to move those sections out of the sidebar
      // into the bottom toolbar. When computing the thresholds we compare the
      // full container height (when kept) against the available height, and
      // we also compute the height if those sections were moved.
      const movedSectionsH_offscreen = measure.scrollHeight || measure.getBoundingClientRect().height;
      const containerScrollH = el.scrollHeight || el.getBoundingClientRect().height;

      // If the movable sections are currently present in the DOM, measure
      // their actual combined height (openPlanes + placement). Use the larger
      // of the measured-offscreen height and the live DOM height as a
      // conservative estimate for how much space they'd consume when kept
      // in the sidebar.
      // Prefer live DOM measurement when sections exist; otherwise fall back
      // to the off-screen template sections inside `measureRef` for a reliable
      // estimate that matches styling.
      let openH = 0;
      let placeH = 0;
      if (openPlanesRef.current) {
        openH = openPlanesRef.current.scrollHeight || openPlanesRef.current.getBoundingClientRect().height;
      } else if (measure) {
        const node = measure.querySelector('[data-section="openPlanes"]') as HTMLElement | null;
        openH = node ? (node.scrollHeight || node.getBoundingClientRect().height) : 0;
      }
      if (placementRef.current) {
        placeH = placementRef.current.scrollHeight || placementRef.current.getBoundingClientRect().height;
      } else if (measure) {
        const node = measure.querySelector('[data-section="placement"]') as HTMLElement | null;
        placeH = node ? (node.scrollHeight || node.getBoundingClientRect().height) : 0;
      }
      const movedSectionsH_live = Math.max(0, openH + placeH);
      const movedSectionsH = Math.max(movedSectionsH_offscreen, movedSectionsH_live);

      // Determine whether the movable sections are currently visible (not moved)
      const openVisible = openPlanesRef.current ? window.getComputedStyle(openPlanesRef.current).display !== 'none' : false;
      const placeVisible = placementRef.current ? window.getComputedStyle(placementRef.current).display !== 'none' : false;
      const movableVisible = openVisible || placeVisible;

      // Robust measurement strategy:
      // - Prefer live measurements for the movable sections (including margins)
      // - Fall back to the off-screen template's scrollHeight as a conservative
      //   upper-bound if live nodes aren't present
      const measureWithMargins = (node: HTMLElement | null) => {
        if (!node) return 0;
        try {
          const rectH = node.getBoundingClientRect().height || 0;
          const style = window.getComputedStyle(node);
          const mt = parseFloat(style.marginTop || '0') || 0;
          const mb = parseFloat(style.marginBottom || '0') || 0;
          return Math.ceil(rectH + mt + mb);
        } catch (e) {
          return Math.ceil(node.getBoundingClientRect().height || 0);
        }
      };

      const openLiveH = openPlanesRef.current ? measureWithMargins(openPlanesRef.current) : 0;
      const placeLiveH = placementRef.current ? measureWithMargins(placementRef.current) : 0;
      const movedSectionsH_live_measure = Math.max(0, openLiveH + placeLiveH);

      // offscreen template conservative estimate (includes spacing in template)
      const movedSectionsH_offscreen_measure = measure ? (measure.scrollHeight || measure.getBoundingClientRect().height) : 0;
      const movedSectionsH_final = Math.max(movedSectionsH_offscreen_measure, movedSectionsH_live_measure, movedSectionsH);

      const baseContainerH = containerScrollH;
      let requiredIfKeptCalc: number;
      let requiredIfMovedCalc: number;
      if (movableVisible) {
        // currently kept in sidebar
        requiredIfKeptCalc = baseContainerH;
        requiredIfMovedCalc = Math.max(0, baseContainerH - movedSectionsH_final);
      } else {
        // currently moved out; simulate adding them back
        requiredIfKeptCalc = baseContainerH + movedSectionsH_final;
        requiredIfMovedCalc = baseContainerH;
      }

      // Suspend toggles while recent resize activity is ongoing. Use the
      // `lastResizeAt` timestamp updated by the ResizeObserver; this is more
      // reliable than inspecting `document.body.style.cursor` across envs.
      const now = Date.now();
      const isResizingActive = lastResizeAt && (now - lastResizeAt) < STABLE_DELAY;
      if (isResizingActive) {
        overflowStableRef.current = 0;
        underflowStableRef.current = 0;
        return false;
      }

      // finally assign into variables used below
      var requiredIfKept = requiredIfKeptCalc;
      var requiredIfMoved = requiredIfMovedCalc;

      // Simplified, reliable overflow check:
      // - use parent element as viewport when available
      // - compare intrinsic required height against parent's available height
      // - also treat controls currently extending below the parent's bottom as overflow
      const parentRect = el.parentElement?.getBoundingClientRect();
      const viewportTop = parentRect ? parentRect.top : 0;
      const viewportBottom = parentRect ? parentRect.top + parentRect.height : window.innerHeight || document.documentElement.clientHeight;
      const margin = 12;

      const controlsRect = controls.getBoundingClientRect();
      const available = (parentRect ? parentRect.height : window.innerHeight) - margin;

      // Candidate logic:
      // - when NOT currently overflowing: switch to overflow only if the
      //   full (kept) height exceeds available by HYSTERESIS_PX.
      // - when currently overflowing: switch back only if the reduced height
      //   (after moving sections) fits within available minus HYSTERESIS_PX.
      const thresholdEnter = available + HYSTERESIS_PX; // need this much extra to enter overflow
      const thresholdExit = available - HYSTERESIS_PX; // must shrink below this to exit

      const wouldOverflowIfKept = requiredIfKept > available;
      const wouldOverflowIfMoved = requiredIfMoved > available;

      // Determine candidate state using asymmetric hysteresis
      const prevOverflow = prevOverflowRef.current;
      let candidateOverflow = prevOverflow ? true : false;
      if (!prevOverflow) {
        // enter overflow when the kept form doesn't fit the available height
        // or when the controls currently extend below the parent's bottom.
        const controlsOverflowing = parentRect ? (controlsRect.bottom > parentRect.bottom) : (controlsRect.bottom > viewportBottom);
        candidateOverflow = requiredIfKept > available || controlsOverflowing;
      } else {
        // only exit overflow if the moved form clearly fits within available - hysteresis
        candidateOverflow = !(requiredIfMoved <= thresholdExit);
      }

      // Update stability counters stored in refs so they survive effect re-inits
      if (candidateOverflow) {
        overflowStableRef.current += 1;
        underflowStableRef.current = 0;
      } else {
        underflowStableRef.current += 1;
        overflowStableRef.current = 0;
      }

      let overflowing = prevOverflow;
      if (!prevOverflow && overflowStableRef.current >= REQUIRED_STABLE) {
        overflowing = true;
        overflowStableRef.current = 0;
      } else if (prevOverflow && underflowStableRef.current >= REQUIRED_STABLE) {
        overflowing = false;
        underflowStableRef.current = 0;
      }

      console.debug('WeightingPanel.check sizes', {
        movedSectionsH,
        movedSectionsH_offscreen,
        movedSectionsH_live,
        containerScrollH,
        requiredIfKept,
        requiredIfMoved,
        containerClientH: el.clientHeight,
        available,
        thresholdEnter,
        thresholdExit,
        containerRect,
        parentRect,
        measureRect: measure.getBoundingClientRect(),
        controlsRect,
        candidateOverflow,
        overflowStable: overflowStableRef.current,
        underflowStable: underflowStableRef.current,
        decidedOverflow: overflowing,
      });

      // Commit state change immediately when stability condition met
      const prev = prevOverflowRef.current;
      if (overflowing !== prev) {
        console.debug('WeightingPanel overflow toggled:', overflowing);
        prevOverflowRef.current = overflowing;
        setIsOverflowing(overflowing);
        onOverflowChange?.(overflowing);
      }
      return true;
    };

    // Try to initialize observers; if refs not ready, retry a few times
    let attempts = 0;
    const tryInit = () => {
      attempts += 1;
      const el = containerRef.current;
      const controls = controlsRef.current;
      const measure = measureRef.current;
      if (!el || !controls || !measure) {
        if (attempts < 20) {
          retryTimer = window.setTimeout(tryInit, 50);
        }
        return;
      }

      // initial check
      check();

      ro = new ResizeObserver(() => {
        // mark resize timestamp and debounce via rAF
        lastResizeAt = Date.now();
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => { rafId = null; check(); });
        // schedule a final stability check after resizing settles
        if (stableTimer != null) clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => {
          stableTimer = null;
          check();
        }, STABLE_DELAY);
      });
      ro.observe(el);
      ro.observe(controls);
      ro.observe(measure);

      window.addEventListener('resize', check);
      window.addEventListener('orientationchange', check);
      // monitor scroll inside the right panel to detect visibility changes
      el.addEventListener('scroll', check, { passive: true });
    };

    tryInit();

    return () => {
      if (ro) ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
      if (retryTimer != null) clearTimeout(retryTimer);
      if (changeTimer != null) clearTimeout(changeTimer);
      if (stableTimer != null) clearTimeout(stableTimer);
      const el = containerRef.current;
      if (el) el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, [onOverflowChange, weighting, customWeighting.psi]);
  const togglePlane = (p: 'axial' | 'sagittal' | 'coronal') => {
    if (selectedPlanes.includes(p)) {
      onPlanesChange(selectedPlanes.filter(x => x !== p));
    } else {
      onPlanesChange([...selectedPlanes, p]);
    }
  };

  const isPlaneSelected = (p: 'axial' | 'sagittal' | 'coronal') => selectedPlanes.includes(p);

  return (
    <div ref={containerRef} className="bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto h-full">
      <div className="mb-4">
        <h2 className="text-sm font-bold text-blue-300 mb-3">SMART MRI Tissue Weighting Tool</h2>
        {(onFileLoad || onStudyLoad) && (
          <StudyUpload
            onNiftiLoad={(buf, name) => onFileLoad?.(buf, name)}
            onStudyLoad={(study) => onStudyLoad?.(study)}
          />
        )}
        {studyData && (
          <div className="mt-2 text-[10px] text-gray-400">
            Loaded study: <span className="text-gray-200">{studyData.studyName}</span>
            <div className="mt-0.5">
              Series:{' '}
              {(['axial', 'sagittal', 'coronal'] as Plane[])
                .filter((p) => studyData.volumes[p])
                .map((p) => (
                  <span
                    key={p}
                    className={`inline-block mr-1 px-1.5 py-0.5 rounded ${
                      activeStudyPlane === p ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'
                    }`}
                  >
                    {p}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>

      <MeasurementWorkflow
        state={workflow}
        onStateChange={onWorkflowChange}
        pixelSpacing={pixelSpacing}
        onPlaneRequest={onPlaneRequest}
      />

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Processing Mode</h3>
        <RadioGroup value={contrastMode} onValueChange={(v) => onContrastModeChange(v as 'disk' | 'gpu')}>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="disk" id="disk" className="border-gray-600" />
              <Label htmlFor="disk" className="text-sm text-gray-300 cursor-pointer">Pregenerated contrast mode (Disk)</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="gpu" id="gpu" className="border-gray-600" />
              <Label htmlFor="gpu" className="text-sm text-gray-300 cursor-pointer">Real time contrast mode (GPU)</Label>
            </div>
          </div>
        </RadioGroup>
      </div>

      {!isOverflowing && (
        <div className="mb-4" ref={openPlanesRef}>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Open Planes</h3>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => togglePlane('axial')} className={`px-3 py-1 rounded ${isPlaneSelected('axial') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Axial</button>
            <button onClick={() => togglePlane('sagittal')} className={`px-3 py-1 rounded ${isPlaneSelected('sagittal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Sagittal</button>
            <button onClick={() => togglePlane('coronal')} className={`px-3 py-1 rounded ${isPlaneSelected('coronal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Coronal</button>
          </div>
        </div>
      )}

      {!isOverflowing && (
        <div className="mb-4" ref={placementRef}>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Window Placement</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onLayoutPreferenceChange?.('auto')} className={`px-2 py-1 rounded ${layoutPreference === 'auto' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Auto</button>
            <button type="button" onClick={() => onLayoutPreferenceChange?.('row')} className={`px-2 py-1 rounded ${layoutPreference === 'row' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Row</button>
            <button type="button" onClick={() => onLayoutPreferenceChange?.('column')} className={`px-2 py-1 rounded ${layoutPreference === 'column' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Column</button>
            <button type="button" onClick={() => onLayoutPreferenceChange?.('grid')} className={`px-2 py-1 rounded ${layoutPreference === 'grid' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Grid</button>
          </div>
        </div>
      )}

      <div className="space-y-4">
      <div ref={controlsRef}>
          <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
            <RadioGroup value={weighting} onValueChange={(v) => onWeightingChange(v as WeightingType)}>
              <div className="flex flex-wrap gap-3">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="T1" id="t1" className="border-gray-600" />
                  <Label htmlFor="t1" className="text-sm text-gray-300 cursor-pointer">T1-Weighted</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="T2" id="t2" className="border-gray-600" />
                  <Label htmlFor="t2" className="text-sm text-gray-300 cursor-pointer">T2-Weighted</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="PD" id="pd" className="border-gray-600" />
                  <Label htmlFor="pd" className="text-sm text-gray-300 cursor-pointer">Proton Density (PD)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="CT" id="ct" className="border-gray-600" />
                  <Label htmlFor="ct" className="text-sm text-gray-300 cursor-pointer">Hard Tissue (CT)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="Custom" id="custom" className="border-gray-600" />
                  <Label htmlFor="custom" className="text-sm text-gray-300 cursor-pointer">Custom Weighting</Label>
                </div>
              </div>
            </RadioGroup>
          </div>
        </div>
        {/* Off-screen clone used for accurate measurement of the sections we may move (Open Planes + Window Placement) */}
        <div ref={measureRef} style={{ position: 'absolute', left: -9999, top: -9999, visibility: 'hidden', pointerEvents: 'none', width: '200px' }} aria-hidden>
          <div data-section="openPlanes" className="bg-gray-800 p-3 rounded-lg border border-gray-700">
            <div className="flex flex-wrap gap-2">
              <div className="px-3 py-1 rounded bg-gray-800 text-gray-300">Axial</div>
              <div className="px-3 py-1 rounded bg-gray-800 text-gray-300">Sagittal</div>
              <div className="px-3 py-1 rounded bg-gray-800 text-gray-300">Coronal</div>
            </div>
          </div>
          <div style={{ height: 8 }} />
          <div data-section="placement" className="bg-gray-800 p-3 rounded-lg border border-gray-700">
            <div className="flex flex-wrap gap-2">
              <div className="px-2 py-1 rounded bg-gray-800 text-gray-300">Auto</div>
              <div className="px-2 py-1 rounded bg-gray-800 text-gray-300">Row</div>
              <div className="px-2 py-1 rounded bg-gray-800 text-gray-300">Column</div>
              <div className="px-2 py-1 rounded bg-gray-800 text-gray-300">Grid</div>
            </div>
          </div>
        </div>

        {weighting === 'Custom' && (
          <>
            <Separator className="bg-gray-800" />

            <div>
              <div className="flex justify-between mb-2">
                <Label className="text-xs text-gray-400">Phase Modulation ψ</Label>
                <span className="text-xs text-gray-300">180°</span>
              </div>
              <div className="relative">
                <div className="absolute inset-0 pointer-events-none flex items-center">
                  <div className="relative w-full">
                    <span
                      aria-hidden
                      className="absolute text-xs font-semibold text-blue-300 bg-gray-800 px-1 rounded pointer-events-none"
                      style={{ top:10, left: `calc(${(customWeighting.psi / 180) * 100}% - 14px)`, zIndex: 20 }}
                    >
                      {customWeighting.psi}°
                    </span>
                  </div>
                </div>
                <Slider
                  value={[customWeighting.psi]}
                  onValueChange={([psi]) => onCustomWeightingChange({ psi })}
                  min={0}
                  max={180}
                  step={1}
                  className="w-full"
                />
              </div>
            </div>
          </>
        )}

        <Separator className="bg-gray-800" />

        <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
          <h3 className="text-xs font-semibold text-gray-300 mb-2">Contrast Information</h3>
          <div className="text-xs text-gray-400 space-y-1">
            {weighting === 'T1' && (
              <>
                <p>• Fat: Bright</p>
                <p>• Water/CSF: Dark</p>
                <p>• Gray matter: Gray</p>
              </>
            )}
            {weighting === 'T2' && (
              <>
                <p>• Water/CSF: Bright</p>
                <p>• Fat: Intermediate</p>
                <p>• Gray matter: Bright</p>
              </>
            )}
            {weighting === 'PD' && (
              <>
                <p>• Fat: Bright</p>
                <p>• Water: Bright</p>
                <p>• Based on proton density</p>
              </>
            )}
            {weighting === 'CT' && (
              <>
                <p>• Bone: Bright (high HU)</p>
                <p>• Soft tissue: Gray</p>
                <p>• Air: Dark (low HU)</p>
              </>
            )}
            {weighting === 'Custom' && (
              <p>Custom weighting based on Phase Modulation ψ</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
