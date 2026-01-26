import { Label } from '@/app/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/radio-group';
import { Slider } from '@/app/components/ui/slider';
import { Separator } from '@/app/components/ui/separator';
import { WeightingType } from './MedicalImageViewer';

interface WeightingPanelProps {
  weighting: WeightingType;
  onWeightingChange: (weighting: WeightingType) => void;
  customWeighting: { te: number; tr: number; ti: number };
  onCustomWeightingChange: (params: { te: number; tr: number; ti: number }) => void;
}

export function WeightingPanel({ 
  weighting, 
  onWeightingChange, 
  customWeighting, 
  onCustomWeightingChange 
}: WeightingPanelProps) {
  return (
    <div className="w-72 bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto">
      <h2 className="text-sm font-semibold text-gray-300 mb-4">Image Weighting</h2>
      
      <div className="space-y-4">
        <div className="bg-gray-800 p-3 rounded-lg border border-gray-700">
          <p className="text-xs text-gray-400 mb-3">
            DREAMER Algorithm: Multi-contrast synthesis from single acquisition
          </p>
          
          <RadioGroup value={weighting} onValueChange={(v) => onWeightingChange(v as WeightingType)}>
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="T1" id="t1" className="border-gray-600" />
                <Label htmlFor="t1" className="text-sm text-gray-300 cursor-pointer">
                  T1-Weighted
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="T2" id="t2" className="border-gray-600" />
                <Label htmlFor="t2" className="text-sm text-gray-300 cursor-pointer">
                  T2-Weighted
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="PD" id="pd" className="border-gray-600" />
                <Label htmlFor="pd" className="text-sm text-gray-300 cursor-pointer">
                  Proton Density (PD)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="CT" id="ct" className="border-gray-600" />
                <Label htmlFor="ct" className="text-sm text-gray-300 cursor-pointer">
                  Hard Tissue (CT)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="Custom" id="custom" className="border-gray-600" />
                <Label htmlFor="custom" className="text-sm text-gray-300 cursor-pointer">
                  Custom Parameters
                </Label>
              </div>
            </div>
          </RadioGroup>
        </div>

        {weighting === 'Custom' && (
          <>
            <Separator className="bg-gray-800" />
            
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <Label className="text-xs text-gray-400">Echo Time (TE)</Label>
                  <span className="text-xs text-gray-300">{customWeighting.te} ms</span>
                </div>
                <Slider
                  value={[customWeighting.te]}
                  onValueChange={([te]) => onCustomWeightingChange({ ...customWeighting, te })}
                  min={0}
                  max={200}
                  step={1}
                  className="w-full"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <Label className="text-xs text-gray-400">Repetition Time (TR)</Label>
                  <span className="text-xs text-gray-300">{customWeighting.tr} ms</span>
                </div>
                <Slider
                  value={[customWeighting.tr]}
                  onValueChange={([tr]) => onCustomWeightingChange({ ...customWeighting, tr })}
                  min={0}
                  max={5000}
                  step={10}
                  className="w-full"
                />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <Label className="text-xs text-gray-400">Inversion Time (TI)</Label>
                  <span className="text-xs text-gray-300">{customWeighting.ti} ms</span>
                </div>
                <Slider
                  value={[customWeighting.ti]}
                  onValueChange={([ti]) => onCustomWeightingChange({ ...customWeighting, ti })}
                  min={0}
                  max={3000}
                  step={10}
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
              <p>Custom contrast based on MR parameters</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
