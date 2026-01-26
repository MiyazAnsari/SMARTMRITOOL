import { Label } from '@/app/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/radio-group';
import { Slider } from '@/app/components/ui/slider';
import { Separator } from '@/app/components/ui/separator';
import { WeightingType } from './MedicalImageViewer';

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
}: WeightingPanelProps) {
  const togglePlane = (p: 'axial' | 'sagittal' | 'coronal') => {
    if (selectedPlanes.includes(p)) {
      onPlanesChange(selectedPlanes.filter(x => x !== p));
    } else {
      onPlanesChange([...selectedPlanes, p]);
    }
  };

  const isPlaneSelected = (p: 'axial' | 'sagittal' | 'coronal') => selectedPlanes.includes(p);

  return (
    <div className="bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto">
      <h2 className="text-sm font-semibold text-gray-300 mb-2">SMART MRI Tissue Weighting Tool</h2>
      <p className="text-xs text-gray-400 mb-4">multi-contrast image generation from single MRI sequence</p>

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
        <div className="flex space-x-2">
          <button onClick={() => togglePlane('axial')} className={`px-3 py-1 rounded ${isPlaneSelected('axial') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Axial</button>
          <button onClick={() => togglePlane('sagittal')} className={`px-3 py-1 rounded ${isPlaneSelected('sagittal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Sagittal</button>
          <button onClick={() => togglePlane('coronal')} className={`px-3 py-1 rounded ${isPlaneSelected('coronal') ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}>Coronal</button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">

          
          <RadioGroup value={weighting} onValueChange={(v) => onWeightingChange(v as WeightingType)}>
            <div className="space-y-3">
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

        {weighting === 'Custom' && (
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
