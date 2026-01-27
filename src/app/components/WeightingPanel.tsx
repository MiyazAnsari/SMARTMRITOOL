import { useEffect, useRef, useState } from 'react';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Separator } from './ui/separator';
import { WeightingType } from './MedicalImageViewer';
import { FileUpload } from './FileUpload';

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
  layoutPreference = 'auto',
  onLayoutPreferenceChange,
  onOverflowChange,
}: WeightingPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
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
    let overflowStableCount = 0;
    let underflowStableCount = 0;
    const HYSTERESIS_PX = 24; // px guard band around the threshold
    const REQUIRED_STABLE = 3; // require this many consecutive checks

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

      // Use the off-screen clone's scrollHeight to determine the intrinsic required height.
      // If the visible controls are hidden (we moved them to the bottom toolbar),
      // simulate the height the sidebar would need by adding the full weighting
      // controls' intrinsic height to the current sidebar height. If the controls
      // are already visible, the container's scrollHeight already includes them.
      const measureH = measure.scrollHeight || measure.getBoundingClientRect().height;
      const containerScrollH = el.scrollHeight || el.getBoundingClientRect().height;
      const controlsStyle = window.getComputedStyle(controls);
      const controlsVisible = controlsStyle.display !== 'none' && controlsStyle.visibility !== 'hidden' && controlsStyle.opacity !== '0';

      const requiredH = controlsVisible ? containerScrollH : (containerScrollH + measureH);

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
      const controlsOverflowingNow = controlsRect.bottom > (parentRect ? parentRect.bottom : viewportBottom);

      // Asymmetric hysteresis: when currently not overflowing, require a positive
      // margin before switching to overflowing. When currently overflowing, allow
      // a smaller negative margin before switching back.
      const thresholdPlus = available + HYSTERESIS_PX;
      const thresholdMinus = available - HYSTERESIS_PX;

      let candidateOverflow = controlsOverflowingNow || requiredH > thresholdPlus;
      // If already marked overflowing, be more tolerant to remain so until below thresholdMinus
      if (isOverflowing) {
        candidateOverflow = controlsOverflowingNow || requiredH > thresholdMinus;
      }

      // Update stability counters
      if (candidateOverflow) {
        overflowStableCount += 1;
        underflowStableCount = 0;
      } else {
        underflowStableCount += 1;
        overflowStableCount = 0;
      }

      let overflowing = isOverflowing;
      if (!isOverflowing && overflowStableCount >= REQUIRED_STABLE) {
        overflowing = true;
        overflowStableCount = 0;
      } else if (isOverflowing && underflowStableCount >= REQUIRED_STABLE) {
        overflowing = false;
        underflowStableCount = 0;
      }

      console.debug('WeightingPanel.check sizes', {
        simulatedMeasureH: measureH,
        containerScrollH,
        requiredH,
        containerClientH: el.clientHeight,
        available,
        thresholdPlus,
        thresholdMinus,
        containerRect,
        parentRect,
        measureRect: measure.getBoundingClientRect(),
        controlsRect,
        controlsVisible,
        controlsOverflowingNow,
        candidateOverflow,
        overflowStableCount,
        underflowStableCount,
        decidedOverflow: overflowing,
      });

      // Commit state change immediately when stability condition met
      if (overflowing !== isOverflowing) {
        console.debug('WeightingPanel overflow toggled:', overflowing);
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
  }, [onOverflowChange, isOverflowing, weighting, customWeighting.psi]);
  const togglePlane = (p: 'axial' | 'sagittal' | 'coronal') => {
    if (selectedPlanes.includes(p)) {
      onPlanesChange(selectedPlanes.filter(x => x !== p));
    } else {
      onPlanesChange([...selectedPlanes, p]);
    }
  };

  const isPlaneSelected = (p: 'axial' | 'sagittal' | 'coronal') => selectedPlanes.includes(p);

  return (
    <div ref={containerRef} className="bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">SMART MRI Tissue Weighting Tool</h2>
        </div>
        <div className="ml-2">
          {onFileLoad && <FileUpload onFileLoad={onFileLoad} />}
        </div>
      </div>

      <div className="w-full">
        <p className="text-xs text-gray-400 mb-4">multi-contrast image generation from single MRI sequence</p>
      </div>

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

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Open Planes</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => togglePlane('axial')} className={`px-3 py-1 rounded ${isPlaneSelected('axial') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Axial</button>
          <button onClick={() => togglePlane('sagittal')} className={`px-3 py-1 rounded ${isPlaneSelected('sagittal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Sagittal</button>
          <button onClick={() => togglePlane('coronal')} className={`px-3 py-1 rounded ${isPlaneSelected('coronal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Coronal</button>
        </div>
      </div>

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Window Placement</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => onLayoutPreferenceChange?.('auto')} className={`px-2 py-1 rounded ${layoutPreference === 'auto' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Auto</button>
          <button type="button" onClick={() => onLayoutPreferenceChange?.('row')} className={`px-2 py-1 rounded ${layoutPreference === 'row' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Row</button>
          <button type="button" onClick={() => onLayoutPreferenceChange?.('column')} className={`px-2 py-1 rounded ${layoutPreference === 'column' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Column</button>
          <button type="button" onClick={() => onLayoutPreferenceChange?.('grid')} className={`px-2 py-1 rounded ${layoutPreference === 'grid' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Grid</button>
        </div>
      </div>

      <div className="space-y-4">
        <div ref={controlsRef} style={{ display: isOverflowing ? 'none' : undefined }}>
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
        {/* Off-screen clone used for accurate measurement when controls are hidden */}
        <div ref={measureRef} style={{ position: 'absolute', left: -9999, top: -9999, visibility: 'hidden', pointerEvents: 'none', width: '200px' }} aria-hidden>
          <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
            <RadioGroup value={weighting} onValueChange={() => {}}>
              <div className="flex flex-wrap gap-3">
                <div className="flex items-center space-x-2"><RadioGroupItem value="T1" /><Label className="text-sm text-gray-300">T1-Weighted</Label></div>
                <div className="flex items-center space-x-2"><RadioGroupItem value="T2" /><Label className="text-sm text-gray-300">T2-Weighted</Label></div>
                <div className="flex items-center space-x-2"><RadioGroupItem value="PD" /><Label className="text-sm text-gray-300">Proton Density (PD)</Label></div>
                <div className="flex items-center space-x-2"><RadioGroupItem value="CT" /><Label className="text-sm text-gray-300">Hard Tissue (CT)</Label></div>
                <div className="flex items-center space-x-2"><RadioGroupItem value="Custom" /><Label className="text-sm text-gray-300">Custom Weighting</Label></div>
              </div>
            </RadioGroup>
            {weighting === 'Custom' && (
              <div style={{ marginTop: 8 }}>
                <div className="flex justify-between mb-2"><Label className="text-xs text-gray-400">Tissue weight ψ</Label><span className="text-xs text-gray-300">{customWeighting.psi}°</span></div>
                <Slider value={[customWeighting.psi]} onValueChange={() => {}} min={0} max={180} step={1} className="w-full" />
              </div>
            )}
          </div>
        </div>

        {weighting === 'Custom' && !isOverflowing && (
          <>
            <Separator className="bg-gray-800" />

            <div>
              <div className="flex justify-between mb-2">
                <Label className="text-xs text-gray-400">Tissue weight ψ</Label>
                <span className="text-xs text-gray-300">{customWeighting.psi}°</span>
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
              <p>Custom weighting based on tissue weight ψ</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
